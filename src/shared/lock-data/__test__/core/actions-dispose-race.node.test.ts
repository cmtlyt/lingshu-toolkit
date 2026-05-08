/**
 * 回归测试：performAcquire catch 路径在 dispose-race 下必须保留 disposed 终态
 *
 * 对应修复方案：src/shared/lock-data/fixes/dispose-race-acquire-catch.md
 *
 * 缺陷复现路径：
 *   const promise = actions.update(recipe);  // → driver.acquire 在 await 中
 *   await actions.dispose();                  // → disposedController.abort()
 *   // → driver 监听 ctx.signal 立即 reject AbortError
 *   // → performAcquire catch（旧实现）：transitionTo(idle) + throw LockAbortedError
 *   await promise;  // ❌ 拒绝时是 LockAbortedError 而非 LockDisposedError
 *
 * 修复点：performAcquire 的 catch 起始处补 if (state.disposed) throwDisposed(error)
 *
 * 选用 node 环境：actions 不依赖浏览器 API；用 AbortController.signal 监听完成时序控制
 */

import { describe, expect, test, vi } from 'vitest';
import type { ResolvedAdapters } from '@/shared/lock-data/adapters/index';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { createActions } from '@/shared/lock-data/core/actions';
import type { Entry } from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/index';
import { LockAbortedError, LockDisposedError } from '@/shared/lock-data/errors';
import type {
  LockDataListeners,
  LockDataOptions,
  LockDriverContext,
  LockDriverHandle,
  LockStateChangeEvent,
} from '@/shared/lock-data/types';

// ---------------------------------------------------------------------------
// stub 构造（增强版：driver 监听 ctx.signal 并在 abort 时 reject）
// ---------------------------------------------------------------------------

interface StubDriverController {
  readonly driver: LockDriver;
  /** 切换为「不自动 resolve」模式；后续 acquire 需要手动 resolve / 由 signal abort 触发 reject */
  pauseNextAcquire: () => void;
  /** 手动 resolve 当前 pending acquire（默认模式不需要调用） */
  resolveCurrentAcquire: () => void;
  /** 让 driver 在收到 abort 信号时是否 reject（缺陷复现需要 true）；默认 true */
  setRejectOnAbort: (value: boolean) => void;
  acquireCount: number;
  releaseCount: number;
}

function createStubDriver(): StubDriverController {
  let releaseCount = 0;
  let acquireCount = 0;
  let pauseMode = false;
  let rejectOnAbort = true;
  let pendingResolve: ((handle: LockDriverHandle) => void) | null = null;
  let pendingReject: ((error: unknown) => void) | null = null;

  const makeHandle = (): LockDriverHandle => {
    return {
      release: (): void => {
        releaseCount++;
      },
      onRevokedByDriver: (): void => {
        /* no-op */
      },
    };
  };

  const driver: LockDriver = {
    acquire: (ctx: LockDriverContext) => {
      acquireCount++;

      if (!pauseMode) {
        return Promise.resolve(makeHandle());
      }

      pauseMode = false;
      return new Promise<LockDriverHandle>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
        if (!rejectOnAbort) {
          return;
        }
        const onAbort = (): void => {
          const reason = ctx.signal.reason;
          pendingReject?.(reason || new DOMException('aborted', 'AbortError'));
          pendingResolve = null;
          pendingReject = null;
          ctx.signal.removeEventListener('abort', onAbort);
        };
        if (ctx.signal.aborted) {
          onAbort();
        } else {
          ctx.signal.addEventListener('abort', onAbort);
        }
      });
    },
    destroy: (): void => {
      /* no-op */
    },
  };

  return {
    driver,
    get acquireCount(): number {
      return acquireCount;
    },
    get releaseCount(): number {
      return releaseCount;
    },
    pauseNextAcquire: (): void => {
      pauseMode = true;
    },
    resolveCurrentAcquire: (): void => {
      if (pendingResolve) {
        const resolver = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolver(makeHandle());
      }
    },
    setRejectOnAbort: (value: boolean): void => {
      rejectOnAbort = value;
    },
  };
}

function createStubAdapters<T>(): ResolvedAdapters<T> {
  const logger = resolveLoggerAdapter({
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  return {
    logger,
    getAuthority: () => null,
    getChannel: () => null,
    getSessionStore: () => null,
    getLock: undefined,
  };
}

interface StubEntryOptions<T extends object> {
  readonly data: T;
  readonly driver: LockDriver;
  readonly listeners?: LockDataListeners<T>;
}

function createStubEntry<T extends object>(opts: StubEntryOptions<T>): Entry<T> {
  const listenersSet = new Set<LockDataListeners<T>>();
  if (opts.listeners) {
    listenersSet.add(opts.listeners);
  }
  const dataRef = { current: opts.data };
  return {
    id: 'test-id',
    lockId: 'test-id',
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

// 测试辅助类型：只读 listeners / signal 两个字段，避免 LockDataOptions 的 getValue 必传约束
type BuildActionsOptions<T extends object> = Pick<LockDataOptions<T>, 'listeners' | 'signal'>;

function buildActions<T extends object>(
  entryOpts: StubEntryOptions<T>,
  options: BuildActionsOptions<T> = {},
): {
  entry: Entry<T>;
  actions: ReturnType<typeof createActions<T>>;
} {
  const entry = createStubEntry(entryOpts);
  if (options.listeners) {
    entry.listenersSet.add(options.listeners);
  }
  const actions = createActions<T>({
    entry,
    options: options as LockDataOptions<T>,
    releaseFromRegistry: vi.fn(),
  });
  return { entry, actions };
}

/** 让 microtask 队列流转一轮，确保 actions 内部 await 链路推进 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('actions / dispose 与 in-flight acquire 竞争（修复回归）', () => {
  test('update 启动 → dispose → catch 路径必须抛 LockDisposedError 而非 LockAbortedError', async () => {
    const driverCtl = createStubDriver();
    driverCtl.pauseNextAcquire();
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
    });

    // 1. 启动 update：performAcquire 进入 await driver.acquire
    const updatePromise = actions.update((draft) => {
      draft.v = 1;
    });

    // 2. 等 microtask 让 acquire 真正进入 pending
    await flushMicrotasks();

    // 3. dispose：触发 disposedController.abort → driver reject AbortError
    //    → performAcquire 进入 catch；修复后必须走 throwDisposed 分支
    await actions.dispose();

    // 4. 关键断言：update 的 reject 必须是 LockDisposedError（不是 LockAbortedError）
    await expect(updatePromise).rejects.toThrow(LockDisposedError);
    await expect(updatePromise).rejects.not.toThrow(LockAbortedError);
  });

  test('dispose 终态后 onLockStateChange 不再回退到 idle', async () => {
    const driverCtl = createStubDriver();
    driverCtl.pauseNextAcquire();
    const phases: LockStateChangeEvent['phase'][] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: {
        onLockStateChange: (evt) => phases.push(evt.phase),
      },
    });

    const updatePromise = actions.update((draft) => {
      draft.v = 1;
    });
    await flushMicrotasks();
    await actions.dispose();

    // 让 catch 路径的 throw 完成 microtask
    await expect(updatePromise).rejects.toThrow(LockDisposedError);

    // 关键断言：phases 序列里 'disposed' 之后不应再有 'idle'
    const lastPhase = phases[phases.length - 1];
    expect(lastPhase).toBe('disposed');
    expect(phases).not.toContain('idle');

    // 完整序列形态校验：acquiring → disposed（中间不应该出现 holding 或回退 idle）
    expect(phases).toEqual(['acquiring', 'disposed']);
  });

  test('反向校验：callOpts.signal abort（不触发 dispose）仍走 idle + LockAbortedError', async () => {
    const driverCtl = createStubDriver();
    driverCtl.pauseNextAcquire();
    const phases: LockStateChangeEvent['phase'][] = [];

    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: {
        onLockStateChange: (evt) => phases.push(evt.phase),
      },
    });

    // 用 callOpts.signal（不会触发 attachSignalAutoDispose）
    const callController = new AbortController();
    const updatePromise = actions.update(
      (draft) => {
        draft.v = 1;
      },
      { signal: callController.signal },
    );
    await flushMicrotasks();

    // 仅 abort 这次调用的 signal，不 dispose 实例
    callController.abort();

    // 关键断言 1：拒绝错误是 LockAbortedError 而非 LockDisposedError
    await expect(updatePromise).rejects.toThrow(LockAbortedError);
    // 关键断言 2：phase 回到 idle（正常失败路径未被修复误伤）
    expect(phases).toEqual(['acquiring', 'idle']);
    // 实例仍可继续使用（未 disposed）
    expect(actions.isHolding).toBe(false);
  });
});
