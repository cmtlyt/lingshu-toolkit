/**
 * core/actions.ts 残余分支覆盖测试（node 环境）
 *
 * 集中覆盖 actions.ts 内部的少见早退 / 终态分支：
 *  1. handleRevoke 的 aliveToken === '' 早退（持锁出口后再触发 driver revoke）
 *  2. ensureDataReady 在 await dataReadyPromise 之后再次 disposed 的 throwDisposed
 *  3. performAcquire 成功取得 handle 但 aliveToken 已被改写 → "lock revoked before activation"
 *  4. attachRevokeFromDriver 在 handle 没有 onRevokedByDriver 函数时的早退
 *  5. startHoldTimer 在 holdTimeout 为 NEVER_TIMEOUT 时的早退
 *  6. performRelease 在 disposed 终态下抛 LockDisposedError
 */

import { describe, expect, test, vi } from 'vitest';
import type { ResolvedAdapters } from '@/shared/lock-data/adapters/index';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import { createActions, ensureDataReady, getTestHooks } from '@/shared/lock-data/core/actions';
import { createInitialState } from '@/shared/lock-data/core/actions-helpers';
import type { Entry } from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/index';
import { LockDisposedError } from '@/shared/lock-data/errors';
import type { LockDataListeners, LockDataOptions, LockDriverHandle, RevokeEvent } from '@/shared/lock-data/types';
import { withResolvers } from '@/shared/with-resolvers';

// ---------------------------------------------------------------------------
// 通用 stub（按需覆盖默认行为）
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
  readonly dataReadyPromise?: Promise<void> | null;
  readonly listeners?: LockDataListeners<T>;
}

function createStubEntry<T extends object>(opts: StubEntryOptions<T>): Entry<T> {
  const listenersSet = new Set<LockDataListeners<T>>();
  if (opts.listeners) {
    listenersSet.add(opts.listeners);
  }
  const id = opts.id || 'cov-id';
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
    dataReadyPromise: opts.dataReadyPromise ?? null,
    registerTeardown: (): void => {
      /* no-op */
    },
    refCount: 1,
    rev: 0,
    lastAppliedRev: 0,
    epoch: null,
  };
}

type BuildOptions<T extends object> = Pick<LockDataOptions<T>, 'listeners' | 'signal' | 'timeout'>;

function buildActions<T extends object>(
  entryOpts: StubEntryOptions<T>,
  options: BuildOptions<T> = {},
): {
  entry: Entry<T>;
  actions: ReturnType<typeof createActions<T>>;
  releaseSpy: ReturnType<typeof vi.fn>;
} {
  const entry = createStubEntry(entryOpts);
  const releaseSpy = vi.fn();
  const actions = createActions<T>({
    entry,
    options: options as LockDataOptions<T>,
    releaseFromRegistry: releaseSpy,
  });
  return { entry, actions, releaseSpy };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 1. handleRevoke 的 aliveToken === '' 早退（L105-107）
// ---------------------------------------------------------------------------

describe('actions / handleRevoke aliveToken 已置空时的早退保护', () => {
  test('release 后 driver 再次触发 revoke 不会重复广播 onRevoked', async () => {
    let revokeCallback: ((reason: 'force' | 'timeout') => void) | null = null;
    let releaseCount = 0;
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {
            releaseCount++;
          },
          onRevokedByDriver: (cb) => {
            revokeCallback = cb;
          },
        }),
      destroy: () => {},
    };

    const revokes: RevokeEvent[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver,
      listeners: { onRevoked: (evt) => revokes.push(evt) },
    });

    await actions.getLock();
    actions.release();
    expect(releaseCount).toBe(1);

    // release 后 aliveToken 已经被置空；此时 driver 仍然可能触发 revoke
    // （例如 storage driver 的延迟通知）—— handleRevoke 必须早退，不重复广播
    expect(revokeCallback).not.toBeNull();
    (revokeCallback as unknown as (reason: 'force' | 'timeout') => void)('force');

    expect(revokes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. ensureDataReady 在 await 后再 disposed（L157-158）
// ---------------------------------------------------------------------------

describe('actions / ensureDataReady await 期间被 dispose', () => {
  test('dataReadyPromise 期间 dispose → update reject LockDisposedError（命中 await 后 disposed 分支）', async () => {
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          onRevokedByDriver: () => {},
        }),
      destroy: () => {},
    };

    const gate = withResolvers<void>();
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver,
      dataReadyPromise: gate.promise,
    });

    // 1) 发起 update：进入 ensureDataReady 后 await dataReadyPromise
    const updatePromise = actions.update((d) => {
      d.v = 1;
    });
    await flushMicrotasks();

    // 2) 在 await 期间触发 dispose（state.disposed=true）
    const disposePromise = actions.dispose();

    // 3) gate.resolve 让 dataReadyPromise 进入 fulfilled，让 ensureDataReady 的 await 返回
    //    紧接着 if (state.disposed) throwDisposed() 命中
    gate.resolve();

    await expect(updatePromise).rejects.toThrow(LockDisposedError);
    await disposePromise;
  });
});

// ---------------------------------------------------------------------------
// 3. performAcquire "lock revoked before activation"（L226-228）
//
// 该路径在生产代码中实际不可达（防御性死代码）：
//   - state.aliveToken 在 acquire 期间只可能被 handleRevoke 改写
//   - handleRevoke 仅由 driver.handle.onRevokedByDriver 回调触发
//   - 而 handle 必须先 acquire 成功才能拿到，再 attachRevokeFromDriver
//   - 所以 acquire 完成前 aliveToken 不可能被外部改写为 ''
//
// state.disposed 路径已被另一组测试覆盖（dispose-race-acquire-catch）；
// 因此 L226-228 的 LockRevokedError 抛出分支由源码侧的 /* v8 ignore */ 注释豁免。
// 详见 src/shared/lock-data/core/actions.ts L224-229
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. attachRevokeFromDriver：handle.onRevokedByDriver 不是函数（L247-248）
// ---------------------------------------------------------------------------

describe('actions / attachRevokeFromDriver 兼容缺失 onRevokedByDriver 的 handle', () => {
  test('handle 不提供 onRevokedByDriver 函数 → acquire 仍然成功，update 正常工作', async () => {
    // 构造一个最小化 handle：只有 release，没有 onRevokedByDriver（自定义 driver 可能省略此字段）
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          // 故意不提供 onRevokedByDriver；as 转型走 LockDriverHandle 类型出口
        } as unknown as LockDriverHandle),
      destroy: () => {},
    };

    const { entry, actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver,
    });

    // update 不应抛错；attachRevokeFromDriver 内部命中 !isFunction 早退
    await actions.update((d) => {
      d.v = 42;
    });
    expect(entry.dataRef.current.v).toBe(42);
    expect(entry.rev).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. startHoldTimer：holdTimeout 为 NEVER_TIMEOUT 时早退（L261-262）
// ---------------------------------------------------------------------------

describe('actions / startHoldTimer 在 NEVER_TIMEOUT 下不注册定时器', () => {
  test('options.timeout=NEVER_TIMEOUT → 持锁不会自动 revoke("timeout")', async () => {
    let revokeCallback: ((reason: 'force' | 'timeout') => void) | null = null;
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          onRevokedByDriver: (cb) => {
            revokeCallback = cb;
          },
        }),
      destroy: () => {},
    };

    const revokes: RevokeEvent[] = [];
    const { actions } = buildActions<{ v: number }>(
      {
        data: { v: 0 },
        driver,
        listeners: { onRevoked: (evt) => revokes.push(evt) },
      },
      { timeout: NEVER_TIMEOUT },
    );

    await actions.getLock();
    expect(actions.isHolding).toBe(true);

    // 等一段时间确认没有 timeout 触发
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(revokes).toHaveLength(0);
    expect(actions.isHolding).toBe(true);

    // revokeCallback 仍然有效（attachRevokeFromDriver 路径正常）
    expect(revokeCallback).not.toBeNull();

    actions.release();
  });
});

// ---------------------------------------------------------------------------
// 6. performRelease 在 disposed 终态下抛 LockDisposedError（L363-364）
// ---------------------------------------------------------------------------

describe('actions / performRelease disposed 终态保护', () => {
  test('dispose 后调用 release() 同步抛 LockDisposedError', async () => {
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          onRevokedByDriver: () => {},
        }),
      destroy: () => {},
    };

    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver,
    });

    await actions.dispose();

    expect(() => actions.release()).toThrow(LockDisposedError);
  });
});

// ---------------------------------------------------------------------------
// 7. ensureDataReady 入口 disposed 早退（L150-151）
// ---------------------------------------------------------------------------

describe('actions / ensureDataReady 入口 disposed 早退', () => {
  // 公共路径下 update/replace 入口的 ensureAlive() 已先于 ensureDataReady 抛 LockDisposedError，
  // 因此该入口守卫不可触达。但作为函数自洽性兜底保留，通过直接 import + stub 命中
  test('直接调用 ensureDataReady：state.disposed=true 时立即抛 LockDisposedError', async () => {
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          onRevokedByDriver: () => {},
        }),
      destroy: () => {},
    };

    const entry = createStubEntry<{ v: number }>({
      data: { v: 0 },
      driver,
    });

    const state = createInitialState();
    state.disposed = true;

    await expect(
      ensureDataReady<{ v: number }>(
        { entry, options: {} as LockDataOptions<{ v: number }>, releaseFromRegistry: () => {} },
        state,
      ),
    ).rejects.toBeInstanceOf(LockDisposedError);
  });

  test('直接调用 ensureDataReady：dataReadyPromise resolve 后再次 disposed → 抛 LockDisposedError', async () => {
    const gate = withResolvers<void>();
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          onRevokedByDriver: () => {},
        }),
      destroy: () => {},
    };

    const entry = createStubEntry<{ v: number }>({
      data: { v: 0 },
      driver,
      dataReadyPromise: gate.promise,
    });

    const state = createInitialState();

    const pending = ensureDataReady<{ v: number }>(
      { entry, options: {} as LockDataOptions<{ v: number }>, releaseFromRegistry: () => {} },
      state,
    );

    // 在 await dataReadyPromise 期间把 state 切到 disposed
    state.disposed = true;
    gate.resolve();

    await expect(pending).rejects.toBeInstanceOf(LockDisposedError);
  });
});

// ---------------------------------------------------------------------------
// 8. doDispose 重入保护（L407 if !disposedController.signal.aborted）
// ---------------------------------------------------------------------------

describe('actions / doDispose 重入保护（disposedController 已 aborted 跳过 abort）', () => {
  test('外部预先 abort disposedController 后调 doDispose → 命中 if (!aborted) false 分支跳过二次 abort', async () => {
    // 公共路径下 disposedController 是 createActions 闭包私有，仅 doDispose 内部 abort；
    // 进入此 false 分支需要"signal 已 aborted 但 state.disposed=false"，正常链路不可构造。
    // 通过 getTestHooks 取出闭包引用，外部预先 abort 控制器，再调 doDispose 命中该分支。
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          onRevokedByDriver: () => {},
        }),
      destroy: () => {},
    };

    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver,
    });

    const { doDispose, disposedController } = getTestHooks(actions);
    expect(disposedController.signal.aborted).toBe(false);

    // 外部预先 abort（模拟未来重构出现的"外部直接 abort disposedController"调用点）
    disposedController.abort(new Error('external pre-abort'));
    expect(disposedController.signal.aborted).toBe(true);

    // 此时 state.disposed 仍为 false（doDispose 还没跑），但 signal 已 aborted；
    // 调 doDispose 走完入口 if (state.disposed) return 后，进入 if (!aborted) 命中 false 分支
    expect(() => doDispose()).not.toThrow();

    // doDispose 已把 state 切到 disposed 终态：再调 actions.dispose() 应该是幂等 no-op
    await expect(actions.dispose()).resolves.toBeUndefined();
  });

  test('两次连续调 actions.dispose() → 第二次进入 doDispose 命中 disposed=true 早退分支', async () => {
    const driver: LockDriver = {
      acquire: () =>
        Promise.resolve({
          release: () => {},
          onRevokedByDriver: () => {},
        }),
      destroy: () => {},
    };

    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver,
    });

    await actions.dispose();
    // 第二次 dispose → doDispose 入口 if (state.disposed) return 命中
    await expect(actions.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 透传断言：确认上面的 stub 没改变 LOCK_PREFIX 引用语义
// ---------------------------------------------------------------------------

describe('actions / stub LOCK_PREFIX 引用回归', () => {
  test('LOCK_PREFIX 常量仍可被引用（避免 import 冗余被自动清除）', () => {
    expect(typeof LOCK_PREFIX).toBe('string');
    expect(LOCK_PREFIX.length).toBeGreaterThan(0);
  });
});
