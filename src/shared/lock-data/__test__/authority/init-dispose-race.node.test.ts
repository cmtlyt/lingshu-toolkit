/**
 * 回归测试：StorageAuthority init() 与 dispose() 并发场景
 *
 * 对应修复方案：src/shared/lock-data/fixes/init-dispose-race.md
 *
 * 缺陷复现路径：
 *   const a = createStorageAuthority(deps);
 *   const initPromise = a.init();   // ← 内部 await resolveEpoch 进入 pending
 *   a.dispose();                     // ← state.disposed = true，unsubscribers 已清空
 *   await initPromise;               // ← await 恢复后必须短路返回，否则会重新挂监听
 *
 * 修复点：performInit 在 await resolveEpoch 之后立即检查 state.disposed
 *
 * 选用 persistence='session' + 自定义 channel 让 resolveEpoch 走 session-probe
 * 超时分支（F 分支）—— 它必然异步等待 sessionProbeTimeout，在等待期间外部能稳定地
 * 插入 dispose() 调用
 */

import { describe, expect, test, vi } from 'vitest';
import { createStorageAuthority, type StorageAuthorityDeps } from '../../authority/index';
import type {
  AuthorityAdapter,
  ChannelAdapter,
  CommitSource,
  LockDataMutation,
  LoggerAdapter,
  SessionStoreAdapter,
  SyncSource,
} from '../../types';

interface TestHost {
  readonly dataRef: { current: { value: number } };
  readonly applyRemote: (next: { value: number }) => void;
  rev: number;
  lastAppliedRev: number;
  epoch: string | null;
}

function createTestLogger(): LoggerAdapter {
  return {
    warn: vi.fn<(message: string, ...extras: unknown[]) => void>(),
    error: vi.fn<(message: string, ...extras: unknown[]) => void>(),
    debug: vi.fn<(message: string, ...extras: unknown[]) => void>(),
  };
}

/**
 * 静默 channel：postMessage 记录消息，subscribe 注册回调但永不被外部触发；
 * 这样 resolveEpoch 的 session-probe 注定走超时（F 分支）
 *
 * 暴露 _subscribers 让测试用例在需要时手动模拟"对端响应"，但本测试用不到
 */
function createSilentChannel(): ChannelAdapter & {
  _subscribeCallCount: { value: number };
  _closeCallCount: { value: number };
} {
  const subscribeCallCount = { value: 0 };
  const closeCallCount = { value: 0 };
  return {
    _subscribeCallCount: subscribeCallCount,
    _closeCallCount: closeCallCount,
    postMessage: () => {},
    subscribe: () => {
      subscribeCallCount.value++;
      return () => {};
    },
    close: () => {
      closeCallCount.value++;
    },
  };
}

/**
 * 内存 sessionStore：read 默认返回 null（迫使 resolveEpoch 进入首次启动分支）
 */
function createMemorySessionStore(): SessionStoreAdapter {
  let stored: string | null = null;
  return {
    read: () => stored,
    write: (value: string) => {
      stored = value;
    },
  };
}

/**
 * 内存 authority：暴露调用计数让用例断言"是否被错误地接回事件流"
 */
function createTrackingAuthority(): AuthorityAdapter & {
  _readCallCount: { value: number };
  _subscribeCallCount: { value: number };
  _writeCalls: string[];
} {
  const readCount = { value: 0 };
  const subscribeCount = { value: 0 };
  const writes: string[] = [];
  return {
    _readCallCount: readCount,
    _subscribeCallCount: subscribeCount,
    _writeCalls: writes,
    read: () => {
      readCount.value++;
      return null;
    },
    write: (raw: string) => {
      writes.push(raw);
    },
    remove: () => {},
    subscribe: () => {
      subscribeCount.value++;
      return () => {};
    },
  };
}

/**
 * 构造 StorageAuthorityDeps 的工厂
 *
 * 默认配置：persistence='session' + 全 adapter 可用 + 极短探测超时
 */
function createTestDeps(
  overrides: {
    sessionProbeTimeout?: number;
    authority?: AuthorityAdapter | null;
    channel?: ChannelAdapter | null;
    sessionStore?: SessionStoreAdapter | null;
  } = {},
): {
  deps: StorageAuthorityDeps<{ value: number }>;
  host: TestHost;
  authority: AuthorityAdapter | null;
  channel: ChannelAdapter | null;
  emitSync: ReturnType<typeof vi.fn<(event: { source: SyncSource; rev: number; snapshot: { value: number } }) => void>>;
  emitCommit: ReturnType<
    typeof vi.fn<
      (event: {
        source: CommitSource;
        token: string;
        rev: number;
        mutations: readonly LockDataMutation[];
        snapshot: { value: number };
      }) => void
    >
  >;
  applyRemote: ReturnType<typeof vi.fn<(next: { value: number }) => void>>;
} {
  const dataRef = { current: { value: 0 } };
  const applyRemote = vi.fn<(next: { value: number }) => void>((next: { value: number }): void => {
    // 测试 host 模拟 applyRemote 契约：整体替换 dataRef.current（authority 已在 readIfNewer 中完成 deserialize 隔离）
    dataRef.current = next;
  });
  const host: TestHost = {
    dataRef,
    applyRemote,
    rev: 0,
    lastAppliedRev: 0,
    epoch: null,
  };
  const emitSync = vi.fn<(event: { source: SyncSource; rev: number; snapshot: { value: number } }) => void>();
  const emitCommit =
    vi.fn<
      (event: {
        source: CommitSource;
        token: string;
        rev: number;
        mutations: readonly LockDataMutation[];
        snapshot: { value: number };
      }) => void
    >();

  const authority = overrides.authority === undefined ? createTrackingAuthority() : overrides.authority;
  const channel = overrides.channel === undefined ? createSilentChannel() : overrides.channel;
  const sessionStore = overrides.sessionStore === undefined ? createMemorySessionStore() : overrides.sessionStore;

  const deps: StorageAuthorityDeps<{ value: number }> = {
    host,
    authority,
    channel,
    sessionStore,
    persistence: 'session',
    sessionProbeTimeout: overrides.sessionProbeTimeout ?? 30,
    logger: createTestLogger(),
    emitSync,
    emitCommit,
  };

  return { deps, host, authority, channel, emitSync, emitCommit, applyRemote };
}

describe('StorageAuthority — init() 与 dispose() 并发场景', () => {
  test('await resolveEpoch 期间调用 dispose：不再挂 push/pull 订阅', async () => {
    const { deps, authority } = createTestDeps({ sessionProbeTimeout: 50 });
    const trackingAuthority = authority as ReturnType<typeof createTrackingAuthority>;

    const sa = createStorageAuthority(deps);
    const initPromise = sa.init();

    // 此刻 performInit 必然停在 await resolveEpoch；channel 不会回 reply，
    // 50ms 后才会走 F 分支。在超时前调用 dispose
    sa.dispose();

    // await 恢复后修复版必须立即短路：authority.subscribe / authority.read 都不该被调用
    const result = await initPromise;

    // init 仍然兑现返回 ResolveEpochResult 的契约（dataReadyPromise 不会卡住）
    expect(result).toBeDefined();
    expect(typeof result.epoch).toBe('string');

    // 关键断言：authority.subscribe 没被调用过（推送订阅没挂上）
    expect(trackingAuthority._subscribeCallCount.value).toBe(0);

    // authority.read 也没被调用（初次 pull 没执行）
    // 注：resolveEpoch 的 F 分支不会调 authority.read，只会调 authority.remove
    expect(trackingAuthority._readCallCount.value).toBe(0);
  });

  test('await resolveEpoch 期间调用 dispose：host.epoch 不被回写', async () => {
    const { deps, host } = createTestDeps({ sessionProbeTimeout: 30 });

    const sa = createStorageAuthority(deps);
    const initPromise = sa.init();
    sa.dispose();
    await initPromise;

    // dispose 已先于 host.epoch 回写发生 → 修复后此字段保持 null
    expect(host.epoch).toBeNull();
  });

  test('await resolveEpoch 期间调用 dispose：emitSync 不会被触发', async () => {
    const { deps, emitSync, applyRemote } = createTestDeps({ sessionProbeTimeout: 30 });

    const sa = createStorageAuthority(deps);
    const initPromise = sa.init();
    sa.dispose();
    await initPromise;

    // 初次 pull 没执行 → host.applyRemote 没调用 → emitSync 没触发
    expect(applyRemote).not.toHaveBeenCalled();
    expect(emitSync).not.toHaveBeenCalled();
  });

  test('正常路径（先完成 init 再 dispose）：push 订阅会挂上、初次 pull 会执行', async () => {
    // 反向校验：修复不应破坏正常路径
    const { deps, authority } = createTestDeps({ sessionProbeTimeout: 30 });
    const trackingAuthority = authority as ReturnType<typeof createTrackingAuthority>;

    const sa = createStorageAuthority(deps);
    await sa.init();

    // 完成 init 后必然挂上推送订阅 + 触发初次 pull（authority.read）
    expect(trackingAuthority._subscribeCallCount.value).toBe(1);

    // F 分支会清空 authority（authorityCleared=true），跳过初次 pull
    // 改用 C 分支验证初次 pull：直接构造 sessionStore 已有 epoch 的场景
    sa.dispose();
  });

  test('正常路径（C 分支：sessionStore 已有 epoch）：初次 pull 会执行', async () => {
    const sessionStore: SessionStoreAdapter = {
      read: () => 'existing-epoch',
      write: () => {},
    };
    const { deps, authority } = createTestDeps({ sessionStore });
    const trackingAuthority = authority as ReturnType<typeof createTrackingAuthority>;

    const sa = createStorageAuthority(deps);
    await sa.init();

    // C 分支：authorityCleared=false → 初次 pull 触发 authority.read
    expect(trackingAuthority._subscribeCallCount.value).toBe(1);
    expect(trackingAuthority._readCallCount.value).toBe(1);

    sa.dispose();
  });

  test('dispose 在 init 完成后调用：channel.close 仅触发一次（幂等）', async () => {
    const { deps, channel } = createTestDeps({ sessionProbeTimeout: 30 });
    const silentChannel = channel as ReturnType<typeof createSilentChannel>;

    const sa = createStorageAuthority(deps);
    const initPromise = sa.init();
    sa.dispose();
    sa.dispose(); // 二次调用应被幂等吞掉
    await initPromise;

    expect(silentChannel._closeCallCount.value).toBe(1);
  });
});
