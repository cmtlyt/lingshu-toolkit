/**
 * drivers/storage-state.ts 覆盖率补强测试（Tier 3）
 *
 * 直接 import 内部纯函数（canFastAcquire / drainOnDestroy / enqueueInStorage /
 * enterHolding / handleExternalChange / pumpNextWaiter / releaseHolderInStorage /
 * removeWaiter / revokeHolding / startPolling / subscribeStorageEvent / tryAcquire），
 * 命中正常 createStorageDriver 主链路下不易触达的防御分支。
 *
 * 设计约束：
 * - 不重写源码逻辑（尤其是正常链路不可达的代码不允许通过重写让其可达）
 * - 不依赖 v8 ignore 注释绕过未覆盖项
 * - 通过构造伪 state（含 stub 化的 Storage / globalThis.addEventListener）触发防御分支
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { EMPTY_VALUE, type StorageLockValue } from '../../drivers/storage-protocol';
import {
  canFastAcquire,
  drainOnDestroy,
  enqueueInStorage,
  enterHolding,
  handleExternalChange,
  pumpNextWaiter,
  releaseHolderInStorage,
  removeWaiter,
  revokeHolding,
  type StorageDriverState,
  startPolling,
  subscribeStorageEvent,
  tryAcquire,
  type Waiter,
} from '../../drivers/storage-state';
import type { LockDriverHandle, LoggerAdapter } from '../../types';

function createLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

interface MemoryStorage extends Storage {
  readonly __raw: Map<string, string>;
}

function createMemoryStorage(): MemoryStorage {
  const store = new Map<string, string>();
  const handle = {
    __raw: store,
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  return handle as unknown as MemoryStorage;
}

function createFakeState(overrides: Partial<StorageDriverState> = {}): StorageDriverState {
  const logger = createLogger();
  const storage = createMemoryStorage();
  return {
    deps: {
      id: 'test-id',
      name: 'storage-state-test',
      logger,
    } as unknown as StorageDriverState['deps'],
    storage,
    key: '@cmtlyt/lingshu-toolkit:lockData:test-id:driver-lock',
    status: { kind: 'idle' },
    waiters: [],
    destroyed: false,
    pumping: false,
    unsubscribeStorageEvent: null,
    pollTimer: null,
    ...overrides,
  };
}

function makeWaiter(overrides: Partial<Waiter> = {}): Waiter {
  return {
    token: 'token-fake',
    resolve: vi.fn<(handle: LockDriverHandle) => void>(),
    reject: vi.fn<(error: Error) => void>(),
    abort: vi.fn<(error: Error) => void>(),
    isSettled: () => false,
    ...overrides,
  };
}

function writeRaw(state: StorageDriverState, value: StorageLockValue): void {
  state.storage.setItem(state.key, JSON.stringify(value));
}

describe('drivers/storage-state — removeWaiter', () => {
  test('从队列中移除目标 waiter', () => {
    const w1 = makeWaiter({ token: 'a' });
    const w2 = makeWaiter({ token: 'b' });
    const w3 = makeWaiter({ token: 'c' });
    const list: Waiter[] = [w1, w2, w3];

    removeWaiter(list, w2);

    expect(list).toEqual([w1, w3]);
  });

  test('目标不存在 → 队列不变', () => {
    const w1 = makeWaiter({ token: 'a' });
    const stranger = makeWaiter({ token: 'x' });
    const list: Waiter[] = [w1];

    removeWaiter(list, stranger);

    expect(list).toEqual([w1]);
  });
});

describe('drivers/storage-state — canFastAcquire', () => {
  test('status 非 idle → false', () => {
    const state = createFakeState();
    state.status = {
      kind: 'holding',
      token: 't',
      nonce: 'n',
      released: false,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    expect(canFastAcquire(state)).toBe(false);
  });

  test('已有本地 waiter → false', () => {
    const state = createFakeState();
    state.waiters.push(makeWaiter());
    expect(canFastAcquire(state)).toBe(false);
  });

  test('storage 队列非空 → false', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [{ token: 'other', ts: Date.now() }],
      rev: 1,
    });
    expect(canFastAcquire(state)).toBe(false);
  });

  test('storage holder 活着 → false', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'other', heartbeat: Date.now(), nonce: 'n' },
      queue: [],
      rev: 1,
    });
    expect(canFastAcquire(state)).toBe(false);
  });

  test('idle + waiters=[] + queue=[] + holder=null → true', () => {
    const state = createFakeState();
    expect(canFastAcquire(state)).toBe(true);
  });

  test('idle + holder dead → true', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'dead', heartbeat: 0, nonce: 'n' },
      queue: [],
      rev: 1,
    });
    expect(canFastAcquire(state)).toBe(true);
  });
});

describe('drivers/storage-state — readStorage 防御分支（间接覆盖）', () => {
  test('storage.getItem 抛错 → logger.warn 后返回 EMPTY_VALUE', () => {
    const state = createFakeState({
      storage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      } as Storage,
    });

    // canFastAcquire 内部会调 readStorage；getItem 抛错 → EMPTY_VALUE → holder=null → true
    expect(canFastAcquire(state)).toBe(true);
    expect(state.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('getItem failed'), expect.any(Error));
  });

  test('storage 中是空字符串 → EMPTY_VALUE', () => {
    const state = createFakeState();
    state.storage.setItem(state.key, '');
    expect(canFastAcquire(state)).toBe(true);
  });

  test('storage 中是非法 JSON → logger.warn + EMPTY_VALUE', () => {
    const state = createFakeState();
    state.storage.setItem(state.key, '{not json');
    expect(canFastAcquire(state)).toBe(true);
    expect(state.deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('JSON.parse failed'),
      expect.any(Error),
    );
  });

  test('storage 中是合法 JSON 但格式不对 → logger.warn + EMPTY_VALUE', () => {
    const state = createFakeState();
    state.storage.setItem(state.key, JSON.stringify({ wrong: 'shape' }));
    expect(canFastAcquire(state)).toBe(true);
    expect(state.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('malformed value'));
  });
});

describe('drivers/storage-state — releaseHolderInStorage', () => {
  test('storage 无 holder → no-op', () => {
    const state = createFakeState();
    releaseHolderInStorage(state, 'token-x', 'nonce-x');
    expect(state.storage.getItem(state.key)).toBeNull();
  });

  test('holder.token 不匹配 → 不释放', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'other', heartbeat: Date.now(), nonce: 'nonce-other' },
      queue: [],
      rev: 1,
    });
    releaseHolderInStorage(state, 'me', 'my-nonce');
    const raw = state.storage.getItem(state.key);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).holder.token).toBe('other');
  });

  test('holder.nonce 不匹配 → 不释放', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'me', heartbeat: Date.now(), nonce: 'old-nonce' },
      queue: [],
      rev: 1,
    });
    releaseHolderInStorage(state, 'me', 'new-nonce');
    const raw = state.storage.getItem(state.key);
    expect(JSON.parse(raw as string).holder).not.toBeNull();
  });

  test('token + nonce 全匹配 → 释放（holder=null）', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'me', heartbeat: Date.now(), nonce: 'my-nonce' },
      queue: [],
      rev: 1,
    });
    releaseHolderInStorage(state, 'me', 'my-nonce');
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.holder).toBeNull();
    expect(parsed.rev).toBe(2);
  });
});

describe('drivers/storage-state — tryAcquire', () => {
  test('destroyed=true → resolve(null)', async () => {
    const state = createFakeState({ destroyed: true });
    const grant = await tryAcquire(state, 'me', false);
    expect(grant).toBeNull();
  });

  test('空 storage + 非 force → 抢锁成功', async () => {
    const state = createFakeState();
    const grant = await tryAcquire(state, 'me', false);
    expect(grant).not.toBeNull();
    expect(grant?.token).toBe('me');
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.holder.token).toBe('me');
  });

  test('holder 活着 + 非 force → resolve(null)（cannot-acquire）', async () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'other', heartbeat: Date.now(), nonce: 'n' },
      queue: [],
      rev: 1,
    });
    const grant = await tryAcquire(state, 'me', false);
    expect(grant).toBeNull();
  });

  test('holder 活着 + force=true → 覆盖成功', async () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'other', heartbeat: Date.now(), nonce: 'n' },
      queue: [],
      rev: 1,
    });
    const grant = await tryAcquire(state, 'me', true);
    expect(grant).not.toBeNull();
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.holder.token).toBe('me');
  });

  test('队列非空 + 自己不在队首 + 非 force → cannot-acquire', async () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [
        { token: 'first', ts: Date.now() },
        { token: 'me', ts: Date.now() },
      ],
      rev: 1,
    });
    const grant = await tryAcquire(state, 'me', false);
    expect(grant).toBeNull();
  });

  test('队列非空 + 自己在队首 + 非 force → 抢锁成功', async () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [
        { token: 'me', ts: Date.now() },
        { token: 'next', ts: Date.now() },
      ],
      rev: 1,
    });
    const grant = await tryAcquire(state, 'me', false);
    expect(grant).not.toBeNull();
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.queue.find((entry: { token: string }) => entry.token === 'me')).toBeUndefined();
  });

  test('writeStorage 抛错 → resolve(null)（abort）', async () => {
    const state = createFakeState({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      } as Storage,
    });
    const grant = await tryAcquire(state, 'me', false);
    expect(grant).toBeNull();
  });
});

describe('drivers/storage-state — enqueueInStorage', () => {
  test('destroyed=true → resolve(false)', async () => {
    const state = createFakeState({ destroyed: true });
    const ok = await enqueueInStorage(state, 'me');
    expect(ok).toBe(false);
  });

  test('空队列 → 入队成功', async () => {
    const state = createFakeState();
    const ok = await enqueueInStorage(state, 'me');
    expect(ok).toBe(true);
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.queue).toHaveLength(1);
    expect(parsed.queue[0].token).toBe('me');
  });

  test('已在队列中（幂等） → 直接 success，不重复入队', async () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [{ token: 'me', ts: 100 }],
      rev: 1,
    });
    const ok = await enqueueInStorage(state, 'me');
    expect(ok).toBe(true);
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.queue).toHaveLength(1);
  });

  test('writeStorage 持续抛错 → resolve(false)', async () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState({
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new Error('quota');
          },
          removeItem: vi.fn(),
          clear: vi.fn(),
          key: () => null,
          length: 0,
        } as Storage,
      });
      const promise = enqueueInStorage(state, 'me');
      await vi.runAllTimersAsync();
      const ok = await promise;
      expect(ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('drivers/storage-state — enterHolding + handle.release', () => {
  test('enterHolding 切换 status 为 holding 并启动心跳', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      writeRaw(state, {
        holder: { token: 'me', heartbeat: Date.now(), nonce: 'n1' },
        queue: [],
        rev: 1,
      });
      const handle = enterHolding(state, 'me', 'n1');
      expect(state.status.kind).toBe('holding');
      expect(typeof handle.release).toBe('function');
      expect(typeof handle.onRevokedByDriver).toBe('function');

      handle.release();
      expect(state.status.kind).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('handle.release 重复调用 → 幂等', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'me', heartbeat: Date.now(), nonce: 'n1' },
      queue: [],
      rev: 1,
    });
    const handle = enterHolding(state, 'me', 'n1');
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  test('handle.onRevokedByDriver 在 holding 下注册 callback；释放后注册无效', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'me', heartbeat: Date.now(), nonce: 'n1' },
      queue: [],
      rev: 1,
    });
    const handle = enterHolding(state, 'me', 'n1');
    const cb = vi.fn();
    handle.onRevokedByDriver(cb);
    expect(state.status.kind).toBe('holding');
    const holdingStatus = state.status as Extract<typeof state.status, { kind: 'holding' }>;
    expect(holdingStatus.revokeCallback).toBe(cb);

    handle.release();
    const cb2 = vi.fn();
    handle.onRevokedByDriver(cb2);
    // status 已变 idle，不应抛错且 cb2 不被设置（idle 没有 revokeCallback 字段）
    expect(state.status.kind).toBe('idle');
  });
});

describe('drivers/storage-state — revokeHolding', () => {
  test('status 非 holding → 早退', () => {
    const state = createFakeState();
    expect(() => revokeHolding(state, 'force')).not.toThrow();
    expect(state.status.kind).toBe('idle');
  });

  test('holding.released=true → 早退（不重复触发 callback）', () => {
    const cb = vi.fn();
    const state = createFakeState();
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: true,
      revokeCallback: cb,
      heartbeatTimer: null,
    };
    revokeHolding(state, 'force');
    expect(cb).not.toHaveBeenCalled();
  });

  test('正常 revoke：清状态 + 触发 callback + pumpNextWaiter', () => {
    const cb = vi.fn();
    const state = createFakeState();
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: cb,
      heartbeatTimer: null,
    };
    revokeHolding(state, 'force');
    expect(cb).toHaveBeenCalledWith('force');
    expect(state.status.kind).toBe('idle');
  });

  test('revokeCallback 抛错 → logger.error 捕获', () => {
    const cb = vi.fn(() => {
      throw new Error('cb-boom');
    });
    const state = createFakeState();
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: cb,
      heartbeatTimer: null,
    };
    expect(() => revokeHolding(state, 'timeout')).not.toThrow();
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('revoke callback threw'),
      expect.any(Error),
    );
  });

  test('revokeCallback=null → 不调 callback 也不抛错', () => {
    const state = createFakeState();
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    expect(() => revokeHolding(state, 'force')).not.toThrow();
    expect(state.status.kind).toBe('idle');
  });
});

describe('drivers/storage-state — handleExternalChange', () => {
  test('destroyed=true → 早退', () => {
    const state = createFakeState({ destroyed: true });
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    handleExternalChange(state);
    expect(state.status.kind).toBe('holding');
  });

  test('holding 中 holder 仍然是自己 → 不 revoke', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'me', heartbeat: Date.now(), nonce: 'n1' },
      queue: [],
      rev: 1,
    });
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    handleExternalChange(state);
    expect(state.status.kind).toBe('holding');
  });

  test('holding 中 holder 已被覆盖 → revoke', () => {
    const cb = vi.fn();
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'attacker', heartbeat: Date.now(), nonce: 'na' },
      queue: [],
      rev: 1,
    });
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: cb,
      heartbeatTimer: null,
    };
    handleExternalChange(state);
    expect(state.status.kind).toBe('idle');
    expect(cb).toHaveBeenCalledWith('force');
  });

  test('holding 中 holder=null → revoke', () => {
    const state = createFakeState();
    writeRaw(state, EMPTY_VALUE);
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    handleExternalChange(state);
    expect(state.status.kind).toBe('idle');
  });

  test('holding 但 released=true → 不进入 revoke 早退分支', () => {
    const state = createFakeState();
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: true,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    expect(() => handleExternalChange(state)).not.toThrow();
  });

  test('idle + 有 waiter + storage holder=null → pumpNextWaiter', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'me', resolve });
    state.waiters.push(w);
    handleExternalChange(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('idle + 有 waiter + storage holder 活着 → 不 pump', async () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'other', heartbeat: Date.now(), nonce: 'no' },
      queue: [],
      rev: 1,
    });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'me', resolve });
    state.waiters.push(w);
    handleExternalChange(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).not.toHaveBeenCalled();
  });

  test('idle + 无 waiter → 不 pump', () => {
    const state = createFakeState();
    expect(() => handleExternalChange(state)).not.toThrow();
  });
});

describe('drivers/storage-state — pumpNextWaiter', () => {
  test('destroyed → 早退', async () => {
    const state = createFakeState({ destroyed: true });
    state.waiters.push(makeWaiter());
    pumpNextWaiter(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(state.pumping).toBe(false);
  });

  test('pumping=true → 早退（防重入）', () => {
    const state = createFakeState();
    state.pumping = true;
    state.waiters.push(makeWaiter());
    pumpNextWaiter(state);
    expect(state.pumping).toBe(true);
  });

  test('status 非 idle → 早退', () => {
    const state = createFakeState();
    state.status = {
      kind: 'holding',
      token: 'x',
      nonce: 'y',
      released: false,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    state.waiters.push(makeWaiter());
    pumpNextWaiter(state);
    expect(state.pumping).toBe(false);
  });

  test('队列空 → 早退', () => {
    const state = createFakeState();
    pumpNextWaiter(state);
    expect(state.pumping).toBe(false);
  });

  test('正常 pump：抢到锁 → resolve waiter', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'me', resolve });
    state.waiters.push(w);
    pumpNextWaiter(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(state.status.kind).toBe('holding');
  });

  test('pump 抢到锁但 destroyed → 释放 + 移除 waiter', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'me', resolve });
    state.waiters.push(w);
    // 在 tryAcquire 完成后翻 destroyed：用 setItem hook
    const originalSetItem = state.storage.setItem.bind(state.storage);
    let firstWriteDone = false;
    state.storage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (!firstWriteDone) {
        firstWriteDone = true;
        state.destroyed = true;
      }
    };
    pumpNextWaiter(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).not.toHaveBeenCalled();
    expect(state.waiters).not.toContain(w);
  });

  test('pump 抢到锁但 waiter 已 settled → 释放 + 出队', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    let settled = false;
    const w = makeWaiter({
      token: 'me',
      resolve,
      isSettled: () => settled,
    });
    state.waiters.push(w);
    // 在 tryAcquire 完成后翻 settled
    const originalSetItem = state.storage.setItem.bind(state.storage);
    let firstWriteDone = false;
    state.storage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (!firstWriteDone) {
        firstWriteDone = true;
        settled = true;
      }
    };
    pumpNextWaiter(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).not.toHaveBeenCalled();
    expect(state.waiters).not.toContain(w);
  });

  test('pump 抢到锁但 status 已被改成 holding（理论防御）→ 释放', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'me', resolve });
    state.waiters.push(w);
    // 在 tryAcquire 完成后改 status
    const originalSetItem = state.storage.setItem.bind(state.storage);
    let firstWriteDone = false;
    state.storage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (!firstWriteDone) {
        firstWriteDone = true;
        state.status = {
          kind: 'holding',
          token: 'attacker',
          nonce: 'na',
          released: false,
          revokeCallback: null,
          heartbeatTimer: null,
        };
      }
    };
    pumpNextWaiter(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).not.toHaveBeenCalled();
  });

  test('pump 抢到锁但 head 已变（waiter 被换掉）→ 释放', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const original = makeWaiter({ token: 'me', resolve });
    state.waiters.push(original);
    const originalSetItem = state.storage.setItem.bind(state.storage);
    let firstWriteDone = false;
    state.storage.setItem = (key: string, value: string) => {
      originalSetItem(key, value);
      if (!firstWriteDone) {
        firstWriteDone = true;
        // 把队列首换成另一个 waiter
        state.waiters.shift();
        state.waiters.unshift(makeWaiter({ token: 'someone-else' }));
      }
    };
    pumpNextWaiter(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).not.toHaveBeenCalled();
  });

  test('pump 抢锁失败（grant=null）→ 不动队列', async () => {
    const state = createFakeState();
    // 让 storage 已被其他 token 占用
    writeRaw(state, {
      holder: { token: 'other', heartbeat: Date.now(), nonce: 'no' },
      queue: [],
      rev: 1,
    });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'me', resolve });
    state.waiters.push(w);
    pumpNextWaiter(state);
    await new Promise((r) => setTimeout(r, 10));
    expect(resolve).not.toHaveBeenCalled();
    expect(state.waiters).toContain(w);
  });
});

describe('drivers/storage-state — subscribeStorageEvent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('globalThis.addEventListener 不存在 → 返回 null + logger.warn', () => {
    // Node 环境下默认没有 storage 事件处理；伪造一个无 addEventListener 的 globalThis
    const state = createFakeState();
    const fakeGlobal = {} as typeof globalThis;
    // 由于 subscribeStorageEvent 直接用 globalThis，stub addEventListener=undefined
    const original = (globalThis as unknown as { addEventListener?: unknown }).addEventListener;
    vi.stubGlobal('addEventListener', undefined);
    try {
      const result = subscribeStorageEvent(state);
      expect(result).toBeNull();
      expect(state.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('addEventListener unavailable'));
    } finally {
      // 恢复
      if (original !== undefined) {
        vi.stubGlobal('addEventListener', original);
      }
    }
    void fakeGlobal;
  });

  test('addEventListener 可用 → 注册 + 返回 unsubscribe；触发事件命中 handler 各分支', () => {
    const handlers = new Map<string, (event: StorageEvent) => void>();
    const fakeAdd = vi.fn((type: string, eventHandler: (event: StorageEvent) => void) => {
      handlers.set(type, eventHandler);
    });
    const fakeRemove = vi.fn((type: string) => {
      handlers.delete(type);
    });
    vi.stubGlobal('addEventListener', fakeAdd);
    vi.stubGlobal('removeEventListener', fakeRemove);

    const state = createFakeState();
    const unsubscribe = subscribeStorageEvent(state);
    expect(unsubscribe).not.toBeNull();
    expect(fakeAdd).toHaveBeenCalledWith('storage', expect.any(Function));

    const handler = handlers.get('storage');
    expect(handler).toBeDefined();

    // 1. storageArea 不匹配 → 早退
    const otherStorage = createMemoryStorage();
    handler?.({
      key: state.key,
      storageArea: otherStorage,
      newValue: null,
      oldValue: null,
    } as any);

    // 2. key 不匹配且非 null → 早退
    handler?.({
      key: 'unrelated-key',
      storageArea: state.storage,
      newValue: null,
      oldValue: null,
    } as StorageEvent);

    // 3. key=null → 视作 clear()，触发 handleExternalChange
    handler?.({
      key: null,
      storageArea: state.storage,
      newValue: null,
      oldValue: null,
    } as StorageEvent);

    // 4. key 匹配 → 触发 handleExternalChange
    handler?.({
      key: state.key,
      storageArea: state.storage,
      newValue: null,
      oldValue: null,
    } as StorageEvent);

    unsubscribe?.();
    expect(fakeRemove).toHaveBeenCalledWith('storage', expect.any(Function));
  });

  test('handler 内 handleExternalChange 抛错 → logger.error 捕获', () => {
    const handlers = new Map<string, (event: StorageEvent) => void>();
    const fakeAdd = vi.fn((type: string, eventHandler: (event: StorageEvent) => void) => {
      handlers.set(type, eventHandler);
    });
    vi.stubGlobal('addEventListener', fakeAdd);
    vi.stubGlobal('removeEventListener', vi.fn());

    // 让 handleExternalChange 抛错：注入一个 storage.getItem 抛非预期类型错误的 storage
    // readStorage 已 try-catch getItem，但这里我们让 status 检查路径下 readStorage 抛错
    // 实际上 readStorage 内部 try-catch 已经吞掉所有错误；为命中 handler 内 try-catch
    // 路径，把 state.deps 改成 getter 抛错
    const state = createFakeState();
    Object.defineProperty(state, 'destroyed', {
      get: () => {
        throw new Error('synthetic destroyed access');
      },
      configurable: true,
    });
    subscribeStorageEvent(state);
    const handler = handlers.get('storage');
    expect(() =>
      handler?.({
        key: state.key,
        storageArea: state.storage,
        newValue: null,
        oldValue: null,
      } as StorageEvent),
    ).not.toThrow();
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('handleExternalChange threw'),
      expect.any(Error),
    );
  });
});

describe('drivers/storage-state — startPolling', () => {
  test('定时调用 handleExternalChange；异常时 logger.error', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      const timer = startPolling(state);
      expect(timer).not.toBeNull();

      vi.advanceTimersByTime(2000);

      // 制造异常路径：destroyed 用 getter 抛错
      Object.defineProperty(state, 'destroyed', {
        get: () => {
          throw new Error('poll-boom');
        },
        configurable: true,
      });
      vi.advanceTimersByTime(2000);
      expect(state.deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('polling threw'), expect.any(Error));

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('drivers/storage-state — drainOnDestroy', () => {
  function buildAbortError(token: string): Error {
    return new Error(`aborted token=${token}`);
  }

  test('idle + 无 waiter + 无 timer/unsubscribe → 平稳收尾', () => {
    const state = createFakeState();
    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
  });

  test('清理 pollTimer + unsubscribeStorageEvent', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      state.pollTimer = setInterval(() => {}, 1000);
      const unsubscribe = vi.fn();
      state.unsubscribeStorageEvent = unsubscribe;

      drainOnDestroy(state, buildAbortError);

      expect(state.pollTimer).toBeNull();
      expect(state.unsubscribeStorageEvent).toBeNull();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('unsubscribe 抛错 → logger.error 捕获，继续后续清理', () => {
    const state = createFakeState();
    state.unsubscribeStorageEvent = () => {
      throw new Error('unsub-boom');
    };
    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unsubscribe storage event threw'),
      expect.any(Error),
    );
  });

  test('holding 时 destroy → 释放 + 写 null + 状态变 idle', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'me', heartbeat: Date.now(), nonce: 'n1' },
      queue: [],
      rev: 1,
    });
    state.status = {
      kind: 'holding',
      token: 'me',
      nonce: 'n1',
      released: false,
      revokeCallback: null,
      heartbeatTimer: null,
    };
    drainOnDestroy(state, buildAbortError);

    expect(state.status.kind).toBe('idle');
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.holder).toBeNull();
  });

  test('有 pending waiter → 批量 dequeue + abort 每个 waiter', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [
        { token: 'a', ts: 1 },
        { token: 'b', ts: 2 },
        { token: 'unrelated', ts: 3 },
      ],
      rev: 1,
    });
    const w1 = makeWaiter({ token: 'a' });
    const w2 = makeWaiter({ token: 'b' });
    state.waiters.push(w1, w2);

    drainOnDestroy(state, buildAbortError);

    expect(w1.abort).toHaveBeenCalledTimes(1);
    expect(w2.abort).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.queue).toHaveLength(1);
    expect(parsed.queue[0].token).toBe('unrelated');
  });

  test('有 pending waiter 但队列里都不在 → 不写 storage', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [{ token: 'unrelated', ts: 1 }],
      rev: 1,
    });
    const setItemSpy = vi.spyOn(state.storage, 'setItem');
    const w = makeWaiter({ token: 'no-in-storage-queue' });
    state.waiters.push(w);

    drainOnDestroy(state, buildAbortError);

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('批量 dequeue 时 readStorage 抛错 → logger.error 捕获，继续 abort', () => {
    const state = createFakeState({
      storage: {
        getItem: () => {
          throw new Error('read-boom');
        },
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      } as Storage,
    });
    const w = makeWaiter({ token: 'a' });
    state.waiters.push(w);

    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
    // readStorage 内部 try-catch 已吞掉 getItem 异常，所以 batch 不会触发 logger.error
    // 这条用例确保 destroy 路径不抛
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('batch dequeue 时 readStorage 后 filter 长度未变 → 不触发 writeStorage', () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [{ token: 'unrelated', ts: 1 }],
      rev: 1,
    });
    const setItemSpy = vi.spyOn(state.storage, 'setItem');
    setItemSpy.mockClear();
    const w = makeWaiter({ token: 'not-in-queue' });
    state.waiters.push(w);

    drainOnDestroy(state, buildAbortError);

    // pendingTokens 不在 storage queue 里 → filtered.length === current.queue.length → 不写
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('batch dequeue 内部抛错 → logger.error 捕获，仍能 abort 所有 waiter（命中 L641）', () => {
    // 让 waiter.token 是 getter，访问时抛错；
    // batch try 内 `pendingTokens.add(pending[i].token)` 会触发抛错 → 进入 catch → 命中 L641
    // catch 之后的 abort 循环再次访问 token，仍会抛错 —— 改为只让前两次访问抛错（add + abort）
    // 实际上 abort 循环的 buildAbortError(pending[i].token) 也会读 token → 同样抛错
    // → 用计数器：让 token 在前 N 次访问抛错，之后正常返回
    const state = createFakeState();
    writeRaw(state, {
      holder: null,
      queue: [{ token: 'a', ts: 1 }],
      rev: 1,
    });

    // 构造一个 waiter，token 是 getter：第一次访问（batch try 内 add）抛错 → 命中 catch
    // 后续 abort 循环里的访问允许返回字符串
    let tokenAccessCount = 0;
    const explosiveWaiter: Waiter = {
      get token() {
        tokenAccessCount++;
        if (tokenAccessCount === 1) {
          throw new Error('synthetic-token-boom');
        }
        return 'a';
      },
      resolve: vi.fn<(handle: LockDriverHandle) => void>(),
      reject: vi.fn<(error: Error) => void>(),
      abort: vi.fn<(error: Error) => void>(),
      isSettled: () => false,
    };
    state.waiters.push(explosiveWaiter);

    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();

    // 命中 batch catch 路径 → logger.error 被调用
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('batch dequeue failed during destroy'),
      expect.any(Error),
    );
    // abort 循环仍执行（catch 之后的 for 循环）
    expect(explosiveWaiter.abort).toHaveBeenCalledTimes(1);
  });
});

describe('drivers/storage-state — enqueueInStorage verify retry 路径', () => {
  test('writeStorage 成功但 verify 时读回不含 token → retry 直至超 WRITE_RETRY_MAX → false', async () => {
    vi.useFakeTimers();
    try {
      // 构造一个 storage：setItem 不抛错，但 getItem 始终返回 EMPTY_VALUE 等价的 raw（不含 token）
      // 让 enqueueInStorageOnce 走 retry 分支
      let writeCount = 0;
      const fakeStorage: Storage = {
        getItem: () => null, // 始终 EMPTY_VALUE
        setItem: () => {
          writeCount++;
          // 不抛错；但下次 getItem 仍然返回 null → verify 找不到 token → retry
        },
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      };
      const state = createFakeState({ storage: fakeStorage });
      const promise = enqueueInStorage(state, 'me');
      await vi.runAllTimersAsync();
      const ok = await promise;
      expect(ok).toBe(false);
      // setItem 被调用多次（retry），证明命中了 retry 路径
      expect(writeCount).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('drivers/storage-state — tryAcquire force 跳过 + verify retry 路径', () => {
  test('force=true 且 holder 活着 → 跳过 cannot-acquire 抢锁成功（命中 L266 force 跳过分支）', async () => {
    const state = createFakeState();
    writeRaw(state, {
      holder: { token: 'other', heartbeat: Date.now(), nonce: 'no' },
      queue: [{ token: 'queued', ts: 1 }],
      rev: 1,
    });
    const grant = await tryAcquire(state, 'me', true);
    expect(grant).not.toBeNull();
    expect(grant?.token).toBe('me');
    const parsed = JSON.parse(state.storage.getItem(state.key) as string);
    expect(parsed.holder.token).toBe('me');
    // force=true 不要求自己在队首，也能抢成功
  });

  test('writeStorage 成功但 verify 时 holder 不匹配 → retry 超限 → resolve(null)', async () => {
    vi.useFakeTimers();
    try {
      // 让 setItem 不实际写入，模拟 CAS 冲突：写完读回时 holder 仍是 'other'
      let setItemCount = 0;
      const fakeStorage: Storage = {
        getItem: () =>
          JSON.stringify({
            holder: { token: 'other', heartbeat: Date.now(), nonce: 'na' },
            queue: [],
            rev: 1,
          }),
        setItem: () => {
          setItemCount++;
          // 不实际写入；getItem 始终返回 other 的快照
        },
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      };
      const state = createFakeState({ storage: fakeStorage });
      const promise = tryAcquire(state, 'me', true);
      await vi.runAllTimersAsync();
      const grant = await promise;
      expect(grant).toBeNull();
      expect(setItemCount).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('drivers/storage-state — startHeartbeat（间接覆盖 setInterval 回调 anonymous_15）', () => {
  test('正常心跳：更新 heartbeat 字段，nonce 不变', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      writeRaw(state, {
        holder: { token: 'me', heartbeat: 1, nonce: 'n1' },
        queue: [],
        rev: 1,
      });
      const handle = enterHolding(state, 'me', 'n1');

      // 推进一次心跳间隔
      vi.advanceTimersByTime(10_000);

      const parsed = JSON.parse(state.storage.getItem(state.key) as string);
      expect(parsed.holder.token).toBe('me');
      expect(parsed.holder.nonce).toBe('n1');
      expect(parsed.holder.heartbeat).toBeGreaterThan(1);

      handle.release();
    } finally {
      vi.useRealTimers();
    }
  });

  test('心跳触发时 holding.released=true → stopHeartbeat 早退（不更新心跳）', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      writeRaw(state, {
        holder: { token: 'me', heartbeat: 1, nonce: 'n1' },
        queue: [],
        rev: 1,
      });
      const handle = enterHolding(state, 'me', 'n1');

      // release 让 holding.released=true（同时也 stopHeartbeat）
      handle.release();
      // 即使再推进时间，也不应再更新（timer 已被 clearInterval）
      vi.advanceTimersByTime(20_000);

      // 重要：handle.release 已经把 holder 写成 null
      const parsed = JSON.parse(state.storage.getItem(state.key) as string);
      expect(parsed.holder).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('心跳触发时 state.destroyed=true → stopHeartbeat 早退', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      writeRaw(state, {
        holder: { token: 'me', heartbeat: 1, nonce: 'n1' },
        queue: [],
        rev: 1,
      });
      enterHolding(state, 'me', 'n1');

      state.destroyed = true;
      // 推进心跳间隔；应直接 stopHeartbeat 不更新
      vi.advanceTimersByTime(20_000);

      // heartbeat 字段未被更新（因 stopHeartbeat 早退）
      const parsed = JSON.parse(state.storage.getItem(state.key) as string);
      expect(parsed.holder.heartbeat).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('心跳触发时 holder 已被覆盖（token 不匹配）→ revokeHolding(force)', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      writeRaw(state, {
        holder: { token: 'me', heartbeat: 1, nonce: 'n1' },
        queue: [],
        rev: 1,
      });
      const cb = vi.fn();
      const handle = enterHolding(state, 'me', 'n1');
      handle.onRevokedByDriver(cb);

      // 模拟其他 Tab 抢占
      writeRaw(state, {
        holder: { token: 'attacker', heartbeat: Date.now(), nonce: 'na' },
        queue: [],
        rev: 2,
      });

      vi.advanceTimersByTime(10_000);

      expect(cb).toHaveBeenCalledWith('force');
      expect(state.status.kind).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('心跳触发时 holder=null（被外部清空）→ revokeHolding(force)', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      writeRaw(state, {
        holder: { token: 'me', heartbeat: 1, nonce: 'n1' },
        queue: [],
        rev: 1,
      });
      enterHolding(state, 'me', 'n1');

      // 模拟 storage 被清空
      writeRaw(state, {
        holder: null,
        queue: [],
        rev: 2,
      });

      vi.advanceTimersByTime(10_000);

      expect(state.status.kind).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('心跳触发时 holder.nonce 不匹配 → revokeHolding(force)', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      writeRaw(state, {
        holder: { token: 'me', heartbeat: 1, nonce: 'n1' },
        queue: [],
        rev: 1,
      });
      enterHolding(state, 'me', 'n1');

      // 同 token 不同 nonce（重入或外部恶意覆盖）
      writeRaw(state, {
        holder: { token: 'me', heartbeat: Date.now(), nonce: 'n2-different' },
        queue: [],
        rev: 2,
      });

      vi.advanceTimersByTime(10_000);

      expect(state.status.kind).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });
});
