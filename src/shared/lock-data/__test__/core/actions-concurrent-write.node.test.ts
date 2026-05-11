/**
 * 回归测试：actions 实例对未 await 的并发写操作必须串行化
 *
 * 对应修复方案：src/shared/lock-data/fixes/concurrent-acquire-serialize.md
 *
 * 缺陷复现路径（修复前）：
 *   const p1 = actions.update(recipe1);  // phase=acquiring，token=A
 *   const p2 = actions.update(recipe2);  // phase=acquiring（覆写 token=B、currentHandle 被覆盖）
 *   →  p1 拒绝伪 LockRevokedError 或 driver handle 泄漏
 *
 * 测试场景（5 组）：
 *   1. acquiring 期间重入 update：driver.acquire 被暂停 → 同时发 update#1 + update#2
 *      → 断言两次都成功 commit、commit 顺序严格 `#1`→#2、不出现伪 onRevoked、driver.acquire 调用两次
 *   2. committing 期间重入 update：第一个 update 的 recipe 是 async 阻塞 → 重入第二个 update
 *      → 断言两次都成功、driver.release 调用次数正确（无 handle 泄漏）、entry.rev 自增两次
 *   3. update + replace 交叉：data 最终值是 replace 的值，串行顺序正确
 *   4. update + getLock 交叉：getLock 串行排队并保留锁，driver.acquire 调用两次
 *   5. 排队期间 dispose：update#1 还在 acquiring → update#2 排队 → dispose()
 *      → 断言 update#2 被 reject LockDisposedError（不是 abort/timeout，符合终态契约）
 *
 * 选用 node 环境：actions 不依赖浏览器 API；driver stub 暂停模式在 node 环境下时序更稳定
 */

import { describe, expect, test, vi } from 'vitest';
import type { ResolvedAdapters } from '@/shared/lock-data/adapters/index';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { createActions } from '@/shared/lock-data/core/actions';
import type { Entry } from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/index';
import { LockDisposedError } from '@/shared/lock-data/errors';
import type { LockDataListeners, LockDataOptions, LockDriverContext, LockDriverHandle } from '@/shared/lock-data/types';

// ---------------------------------------------------------------------------
// stub 构造（支持 pauseNextAcquire / async release 计数）
// ---------------------------------------------------------------------------

interface StubDriverController {
  readonly driver: LockDriver;
  /** 暂停下一个 acquire 直到 resumeAcquire() 被调用；返回该次 acquire 的 ctx 用于断言 */
  pauseNextAcquire: () => () => void;
  acquireCount: number;
  releaseCount: number;
}

function createStubDriver(): StubDriverController {
  let acquireCount = 0;
  let releaseCount = 0;
  // 待发放的 pause gate：每次调用 pauseNextAcquire() 入队一个 gate；
  // acquire 触发时若队列非空则等待 gate.promise，否则立即 resolve
  const gates: Array<{ promise: Promise<void>; resume: () => void }> = [];

  const makeHandle = (): LockDriverHandle => {
    let revokeCb: ((reason: 'force' | 'timeout') => void) | null = null;
    return {
      release: (): void => {
        releaseCount++;
        revokeCb = null;
      },
      onRevokedByDriver: (cb): void => {
        revokeCb = cb;
      },
    } as LockDriverHandle & { _revoke?: typeof revokeCb };
  };

  const driver: LockDriver = {
    acquire: async (ctx: LockDriverContext): Promise<LockDriverHandle> => {
      acquireCount++;
      const gate = gates.shift();
      if (gate) {
        // signal abort 时立即 reject AbortError（与真实 driver 行为对齐：
        // 实例 dispose 时 disposedController.abort 会通过 ctx.signal 触达，
        // driver 必须立即 reject 让 in-flight acquire 解开等待）
        await new Promise<void>((resolve, reject) => {
          gate.promise.then(resolve);
          if (ctx.signal) {
            const onAbort = (): void => {
              reject(new DOMException('aborted', 'AbortError'));
            };
            if (ctx.signal.aborted) {
              onAbort();
            } else {
              ctx.signal.addEventListener('abort', onAbort, { once: true });
            }
          }
        });
      }
      return makeHandle();
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
    pauseNextAcquire: (): (() => void) => {
      let resume!: () => void;
      const promise = new Promise<void>((resolve) => {
        resume = resolve;
      });
      gates.push({ promise, resume });
      return resume;
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
}

function createStubEntry<T extends object>(opts: StubEntryOptions<T>): Entry<T> {
  const listenersSet = new Set<LockDataListeners<T>>();
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

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('actions / 并发写操作必须串行化（修复回归）', () => {
  test('acquiring 期间重入 update：两次都成功，commit 顺序严格 #1→#2，不出现伪 onRevoked', async () => {
    const driverCtl = createStubDriver();
    const onRevoked = vi.fn();
    const onCommitOrder: number[] = [];
    const { entry, actions } = buildActions<{ v: number }>(
      { data: { v: 0 }, driver: driverCtl.driver },
      {
        listeners: {
          onRevoked,
          onCommit: (event): void => {
            onCommitOrder.push(event.rev);
          },
        },
      },
    );

    // 暂停下一个 acquire，让 update#1 卡在 await driver.acquire
    const resume = driverCtl.pauseNextAcquire();

    // 同时发 update#1 + update#2（不 await #1）
    const p1 = actions.update((draft) => {
      draft.v = 1;
    });
    const p2 = actions.update((draft) => {
      draft.v = 2;
    });

    // 让 update#1 拿到 handle
    resume();
    await Promise.all([p1, p2]);

    // 关键断言 1：两次都成功 commit，rev 自增两次
    expect(entry.rev).toBe(2);
    expect(entry.dataRef.current.v).toBe(2);
    // 关键断言 2：commit 顺序严格 #1→#2（rev 递增序列）
    expect(onCommitOrder).toEqual([1, 2]);
    // 关键断言 3：未触发任何伪 onRevoked（修复前 update#1 会被 update#2 篡位 → 拿到 LockRevokedError + onRevoked 触发）
    expect(onRevoked).not.toHaveBeenCalled();
    // 关键断言 4：每次 update 各自走完整 acquire→commit→release 循环（acquiredByGetLock=false
    // 路径下 maybeAutoRelease 在 task 内部释放锁，下一个排队 update 重新 acquire）
    // 修复前的 bug 不在 acquire 次数，而在 update#1 被 update#2 篡位 → 伪 onRevoked + handle 泄漏
    expect(driverCtl.acquireCount).toBe(2);
    expect(driverCtl.releaseCount).toBe(2);
  });

  test('committing 期间重入 update：两次都成功，无 handle 泄漏，rev 自增两次', async () => {
    const driverCtl = createStubDriver();
    const { entry, actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
    });

    // 第一个 update 的 recipe 是 async 阻塞，模拟 committing 阶段长时间停留
    let resolveRecipe1!: () => void;
    const recipe1Promise = new Promise<void>((resolve) => {
      resolveRecipe1 = resolve;
    });
    const p1 = actions.update(async (draft) => {
      await recipe1Promise;
      draft.v = 1;
    });

    // 等 update#1 进入 committing 阶段（acquire 已成功 + recipe 已启动）
    await Promise.resolve();
    await Promise.resolve();

    // 重入 update#2（修复前会进 performAcquire 覆盖 currentHandle，造成 handle#A 泄漏）
    const p2 = actions.update((draft) => {
      draft.v = 2;
    });

    // 释放 recipe#1，让 update#1 完成 commit
    resolveRecipe1();
    await Promise.all([p1, p2]);

    // 关键断言 1：两次都成功 commit（修复前 update#1 在 commit 时会发现 aliveToken 被
    // update#2 改写 → 抛 LockRevokedError → 事务 rollback，rev 不会到 2）
    expect(entry.rev).toBe(2);
    expect(entry.dataRef.current.v).toBe(2);
    // 关键断言 2：每个 update 各自 acquire+release 一次，无 handle 泄漏
    // 修复前 committing 期间重入会让 handle#A 被 handle#B 覆盖 → release 计数不平衡
    // （只调用过 handle#B.release，handle#A 永远悬挂）
    expect(driverCtl.acquireCount).toBe(2);
    expect(driverCtl.releaseCount).toBe(2);
  });

  test('update + replace 交叉：串行执行，data 最终值是 replace 的值', async () => {
    const driverCtl = createStubDriver();
    const { entry, actions } = buildActions<{ v: number; tag: string }>({
      data: { v: 0, tag: 'init' },
      driver: driverCtl.driver,
    });

    const resume = driverCtl.pauseNextAcquire();

    const p1 = actions.update((draft) => {
      draft.v = 100;
    });
    const p2 = actions.replace({ v: 999, tag: 'replaced' });

    resume();
    await Promise.all([p1, p2]);

    // 关键断言：replace 在 update 之后串行执行，最终值是 replace 写入的对象
    expect(entry.rev).toBe(2);
    expect(entry.dataRef.current).toEqual({ v: 999, tag: 'replaced' });
    // 串行后两次操作各自 acquire→release（与场景 1/2 一致）
    expect(driverCtl.acquireCount).toBe(2);
    expect(driverCtl.releaseCount).toBe(2);
  });

  test('update + getLock 交叉：getLock 串行排队后保留锁，driver.acquire 调用两次', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
    });

    const resume = driverCtl.pauseNextAcquire();

    const p1 = actions.update((draft) => {
      draft.v = 1;
    });
    const p2 = actions.getLock();

    resume();
    await Promise.all([p1, p2]);

    // 关键断言 1：update 完成后 release，getLock 排到时重新 acquire（串行各自抢锁）
    expect(driverCtl.acquireCount).toBe(2);
    // 关键断言 2：update 自动 release 一次，getLock 后保留锁（acquiredByGetLock=true）
    expect(driverCtl.releaseCount).toBe(1);
    expect(actions.isHolding).toBe(true);

    // 主动 release 收尾：getLock 留下的锁被释放
    actions.release();
    expect(actions.isHolding).toBe(false);
    expect(driverCtl.releaseCount).toBe(2);
  });

  test('排队期间 dispose：排队中的 update 必须 reject LockDisposedError（不是 abort/timeout）', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
    });

    // 让第一个 update 一直卡在 acquire（不 resume），制造排队场景
    driverCtl.pauseNextAcquire();

    const p1 = actions.update((draft) => {
      draft.v = 1;
    });
    const p2 = actions.update((draft) => {
      draft.v = 2;
    });

    // 提前挂上 catch 避免 unhandled rejection 噪音；具体断言下方再做
    const p1Settled = p1.catch((error: unknown) => error);
    const p2Settled = p2.catch((error: unknown) => error);

    // 让两个 update 都进入串行链等待状态
    await Promise.resolve();
    await Promise.resolve();

    // 触发 dispose：
    // - update#1 在 await driver.acquire 阶段，disposedController.abort 通过 ctx.signal
    //   触达 stub driver gate，立即 reject AbortError → performAcquire catch 路径在
    //   state.disposed 下走 throwDisposed（dispose-race 修复条目）→ p1 抛 LockDisposedError
    // - update#2 排队中，等 update#1 的 task settle 后轮到自己执行 ensureAlive()
    //   命中 state.disposed = true → 抛 LockDisposedError（disposed 终态契约）
    await actions.dispose();

    // 关键断言：两个 update 都按 disposed 终态契约抛 LockDisposedError
    // 修复前若不串行化，update#2 会进入 performAcquire 覆盖 currentToken，
    // 拿到 abort/timeout 错误而不是 LockDisposedError
    const p2Result = await p2Settled;
    expect(p2Result).toBeInstanceOf(LockDisposedError);

    // p1 的错误类型由 dispose-race 修复条目保证（state.disposed 时 throwDisposed），
    // 这里只兜底校验不抛 unhandled rejection
    await p1Settled;
  });
});
