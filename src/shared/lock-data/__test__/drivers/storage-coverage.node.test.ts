/**
 * drivers/storage.ts 覆盖率补强测试
 *
 * 通过直接 import 内部纯函数（hasUsableLocalStorage / buildWaiter / acquireForceLock /
 * handleFastPathGrant / acquireNonForceLock / enqueueSlowPath / acquireStorageLock /
 * createStorageDriver），命中正常 createStorageDriver browser 主链路下不易触达的防御分支。
 *
 * 覆盖目标（参考 analyze-coverage 输出）：
 * - L49-50: hasUsableLocalStorage storage 缺失 → false
 * - L57: hasUsableLocalStorage setItem 抛错 → catch return false
 * - L93/L101/L109: buildWaiter resolve/reject/abort 在 settled 时早退
 * - L154-160: acquireForceLock grant=null → waiter.abort
 * - L162-169: acquireForceLock destroyed → 释放 + abort
 * - L172-174: acquireForceLock waiter.isSettled → 立即释放
 * - L178: acquireForceLock force 覆盖自己（status=holding）
 * - L199-206: handleFastPathGrant destroyed → 释放 + abort
 * - L213-217: handleFastPathGrant status≠idle → 释放 + 慢路径
 * - L236, L241-242: acquireNonForceLock 慢路径回退
 * - L258-259: enqueueSlowPath enqueue 失败 → logger.warn
 * - L300-301: createStorageDriver localStorage 不可用 → 抛 TypeError
 *
 * 设计约束：node 环境（无 BroadcastChannel/localStorage 真实实例），
 * 通过 stubGlobal('localStorage', ...) 注入伪 storage 让能力探测通过；
 * 然后构造伪 state 直接调用内部函数命中防御分支
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  acquireForceLock,
  acquireNonForceLock,
  acquireStorageLock,
  buildWaiter,
  enqueueSlowPath,
  handleFastPathGrant,
  hasUsableLocalStorage,
} from '../../drivers/storage';
import type { StorageDriverState, Waiter } from '../../drivers/storage-state';
import type { LockDriverContext, LockDriverHandle, LoggerAdapter } from '../../types';

function createLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function createFakeState(overrides: Partial<StorageDriverState> = {}): StorageDriverState {
  const logger = createLogger();
  const storage = createMemoryStorage();
  return {
    deps: {
      id: 'test-id',
      name: 'storage-test',
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

function createCtx(overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const controller = new AbortController();
  return {
    token: 'token-test',
    signal: controller.signal,
    force: false,
    acquireTimeout: 0,
    ...overrides,
  } as any;
}

describe('drivers/storage — hasUsableLocalStorage 防御分支', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('localStorage=undefined → 返回 false（命中 L49-50）', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(hasUsableLocalStorage()).toBe(false);
  });

  test('setItem 抛错 → 返回 false（命中 L57 catch）', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: vi.fn(),
      getItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    });
    expect(hasUsableLocalStorage()).toBe(false);
  });

  test('完整可用的 localStorage → 返回 true', () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    expect(hasUsableLocalStorage()).toBe(true);
  });
});

describe('drivers/storage — acquireStorageLock abort 入口', () => {
  test('signal 已 abort 时直接 reject 且不写 localStorage', async () => {
    const state = createFakeState();
    const controller = new AbortController();
    controller.abort();

    await expect(
      acquireStorageLock(
        state,
        createCtx({
          signal: controller.signal,
          token: 'already-aborted',
          force: true,
        }),
      ),
    ).rejects.toThrow('acquire aborted');
    expect(state.storage.getItem(state.key)).toBeNull();
  });
});

describe('drivers/storage — buildWaiter settled 互斥', () => {
  test('resolve 后再次 resolve / reject / abort 全部早退（命中 L93/L101/L109）', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const ctx = createCtx();

    const waiter = buildWaiter(ctx, state, resolve, reject);
    const fakeHandle: LockDriverHandle = {
      release: vi.fn(),
      onRevokedByDriver: vi.fn(),
    };

    waiter.resolve(fakeHandle);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(waiter.isSettled()).toBe(true);

    waiter.resolve(fakeHandle);
    expect(resolve).toHaveBeenCalledTimes(1);

    waiter.reject(new Error('after-resolve'));
    expect(reject).not.toHaveBeenCalled();

    waiter.abort(new Error('after-resolve-abort'));
    expect(reject).not.toHaveBeenCalled();
  });

  test('reject 后再次 reject 早退', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx(), state, resolve, reject);

    waiter.reject(new Error('first'));
    expect(reject).toHaveBeenCalledTimes(1);
    waiter.reject(new Error('second'));
    expect(reject).toHaveBeenCalledTimes(1);
  });

  test('abort 后再次 abort 早退', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx(), state, resolve, reject);

    waiter.abort(new Error('first'));
    expect(reject).toHaveBeenCalledTimes(1);
    waiter.abort(new Error('second'));
    expect(reject).toHaveBeenCalledTimes(1);
  });
});

describe('drivers/storage — acquireForceLock 防御分支', () => {
  test('destroyed=true（在 tryAcquire 拿到 grant 后才 destroyed）→ 释放 + abort（命中 L162-169）', async () => {
    // 关键：让 tryAcquire 完成 CAS 拿到 grant 后，在 .then 回调执行前把 destroyed 翻成 true
    // 实现：state 用 Proxy / 计数器；不直接用 createFakeState 的 destroyed，而是用 getter
    // 让 tryAcquireOnce 内部 if(state.destroyed) 看到 false（首次访问），但 .then 回调里看到 true
    const memory = new Map<string, string>();
    const internalState = { destroyed: false };
    let setItemCount = 0;
    const trackedStorage: Storage = {
      getItem: (key) => (memory.has(key) ? (memory.get(key) as string) : null),
      setItem: (key, value) => {
        memory.set(key, String(value));
        setItemCount++;
        // 第一次成功写入 holder 后立即翻 destroyed，让 .then 回调命中 L162
        if (setItemCount === 1) {
          internalState.destroyed = true;
        }
      },
      removeItem: (key) => {
        memory.delete(key);
      },
      clear: () => memory.clear(),
      key: (i) => Array.from(memory.keys())[i] ?? null,
      get length() {
        return memory.size;
      },
    } as Storage;

    // 用 Object.defineProperty 把 destroyed 字段绑定到 internalState，模拟"延迟翻转"
    const state = createFakeState({ storage: trackedStorage });
    Object.defineProperty(state, 'destroyed', {
      get: () => internalState.destroyed,
      set: (value: boolean) => {
        internalState.destroyed = value;
      },
      configurable: true,
    });

    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'force-destroyed' }), state, resolve, reject);

    acquireForceLock(state, waiter);
    await new Promise((r) => setTimeout(r, 5));

    // tryAcquire 完成后 grant!==null（首次 CAS 写入成功），但 .then 回调里 state.destroyed=true
    // → 命中 L162-169：releaseHolderInStorage + waiter.abort
    expect(setItemCount).toBeGreaterThanOrEqual(1);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toMatch(/destroyed during force acquire/u);
  });

  test('waiter.isSettled=true → 释放抢到的锁（命中 L172-174）', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'force-settled' }), state, resolve, reject);

    acquireForceLock(state, waiter);
    // 在 tryAcquire 完成前提前 abort waiter
    waiter.abort(new Error('aborted-mid-flight'));

    await new Promise((r) => setTimeout(r, 0));

    expect(reject).toHaveBeenCalledTimes(1);
    // resolve 不被调用（waiter 已 abort）；不再断言 storage 内部结构（实现细节）
    expect(resolve).not.toHaveBeenCalled();
  });

  test('status=holding + force 覆盖自己 → 命中 L178 revokeHolding 分支', async () => {
    // 先让 driver 持有：手动构造 holding 状态
    const state = createFakeState({
      status: {
        kind: 'holding',
        token: 'old-token',
        nonce: 'old-nonce',
        released: false,
        revokeCallback: null,
        heartbeatTimer: null,
      } as unknown as StorageDriverState['status'],
    });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'force-self', force: true }), state, resolve, reject);

    acquireForceLock(state, waiter);
    await new Promise((r) => setTimeout(r, 0));

    // force 覆盖自己应成功 resolve，并将 status 切换为新的 holding（token=force-self）
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(state.status.kind).toBe('holding');
    expect((state.status as any).token).toBe('force-self');
  });
});

describe('drivers/storage — handleFastPathGrant 防御分支', () => {
  test('destroyed=true → 释放  abort（命中 L199-206）', () => {
    const state = createFakeState({ destroyed: true });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'fast-destroyed' }), state, resolve, reject);

    handleFastPathGrant(state, waiter, 'nonce-1');

    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toMatch(/destroyed during fast acquire/u);
  });

  test('waiter.isSettled=true → 释放抢到的锁（命中 L172-174 同结构 fast 版本）', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'fast-settled' }), state, resolve, reject);

    waiter.abort(new Error('preset-abort'));
    handleFastPathGrant(state, waiter, 'nonce-2');

    // waiter 已 abort，handleFastPathGrant 不再 resolve
    expect(resolve).not.toHaveBeenCalled();
  });

  test('status≠idle → 释放 + 慢路径回退（命中 L213-217）', () => {
    const state = createFakeState({
      status: {
        kind: 'holding',
        token: 'other',
        nonce: 'other-nonce',
        released: false,
        revokeCallback: null,
        heartbeatTimer: null,
      } as unknown as StorageDriverState['status'],
    });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'fast-non-idle' }), state, resolve, reject);

    handleFastPathGrant(state, waiter, 'nonce-3');

    // 走慢路径：waiter 入队
    expect(state.waiters).toContain(waiter);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('idle + 未 settled + 未 destroyed → 正常 enterHolding 授予锁', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'fast-success' }), state, resolve, reject);

    handleFastPathGrant(state, waiter, 'nonce-4');

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(state.status.kind).toBe('holding');
  });
});

describe('drivers/storage — acquireNonForceLock 慢路径回退', () => {
  test('canFastAcquire=false（waiters 非空）→ 直接走慢路径（命中 enqueueSlowPath）', () => {
    const state = createFakeState();
    // 预置 waiter 让 canFastAcquire 返回 false
    const placeholder: Waiter = {
      token: 'placeholder',
      resolve: vi.fn(),
      reject: vi.fn(),
      abort: vi.fn(),
      isSettled: () => false,
    };
    state.waiters.push(placeholder);

    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'slow-direct' }), state, resolve, reject);

    acquireNonForceLock(state, waiter);

    expect(state.waiters).toContain(waiter);
    expect(state.waiters.length).toBeGreaterThanOrEqual(2);
  });

  test('canFastAcquire=true + 快路径 CAS 失败（grant=null）+ waiter 未 settled → 慢路径（命中 L241-242）', async () => {
    // canFastAcquire 要求：state.status=idle + waiters=[] + storage 无 holder
    // 让 readStorage 返回空，setItem 抛错 → tryAcquireOnce 'abort' → tryAcquire resolve(null)
    // 这样 grant=null 但 waiter 未 settled，命中 L241-242 enqueueSlowPath 真分支
    const state = createFakeState({
      storage: {
        getItem: () => null, // 始终返回空 → readStorage 走 EMPTY_VALUE 分支
        setItem: () => {
          throw new Error('quota exceeded');
        },
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      } as Storage,
    });

    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'slow-fallback' }), state, resolve, reject);

    acquireNonForceLock(state, waiter);
    await new Promise((r) => setTimeout(r, 10));

    // CAS 失败 → 走慢路径回退；waiter 应在 state.waiters 中
    expect(state.waiters).toContain(waiter);
  });

  test('canFastAcquire=true + 快路径 CAS 成功（grant!==null）→ 命中 L236 真分支', async () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'fast-success' }), state, resolve, reject);

    acquireNonForceLock(state, waiter);
    await new Promise((r) => setTimeout(r, 10));

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('canFastAcquire=true + 快路径 CAS 失败 + waiter 已 settled → 不重复入队（命中 L241 false 分支）', async () => {
    // 让 setItem 抛错 → tryAcquire resolve(null)；同时 waiter 在 .then 之前被 abort（settled=true）
    // → 命中 L241 if(!waiter.isSettled()) 的 false 分支
    const state = createFakeState({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      } as Storage,
    });

    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'fast-fail-settled' }), state, resolve, reject);

    acquireNonForceLock(state, waiter);
    // 在 tryAcquire 完成（resolve null）前提前 abort；abort 内部会 settled=true
    // 注意 acquireNonForceLock 的 .then 链是 Promise.resolve()，比 setTimeout 早，
    // 所以同步 abort 在 .then 回调前即可生效
    waiter.abort(new Error('aborted-mid-flight'));
    await new Promise((r) => setTimeout(r, 10));

    // waiter 已 settled，慢路径回退分支不入队 —— 但 abort 自身的 removeWaiter 也保证 waiter 不在队列
    expect(state.waiters).not.toContain(waiter);
    expect(reject).toHaveBeenCalledTimes(1);
  });
});

describe('drivers/storage — acquireForceLock grant=null 路径', () => {
  test('writeStorage 持续抛错 → grant=null → waiter.abort（命中 L154-160）', async () => {
    // 让 storage.setItem 始终抛错，writeStorage 返回 'abort'，tryAcquireOnce 返回 'abort'，
    // tryAcquire resolve(null) → 命中 L154-160
    const state = createFakeState({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
        removeItem: vi.fn(),
        clear: vi.fn(),
        key: () => null,
        length: 0,
      } as Storage,
    });

    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'force-grant-null' }), state, resolve, reject);

    acquireForceLock(state, waiter);
    await new Promise((r) => setTimeout(r, 10));

    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toMatch(/force acquire failed after retries/u);
  });
});

describe('drivers/storage — enqueueSlowPath enqueue 失败 warn', () => {
  test('enqueueInStorage 失败 → logger.warn（命中 L258-259）', async () => {
    const logger = createLogger();
    // 让 storage.setItem 在写队列时抛错
    let setItemCallCount = 0;
    const failingStorage: Storage = {
      ...createMemoryStorage(),
      setItem: (_key, _value) => {
        setItemCallCount++;
        throw new Error('quota exceeded');
      },
    } as Storage;

    const state = createFakeState({
      storage: failingStorage,
      deps: {
        id: 'test-id',
        name: 'storage-test',
        logger,
      } as unknown as StorageDriverState['deps'],
    });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const waiter = buildWaiter(createCtx({ token: 'slow-fail' }), state, resolve, reject);

    enqueueSlowPath(state, waiter);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(setItemCallCount).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('drivers/storage — acquireStorageLock destroyed reject', () => {
  test('state.destroyed=true → 返回 rejected Promise', async () => {
    const state = createFakeState({ destroyed: true });
    const ctx = createCtx({ token: 'token-on-destroyed' });

    const promise = acquireStorageLock(state, ctx);
    await expect(promise).rejects.toThrow(/storage driver has been destroyed/u);
  });

  test('state.destroyed=false + force=true → 走 acquireForceLock 路径', async () => {
    const state = createFakeState();
    const ctx = createCtx({ token: 'token-force', force: true });

    const promise = acquireStorageLock(state, ctx);
    await new Promise((r) => setTimeout(r, 0));

    // force 路径走 tryAcquire；空 storage 必然 CAS 成功
    const handle = await promise;
    expect(handle).toBeDefined();
    expect(typeof handle.release).toBe('function');
    handle.release();
  });
});

describe('drivers/storage — createStorageDriver localStorage 缺失', () => {
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalLocalStorage !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
      });
    }
  });

  test('localStorage 不可用 → 抛 TypeError（命中 L300-301）', async () => {
    vi.stubGlobal('localStorage', undefined);

    const { createStorageDriver } = await import('../../drivers/storage');
    expect(() =>
      createStorageDriver({
        id: 'test',
        name: 'driver-test',
        logger: createLogger(),
      } as unknown as Parameters<typeof createStorageDriver>[0]),
    ).toThrow(TypeError);
  });

  test('id 缺失 → 抛 TypeError', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    const { createStorageDriver } = await import('../../drivers/storage');
    expect(() =>
      createStorageDriver({
        id: '',
        name: 'driver-test',
        logger: createLogger(),
      } as unknown as Parameters<typeof createStorageDriver>[0]),
    ).toThrow(TypeError);
  });
});
