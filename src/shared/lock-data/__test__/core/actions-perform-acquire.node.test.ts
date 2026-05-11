/**
 * core/actions.ts `performAcquire` 中 `aliveToken !== token` 分支专项覆盖
 *
 * 该分支位置（actions.ts 内）：
 *   if (state.disposed || state.aliveToken !== token) {
 *     safeReleaseHandle(handle, ...);
 *     if (state.disposed) throwDisposed();
 *     throwError(..., 'lock revoked before activation', LockRevokedError);
 *   }
 *
 * 通过公共 `createActions` API 抢锁时不可能命中：
 *   - aliveToken 仅由 `handleRevoke` 改写
 *   - `handleRevoke` 仅由 `handle.onRevokedByDriver` 触发
 *   - handle 必须 acquire 成功后才能拿到 → acquire 期间 aliveToken 不会被外部改写
 *
 * 但作为双重防御保留：自定义 driver 若在 acquire 内部直接回调宿主的 revoke 路径仍可能命中。
 * 测试通过直接 import 内部 `performAcquire`（仅文件内 named export，未在 lock-data/index.ts 暴露），
 * 用 stub deps + stub state 在 driver.acquire 的 await 期间手动改写 `state.aliveToken`，
 * 命中 `lock revoked before activation` 抛 `LockRevokedError` 的分支。
 */

import { describe, expect, test, vi } from 'vitest';
import type { ResolvedAdapters } from '@/shared/lock-data/adapters/index';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { performAcquire } from '@/shared/lock-data/core/actions';
import { type ActionsInternalState, createInitialState } from '@/shared/lock-data/core/actions-helpers';
import type { Entry } from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/index';
import { LockDisposedError, LockRevokedError } from '@/shared/lock-data/errors';
import type { LockDataListeners, LockDataOptions, LockDriverHandle } from '@/shared/lock-data/types';
import { withResolvers } from '@/shared/with-resolvers';

// ---------------------------------------------------------------------------
// stub 工厂
// ---------------------------------------------------------------------------

function createStubAdapters<T>(): ResolvedAdapters<T> {
  return {
    logger: resolveLoggerAdapter({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    getAuthority: () => null,
    getChannel: () => null,
    getSessionStore: () => null,
    getLock: undefined,
  };
}

interface StubEntryOptions<T extends object> {
  readonly id?: string;
  readonly data: T;
  readonly driver: LockDriver;
  readonly listeners?: LockDataListeners<T>;
}

function createStubEntry<T extends object>(opts: StubEntryOptions<T>): Entry<T> {
  const listenersSet = new Set<LockDataListeners<T>>();
  if (opts.listeners) {
    listenersSet.add(opts.listeners);
  }
  const id = opts.id || 'perform-acquire-id';
  const dataRef = { current: opts.data };
  return {
    id,
    lockId: id,
    dataRef,
    applyRemote: (next: T): void => {
      dataRef.current = JSON.parse(JSON.stringify(next)) as T;
    },
    driver: opts.driver,
    adapters: createStubAdapters<T>(),
    authority: null,
    listenersSet,
    initOptions: Object.freeze({
      timeout: undefined,
      mode: undefined,
      syncMode: undefined,
      persistence: undefined,
      sessionProbeTimeout: undefined,
    }),
    dataReadyPromise: null,
    registerTeardown: (): void => {
      /* no-op */
    },
    refCount: 1,
    rev: 0,
    lastAppliedRev: 0,
    epoch: null,
  };
}

// ---------------------------------------------------------------------------
// 1. aliveToken 在 driver.acquire 的 await 期间被外部改写为 ''
//    → performAcquire 抛 LockRevokedError("lock revoked before activation")
// ---------------------------------------------------------------------------

describe('performAcquire / aliveToken 被改写为空字符串后抛 LockRevokedError', () => {
  test('driver.acquire 返回前外部清空 aliveToken → 抛 LockRevokedError 且 handle 被释放', async () => {
    let releaseCount = 0;
    const acquireGate = withResolvers<LockDriverHandle>();

    const driver: LockDriver = {
      acquire: () => acquireGate.promise,
      destroy: () => {},
    };

    const entry = createStubEntry<{ v: number }>({
      data: { v: 0 },
      driver,
    });

    const state: ActionsInternalState = createInitialState();
    const disposedController = new AbortController();
    const options = {} as LockDataOptions<{ v: number }>;

    // 1) 启动 performAcquire；进入 driver.acquire 的 await
    const acquirePromise = performAcquire(
      { entry, options, releaseFromRegistry: () => {} },
      state,
      disposedController.signal,
      undefined,
      false,
    );

    // 2) 等下一轮 microtask，让 performAcquire 执行到 await driver.acquire
    //    （此时 state.aliveToken 已被设置为 currentToken）
    await Promise.resolve();
    expect(state.aliveToken).not.toBe('');
    const tokenBeforeRevoke = state.aliveToken;

    // 3) 模拟"自定义 driver 在 acquire 内部回调宿主 revoke 路径"：直接清空 aliveToken
    //    （等价于 handleRevoke 改写后的状态，但跳过了 handle 路径，命中防御性兜底）
    state.aliveToken = '';

    // 4) 让 driver.acquire 成功 resolve；此后进入 `state.aliveToken !== token` 分支
    acquireGate.resolve({
      release: () => {
        releaseCount++;
      },
      onRevokedByDriver: () => {},
    });

    await expect(acquirePromise).rejects.toBeInstanceOf(LockRevokedError);
    await expect(acquirePromise).rejects.toThrow('lock revoked before activation');

    // safeReleaseHandle 必须被调用：handle 不能泄漏
    expect(releaseCount).toBe(1);

    // state 不应再持有 currentHandle
    expect(state.currentHandle).toBeNull();
    // tokenBeforeRevoke 引用仍可用（确保上一步断言读到的是 acquiring 期 token）
    expect(typeof tokenBeforeRevoke).toBe('string');
    expect(tokenBeforeRevoke.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. aliveToken 与 disposed 同时命中：disposed 优先抛 LockDisposedError
//    （LockRevokedError 分支不被触达 —— 守护原始优先级语义）
// ---------------------------------------------------------------------------

describe('performAcquire / disposed + aliveToken 同时变更', () => {
  test('disposed=true 优先于 aliveToken 改写 → 抛 LockDisposedError 而非 LockRevokedError', async () => {
    let releaseCount = 0;
    const acquireGate = withResolvers<LockDriverHandle>();

    const driver: LockDriver = {
      acquire: () => acquireGate.promise,
      destroy: () => {},
    };

    const entry = createStubEntry<{ v: number }>({
      data: { v: 0 },
      driver,
    });

    const state: ActionsInternalState = createInitialState();
    const disposedController = new AbortController();
    const options = {} as LockDataOptions<{ v: number }>;

    const acquirePromise = performAcquire(
      { entry, options, releaseFromRegistry: () => {} },
      state,
      disposedController.signal,
      undefined,
      false,
    );

    await Promise.resolve();

    // 同时变更：disposed=true + aliveToken 改写
    state.disposed = true;
    state.aliveToken = '';

    acquireGate.resolve({
      release: () => {
        releaseCount++;
      },
      onRevokedByDriver: () => {},
    });

    await expect(acquirePromise).rejects.toBeInstanceOf(LockDisposedError);
    // handle 仍被释放（safeReleaseHandle 在 if 分支入口就调用，与抛错类型无关）
    expect(releaseCount).toBe(1);
  });
});
