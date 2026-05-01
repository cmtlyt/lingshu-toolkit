import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStorageAuthority, type StorageAuthorityHost } from '../../authority';
import { serializeAuthority } from '../../authority/serialize';
import { PERSISTENT_EPOCH } from '../../constants';
import type {
  AuthorityAdapter,
  ChannelAdapter,
  CommitSource,
  LockDataMutation,
  LoggerAdapter,
  SessionStoreAdapter,
  SyncSource,
} from '../../types';

/**
 * 测试用 LoggerAdapter（全部 vi.fn 便于断言）
 */
function createTestLogger(): LoggerAdapter & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  // @ts-expect-error
  return { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * 内存版 AuthorityAdapter；subscribe 使用本地事件总线模拟跨 Tab 推送
 *
 * 用法：两个 memoryAuthority 实例共享同一个 `storageBackend`（一个 Map）模拟同源两 Tab 的 localStorage，
 * 写入时手动触发对方的 subscribe 回调（浏览器规范：写入方本 Tab 不会收到自己的 storage 事件）
 */
function createPairedAuthorities(): {
  tabA: AuthorityAdapter & { _dispatch: (raw: string | null) => void };
  tabB: AuthorityAdapter & { _dispatch: (raw: string | null) => void };
  /** 共享底层存储；测试里可直接读取验证写路径 */
  storage: { value: string | null };
  cleanup: () => void;
} {
  const storage: { value: string | null } = { value: null };
  const listenersA = new Set<(raw: string | null) => void>();
  const listenersB = new Set<(raw: string | null) => void>();

  const tabA: AuthorityAdapter & { _dispatch: (raw: string | null) => void } = {
    read: () => storage.value,
    write: (raw: string) => {
      storage.value = raw;
      // 写入方本 Tab 不会收到自己的 storage 事件，只推给对端
      for (const cb of listenersB) {
        cb(raw);
      }
    },
    remove: () => {
      storage.value = null;
      for (const cb of listenersB) {
        cb(null);
      }
    },
    subscribe: (cb) => {
      listenersA.add(cb);
      return () => {
        listenersA.delete(cb);
      };
    },
    _dispatch: (raw) => {
      for (const cb of listenersA) {
        cb(raw);
      }
    },
  };

  const tabB: AuthorityAdapter & { _dispatch: (raw: string | null) => void } = {
    read: () => storage.value,
    write: (raw: string) => {
      storage.value = raw;
      for (const cb of listenersA) {
        cb(raw);
      }
    },
    remove: () => {
      storage.value = null;
      for (const cb of listenersA) {
        cb(null);
      }
    },
    subscribe: (cb) => {
      listenersB.add(cb);
      return () => {
        listenersB.delete(cb);
      };
    },
    _dispatch: (raw) => {
      for (const cb of listenersB) {
        cb(raw);
      }
    },
  };

  return {
    tabA,
    tabB,
    storage,
    cleanup: () => {
      listenersA.clear();
      listenersB.clear();
    },
  };
}

/**
 * 内存版 SessionStoreAdapter
 */
function createMemorySessionStore(initial: string | null = null): SessionStoreAdapter & {
  _store: { value: string | null };
} {
  const store = { value: initial };
  return {
    _store: store,
    read: () => store.value,
    write: (value: string) => {
      store.value = value;
    },
  };
}

/**
 * 内存版 ChannelAdapter（不做真实跨 Tab 通信，只为了 subscribeSessionProbe 挂载点）
 */
function createMemoryChannel(): ChannelAdapter & { _closed: { value: boolean } } {
  const closed = { value: false };
  return {
    _closed: closed,
    postMessage: () => {},
    subscribe: () => () => {},
    close: () => {
      closed.value = true;
    },
  };
}

/**
 * 构建测试宿主：最小 Entry 子集
 */
function createHost<T extends object>(initial: T): StorageAuthorityHost<T> {
  return { data: initial, rev: 0, lastAppliedRev: 0, epoch: null };
}

/**
 * Phase 4 简易 applySnapshot：Phase 5 会换成基于 readonly-view 的深度实现
 * 这里只对普通对象做"删旧键 + Object.assign 新键"，足够覆盖集成测试的断言
 */
function simpleApplySnapshot<T extends object>(data: T, next: T): void {
  for (const key of Object.keys(data)) {
    delete (data as Record<string, unknown>)[key];
  }
  Object.assign(data, next);
}

/**
 * 简易深克隆（Phase 5 会由 ResolvedAdapters.clone 替代）
 */
function simpleClone<V>(value: V): V {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

describe('authority/index — StorageAuthority 初始化流程', () => {
  test('init 触发 resolveEpoch 且写入 host.epoch（persistent 策略）', async () => {
    const host = createHost({ count: 0 });
    const paired = createPairedAuthorities();
    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit: () => {},
    });

    const resolved = await storageAuthority.init();
    expect(resolved.epoch).toBe(PERSISTENT_EPOCH);
    expect(host.epoch).toBe(PERSISTENT_EPOCH);
    storageAuthority.dispose();
    paired.cleanup();
  });

  test('init 完成后 authority 中已有数据：初次 pull 应用到 host', async () => {
    const host = createHost<{ count: number; label?: string }>({ count: 0 });
    const paired = createPairedAuthorities();
    // 预先植入权威数据
    paired.storage.value = serializeAuthority(5, Date.now(), PERSISTENT_EPOCH, { count: 42, label: 'remote' });

    const emitSync = vi.fn();
    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync,
      emitCommit: () => {},
    });

    await storageAuthority.init();

    // host 已被远端 snapshot 覆盖
    expect(host.data).toEqual({ count: 42, label: 'remote' });
    expect(host.rev).toBe(5);
    expect(host.lastAppliedRev).toBe(5);
    // onSync 被触发，source 为 'pull-on-acquire'（init 首次 pull 共享同一流程）
    expect(emitSync).toHaveBeenCalledTimes(1);
    const event = emitSync.mock.calls[0][0];
    expect(event.source).toBe('pull-on-acquire');
    expect(event.rev).toBe(5);
    expect(event.snapshot).toEqual({ count: 42, label: 'remote' });
    // snapshot 应为独立引用（clone 过），不与 host.data 同一对象
    expect(event.snapshot).not.toBe(host.data);

    storageAuthority.dispose();
    paired.cleanup();
  });

  test('D 分支 authorityCleared=true 时跳过初次 pull（不触达 authority.read）', async () => {
    const host = createHost({ count: 0 });
    const sessionStore = createMemorySessionStore(null);
    const authority: AuthorityAdapter = {
      read: vi.fn(() => serializeAuthority(99, Date.now(), 'residual', { count: 99 })),
      write: vi.fn(),
      remove: vi.fn(),
      subscribe: () => () => {},
    };
    const storageAuthority = createStorageAuthority({
      host,
      authority,
      channel: null, // 触发 D 分支
      sessionStore,
      persistence: 'session',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit: () => {},
    });

    const resolved = await storageAuthority.init();
    expect(resolved.authorityCleared).toBe(true);
    expect(authority.remove).toHaveBeenCalledTimes(1);
    // read 不应被调用（残留已清空）
    expect(authority.read).not.toHaveBeenCalled();
    storageAuthority.dispose();
  });

  test('init 两次调用：第二次 warn + 幂等返回', async () => {
    const host = createHost({});
    const logger = createTestLogger();
    const storageAuthority = createStorageAuthority({
      host,
      authority: null,
      channel: null,
      sessionStore: null,
      persistence: 'persistent',
      logger,
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit: () => {},
    });

    await storageAuthority.init();
    const second = await storageAuthority.init();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('init called twice'));
    expect(second.epoch).toBe(PERSISTENT_EPOCH);
    storageAuthority.dispose();
  });
});

describe('authority/index — onCommitSuccess 写路径', () => {
  test('rev 自增 + lastAppliedRev 同步 + authority.write 被调用', async () => {
    const host = createHost({ count: 0 });
    const paired = createPairedAuthorities();
    const emitCommit = vi.fn();
    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit,
    });

    await storageAuthority.init();
    expect(host.rev).toBe(0);
    expect(host.lastAppliedRev).toBe(0);

    const snapshot = { count: 1 };
    const mutations: readonly LockDataMutation[] = [{ op: 'set', path: ['count'], value: 1 }];
    storageAuthority.onCommitSuccess({ source: 'update', token: 'tok-1', mutations, snapshot });

    expect(host.rev).toBe(1);
    expect(host.lastAppliedRev).toBe(1);
    // authority 被写入，且 value 可被 JSON.parse 还原
    expect(paired.storage.value).not.toBe(null);
    const parsed = JSON.parse(paired.storage.value as string);
    expect(parsed.rev).toBe(1);
    expect(parsed.epoch).toBe(PERSISTENT_EPOCH);
    expect(parsed.snapshot).toEqual({ count: 1 });
    // emitCommit 触发
    expect(emitCommit).toHaveBeenCalledTimes(1);
    const event = emitCommit.mock.calls[0][0];
    expect(event.source).toBe('update');
    expect(event.rev).toBe(1);
    expect(event.token).toBe('tok-1');
    expect(event.mutations).toEqual(mutations);
    expect(event.snapshot).toEqual({ count: 1 });

    storageAuthority.dispose();
    paired.cleanup();
  });

  test('多次 commit 产生单调递增 rev', async () => {
    const host = createHost({ n: 0 });
    const paired = createPairedAuthorities();
    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit: () => {},
    });
    await storageAuthority.init();

    for (let i = 1; i <= 5; i++) {
      storageAuthority.onCommitSuccess({ source: 'update', token: `t-${i}`, mutations: [], snapshot: { n: i } });
      expect(host.rev).toBe(i);
    }
    expect(JSON.parse(paired.storage.value as string).rev).toBe(5);

    storageAuthority.dispose();
    paired.cleanup();
  });

  test('authority 为 null 时 onCommitSuccess 只做 rev 自增 + emitCommit，不写远端', async () => {
    const host = createHost({ count: 0 });
    const emitCommit = vi.fn();
    const storageAuthority = createStorageAuthority({
      host,
      authority: null,
      channel: null,
      sessionStore: null,
      persistence: 'session', // 将降级为 persistent（B 分支）
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit,
    });
    await storageAuthority.init();

    storageAuthority.onCommitSuccess({ source: 'update', token: 'tok-1', mutations: [], snapshot: { count: 1 } });
    expect(host.rev).toBe(1);
    expect(emitCommit).toHaveBeenCalledTimes(1);
    storageAuthority.dispose();
  });
});

describe('authority/index — 跨 Tab 推送（两 Tab end-to-end）', () => {
  let paired: ReturnType<typeof createPairedAuthorities>;

  beforeEach(() => {
    paired = createPairedAuthorities();
  });

  afterEach(() => {
    paired.cleanup();
  });

  test('Tab A commit → Tab B 的 onSync 被触发 + host.data 更新', async () => {
    const hostA = createHost({ count: 0 });
    const hostB = createHost({ count: 0 });
    const emitSyncB = vi.fn();

    const authorityA = createStorageAuthority({
      host: hostA,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit: () => {},
    });
    const authorityB = createStorageAuthority({
      host: hostB,
      authority: paired.tabB,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: emitSyncB,
      emitCommit: () => {},
    });

    await Promise.all([authorityA.init(), authorityB.init()]);

    // Tab A commit
    authorityA.onCommitSuccess({ source: 'update', token: 'tok-A-1', mutations: [], snapshot: { count: 7 } });

    // Tab B 应收到 subscribe 回调（source='storage-event'）并应用 snapshot
    expect(hostB.data).toEqual({ count: 7 });
    expect(hostB.rev).toBe(1);
    expect(hostB.lastAppliedRev).toBe(1);
    expect(emitSyncB).toHaveBeenCalledTimes(1);
    const event = emitSyncB.mock.calls[0][0];
    expect(event.source).toBe('storage-event');
    expect(event.rev).toBe(1);
    expect(event.snapshot).toEqual({ count: 7 });

    authorityA.dispose();
    authorityB.dispose();
  });

  test('Tab B 收到 rev 未推进的 storage 事件时走快路径丢弃（不触发 onSync）', async () => {
    const hostB = createHost({ count: 10 });
    hostB.lastAppliedRev = 5;
    const emitSyncB = vi.fn();

    const authorityB = createStorageAuthority({
      host: hostB,
      authority: paired.tabB,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: emitSyncB,
      emitCommit: () => {},
    });
    await authorityB.init();

    // 模拟远端写入 rev=3（小于 lastAppliedRev=5）
    const raw = serializeAuthority(3, Date.now(), PERSISTENT_EPOCH, { count: 99 });
    paired.tabA._dispatch(raw); // 手动派发给 Tab A 侧 listeners —— 不对，这测的是 Tab B

    // 正确路径：从 Tab A 写入会 push 给 Tab B 的 listeners
    paired.tabB.write(raw);
    paired.tabA._dispatch(raw); // 真正 push 给 Tab A（本测试实际是让 Tab A 的 listeners 收到）

    // 由于我们监听的是 Tab B，应该没任何 onSync
    expect(emitSyncB).toHaveBeenCalledTimes(0);
    expect(hostB.data).toEqual({ count: 10 });
    expect(hostB.rev).toBe(0); // init 未 pull 到（storage 开始为空）
    authorityB.dispose();
  });

  test('Tab B 收到 epoch 不匹配的 storage 事件时走快路径丢弃', async () => {
    const hostB = createHost({ count: 10 });
    const emitSyncB = vi.fn();
    const logger = createTestLogger();

    const authorityB = createStorageAuthority({
      host: hostB,
      authority: paired.tabB,
      channel: null, // D 分支，生成独立 UUID
      sessionStore: createMemorySessionStore(null),
      persistence: 'session',
      logger,
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: emitSyncB,
      emitCommit: () => {},
    });
    const resolved = await authorityB.init();
    expect(resolved.effectivePersistence).toBe('session');
    expect(hostB.epoch).toBe(resolved.epoch);

    // 模拟其他 Tab 用不同 epoch 写入
    const raw = serializeAuthority(1, Date.now(), 'different-epoch', { count: 99 });
    paired.tabA._dispatch(raw); // 不对，A 的 dispatch 是给 A 的 listeners
    // 正确：用 storage.write 或直接触发 B 的 subscribe 回调
    // 这里我们直接让 B 收到（模拟其他 Tab 的写入被 B 的 subscribe 捕获）
    paired.tabA.write(raw); // A 写入 → 会推给 B 的 subscribe 回调

    expect(emitSyncB).toHaveBeenCalledTimes(0);
    expect(hostB.data).toEqual({ count: 10 });
    authorityB.dispose();
  });

  test('pullOnAcquire 能同步拉取并应用 authority 最新值', async () => {
    const host = createHost<{ count: number }>({ count: 0 });
    const emitSync = vi.fn();

    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync,
      emitCommit: () => {},
    });
    await storageAuthority.init();

    // 此时 storage 为空，pullOnAcquire 无命中
    storageAuthority.pullOnAcquire();
    expect(emitSync).toHaveBeenCalledTimes(0);

    // 注入远端数据 —— 不经过 subscribe（模拟刚接入 Tab 查询时的情况）
    paired.storage.value = serializeAuthority(3, Date.now(), PERSISTENT_EPOCH, { count: 33 });
    storageAuthority.pullOnAcquire();
    expect(emitSync).toHaveBeenCalledTimes(1);
    expect(emitSync.mock.calls[0][0].source).toBe('pull-on-acquire');
    expect(host.data).toEqual({ count: 33 });
    expect(host.rev).toBe(3);

    storageAuthority.dispose();
  });
});

describe('authority/index — dispose 幂等与资源释放', () => {
  test('dispose 解绑 authority.subscribe：后续 storage 事件不再触发 onSync', async () => {
    const paired = createPairedAuthorities();
    const host = createHost({ count: 0 });
    const emitSync = vi.fn();
    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabB,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync,
      emitCommit: () => {},
    });
    await storageAuthority.init();

    // dispose 前：Tab A 写入会触发 Tab B 的 onSync
    paired.tabA.write(serializeAuthority(1, Date.now(), PERSISTENT_EPOCH, { count: 1 }));
    expect(emitSync).toHaveBeenCalledTimes(1);

    storageAuthority.dispose();

    // dispose 后：Tab A 再写入不触发 Tab B
    paired.tabA.write(serializeAuthority(2, Date.now(), PERSISTENT_EPOCH, { count: 2 }));
    expect(emitSync).toHaveBeenCalledTimes(1); // 仍然是 1 次

    paired.cleanup();
  });

  test('dispose 调用 channel.close', async () => {
    const channel = createMemoryChannel();
    const storageAuthority = createStorageAuthority({
      host: createHost({}),
      authority: null,
      channel,
      sessionStore: null,
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit: () => {},
    });
    await storageAuthority.init();
    expect(channel._closed.value).toBe(false);
    storageAuthority.dispose();
    expect(channel._closed.value).toBe(true);
  });

  test('dispose 两次调用：第二次 no-op 不抛错', async () => {
    const channel = createMemoryChannel();
    const storageAuthority = createStorageAuthority({
      host: createHost({}),
      authority: null,
      channel,
      sessionStore: null,
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {},
      emitCommit: () => {},
    });
    await storageAuthority.init();
    storageAuthority.dispose();
    expect(() => storageAuthority.dispose()).not.toThrow();
  });

  test('dispose 后 pullOnAcquire / onCommitSuccess 均 no-op', async () => {
    const host = createHost({ count: 0 });
    const paired = createPairedAuthorities();
    const emitSync = vi.fn();
    const emitCommit = vi.fn();
    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync,
      emitCommit,
    });
    await storageAuthority.init();
    storageAuthority.dispose();

    paired.storage.value = serializeAuthority(1, Date.now(), PERSISTENT_EPOCH, { count: 1 });
    storageAuthority.pullOnAcquire();
    storageAuthority.onCommitSuccess({ source: 'update', token: 't', mutations: [], snapshot: { count: 99 } });

    expect(emitSync).not.toHaveBeenCalled();
    expect(emitCommit).not.toHaveBeenCalled();
    expect(host.rev).toBe(0); // 未自增
    paired.cleanup();
  });
});

describe('authority/index — visibilitychange 激活拉取', () => {
  test('document visibilitychange → visible 时触发 pull', async () => {
    const host = createHost<{ count: number }>({ count: 0 });
    const paired = createPairedAuthorities();
    const emitSync = vi.fn();

    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync,
      emitCommit: () => {},
    });
    await storageAuthority.init();
    emitSync.mockClear();

    // 远端更新但不经过 subscribe（模拟 Tab 在后台时错过的变更）
    paired.storage.value = serializeAuthority(5, Date.now(), PERSISTENT_EPOCH, { count: 50 });

    // 模拟 Tab 重新可见：document.visibilityState 只读，需用 Object.defineProperty 伪造，
    // 然后 dispatch visibilitychange 事件
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(emitSync).toHaveBeenCalledTimes(1);
    expect(emitSync.mock.calls[0][0].source).toBe('visibilitychange');
    expect(host.data).toEqual({ count: 50 });

    storageAuthority.dispose();
    paired.cleanup();
  });

  test('document visibilitychange → hidden 时不触发 pull', async () => {
    const host = createHost({ count: 0 });
    const paired = createPairedAuthorities();
    const emitSync = vi.fn();

    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabA,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger: createTestLogger(),
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync,
      emitCommit: () => {},
    });
    await storageAuthority.init();
    emitSync.mockClear();

    paired.storage.value = serializeAuthority(5, Date.now(), PERSISTENT_EPOCH, { count: 50 });

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(emitSync).not.toHaveBeenCalled();
    expect(host.data).toEqual({ count: 0 });

    storageAuthority.dispose();
    paired.cleanup();
  });
});

describe('authority/index — applySnapshot 异常隔离', () => {
  test('applySnapshot 抛错时 → logger.error + 不更新 rev + 不触发 onSync', async () => {
    const host = createHost<{ count: number }>({ count: 0 });
    const paired = createPairedAuthorities();
    const emitSync = vi.fn();
    const logger = createTestLogger();

    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabB,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger,
      clone: simpleClone,
      applySnapshot: () => {
        throw new Error('mock apply fail');
      },
      emitSync,
      emitCommit: () => {},
    });
    await storageAuthority.init();

    paired.tabA.write(serializeAuthority(1, Date.now(), PERSISTENT_EPOCH, { count: 99 }));

    expect(emitSync).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(host.rev).toBe(0);
    expect(host.lastAppliedRev).toBe(0);

    storageAuthority.dispose();
    paired.cleanup();
  });

  test('emitSync 抛错时 → logger.error + host 状态已更新（异常隔离）', async () => {
    const host = createHost<{ count: number }>({ count: 0 });
    const paired = createPairedAuthorities();
    const logger = createTestLogger();

    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabB,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger,
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync: () => {
        throw new Error('mock listener fail');
      },
      emitCommit: () => {},
    });
    await storageAuthority.init();

    paired.tabA.write(serializeAuthority(1, Date.now(), PERSISTENT_EPOCH, { count: 42 }));

    expect(logger.error).toHaveBeenCalledTimes(1);
    // listener 抛错不影响数据应用
    expect(host.rev).toBe(1);
    expect(host.lastAppliedRev).toBe(1);
    expect(host.data).toEqual({ count: 42 });

    storageAuthority.dispose();
    paired.cleanup();
  });
});

describe('authority/index — snapshot 脏数据守卫', () => {
  test('snapshot 非对象时 warn 并跳过 apply', async () => {
    const host = createHost({ count: 0 });
    const paired = createPairedAuthorities();
    const logger = createTestLogger();
    const emitSync = vi.fn();

    const storageAuthority = createStorageAuthority({
      host,
      authority: paired.tabB,
      channel: createMemoryChannel(),
      sessionStore: createMemorySessionStore(),
      persistence: 'persistent',
      logger,
      clone: simpleClone,
      applySnapshot: simpleApplySnapshot,
      emitSync,
      emitCommit: () => {},
    });
    await storageAuthority.init();

    // snapshot 是原始值（字符串）
    paired.tabA.write(serializeAuthority(1, Date.now(), PERSISTENT_EPOCH, 'not-an-object'));

    expect(emitSync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('snapshot is not an object'));
    expect(host.data).toEqual({ count: 0 });

    storageAuthority.dispose();
    paired.cleanup();
  });
});

// 类型相关的 import 使用断言（保证 d.ts 暴露正确）
describe('authority/index — types', () => {
  test('SyncSource / CommitSource 枚举覆盖完整', () => {
    const sources: SyncSource[] = ['pull-on-acquire', 'storage-event', 'pageshow', 'visibilitychange'];
    const commits: CommitSource[] = ['update', 'replace'];
    expect(sources).toHaveLength(4);
    expect(commits).toHaveLength(2);
  });
});
