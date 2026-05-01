/**
 * core/actions.ts 单元测试（browser 环境，真实 AbortController / setTimeout / queueMicrotask）
 *
 * 覆盖契约：
 * 1. 基础写入：update 成功 / update 抛错 rollback / replace 结构替换
 * 2. 状态机流转：phase 序列 idle → acquiring → holding → committing → holding → released → idle
 * 3. 自动 release：update 后自动 release；getLock + update 后保持持锁；release 幂等
 * 4. dispose：disposed 终态抛 LockDisposedError；dispose 自动 release；幂等
 * 5. signal 自动 dispose：options.signal abort → 自动 dispose（延迟 microtask）
 * 6. acquireTimeout：driver 不 resolve → 到期抛 LockTimeoutError
 * 7. driver revoke（onRevokedByDriver('force')）：aliveToken 失效；commit 期触发 LockRevokedError + rollback
 * 8. holdTimeout：持锁期自动 revoke('timeout') + 广播 onRevoked
 * 9. dataReady 失败：failed 态下 update 抛 LockDisposedError
 * 10. authority：有 authority 时 pullOnAcquire + onCommitSuccess 被调用；无 authority 时直接 fanoutCommit
 * 11. read：深克隆；disposed 后抛错
 * 12. replace 结构不一致抛 TypeError
 */

/** biome-ignore-all lint/nursery/useGlobalThis: test file uses AbortController/setTimeout */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedAdapters } from '@/shared/lock-data/adapters/index';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import type { StorageAuthority } from '@/shared/lock-data/authority/index';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import { createActions } from '@/shared/lock-data/core/actions';
import type { Entry } from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/index';
import { LockAbortedError, LockDisposedError, LockRevokedError, LockTimeoutError } from '@/shared/lock-data/errors';
import type {
  CommitEvent,
  LockDataListeners,
  LockDataOptions,
  LockDriverContext,
  LockDriverHandle,
  RevokeEvent,
} from '@/shared/lock-data/types';
import { withResolvers } from '@/shared/with-resolvers';

// ---------------------------------------------------------------------------
// stub 构造
// ---------------------------------------------------------------------------

interface StubDriverController {
  readonly driver: LockDriver;
  /** 最近一次 acquire 调用收到的 context */
  lastContext: LockDriverContext | null;
  /** 触发最近一次 driver 的 onRevokedByDriver 回调 */
  triggerRevoke: (reason: 'force' | 'timeout') => void;
  /** 手动 resolve 最近一次 acquire（默认模式是立即 resolve） */
  resolveNextAcquire: () => void;
  /** acquire 计数 */
  acquireCount: number;
  /** handle.release 调用计数 */
  releaseCount: number;
  /** 切换为 "不自动 resolve" 模式；后续 acquire 需要手动 resolve */
  pauseNextAcquire: () => void;
  /** 让下次 acquire 抛指定错误 */
  rejectNextAcquire: (error: unknown) => void;
}

function createStubDriver(): StubDriverController {
  let revokeCallback: ((reason: 'force' | 'timeout') => void) | null = null;
  let releaseCount = 0;
  let acquireCount = 0;
  let lastContext: LockDriverContext | null = null;

  // 队列化控制：pauseNextAcquire / rejectNextAcquire 影响下次 acquire 的行为
  let pauseMode = false;
  let rejectPayload: { error: unknown } | null = null;
  let pendingResolve: ((handle: LockDriverHandle) => void) | null = null;
  let pendingReject: ((error: unknown) => void) | null = null;

  const makeHandle = (): LockDriverHandle => {
    return {
      release: (): void => {
        releaseCount++;
      },
      onRevokedByDriver: (cb): void => {
        revokeCallback = cb;
      },
    };
  };

  const driver: LockDriver = {
    acquire: (ctx) => {
      acquireCount++;
      lastContext = ctx;
      revokeCallback = null;

      if (rejectPayload) {
        const err = rejectPayload.error;
        rejectPayload = null;
        return Promise.reject(err);
      }

      if (!pauseMode) {
        return Promise.resolve(makeHandle());
      }

      pauseMode = false;
      return new Promise<LockDriverHandle>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
        // 绑定 ctx.signal abort 触发 reject（模拟 driver 对 signal 的响应）
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
      /* no-op for tests */
    },
  };

  return {
    driver,
    get lastContext(): LockDriverContext | null {
      return lastContext;
    },
    get acquireCount(): number {
      return acquireCount;
    },
    get releaseCount(): number {
      return releaseCount;
    },
    triggerRevoke: (reason): void => {
      if (revokeCallback) {
        revokeCallback(reason);
      }
    },
    resolveNextAcquire: (): void => {
      if (pendingResolve) {
        const resolver = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        resolver(makeHandle());
      }
    },
    pauseNextAcquire: (): void => {
      pauseMode = true;
    },
    rejectNextAcquire: (error: unknown): void => {
      rejectPayload = { error };
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
    clone: <V>(value: V): V => {
      if (value === null || typeof value !== 'object') {
        return value;
      }
      return JSON.parse(JSON.stringify(value));
    },
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
  readonly authority?: StorageAuthority<T> | null;
  readonly dataReadyPromise?: Promise<void> | null;
  readonly dataReadyState?: 'pending' | 'ready' | 'failed';
  readonly dataReadyError?: unknown;
  readonly listeners?: LockDataListeners<T>;
}

function createStubEntry<T extends object>(opts: StubEntryOptions<T>): Entry<T> {
  const listenersSet = new Set<LockDataListeners<T>>();
  if (opts.listeners) {
    listenersSet.add(opts.listeners);
  }
  return {
    id: opts.id || 'test-id',
    data: opts.data,
    driver: opts.driver,
    adapters: createStubAdapters<T>(),
    authority: opts.authority === undefined ? null : opts.authority,
    listenersSet,
    initOptions: Object.freeze({
      timeout: undefined,
      mode: undefined,
      syncMode: undefined,
      persistence: undefined,
      sessionProbeTimeout: undefined,
    }),
    dataReadyPromise: opts.dataReadyPromise || null,
    registerTeardown: (): void => {
      /* no-op */
    },
    refCount: 1,
    rev: 0,
    lastAppliedRev: 0,
    epoch: null,
    dataReadyState: opts.dataReadyState || 'ready',
    dataReadyError: opts.dataReadyError,
  };
}

function buildActions<T extends object>(
  entryOpts: StubEntryOptions<T>,
  options: LockDataOptions<T> = {},
): {
  entry: Entry<T>;
  actions: ReturnType<typeof createActions<T>>;
  releaseSpy: ReturnType<typeof vi.fn>;
} {
  const entry = createStubEntry(entryOpts);
  if (options.listeners) {
    entry.listenersSet.add(options.listeners);
  }
  const releaseSpy = vi.fn();
  const actions = createActions<T>({
    entry,
    options,
    releaseFromRegistry: releaseSpy,
  });
  return { entry, actions, releaseSpy };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 1. 基础写入
// ---------------------------------------------------------------------------

describe('actions / 基础写入', () => {
  test('update 成功：data 被修改 + rev++ + fanoutCommit 被触发', async () => {
    const driverCtl = createStubDriver();
    const commitEvents: CommitEvent<{ count: number }>[] = [];
    const listeners: LockDataListeners<{ count: number }> = {
      onCommit: (evt) => commitEvents.push(evt),
    };
    const { entry, actions } = buildActions<{ count: number }>({
      data: { count: 0 },
      driver: driverCtl.driver,
      listeners,
    });

    await actions.update((draft) => {
      draft.count = 10;
    });

    expect(entry.data.count).toBe(10);
    expect(entry.rev).toBe(1);
    expect(entry.lastAppliedRev).toBe(1);
    expect(commitEvents).toHaveLength(1);
    expect(commitEvents[0].source).toBe('update');
    expect(commitEvents[0].rev).toBe(1);
    expect(commitEvents[0].mutations).toEqual([{ path: ['count'], op: 'set', value: 10 }]);
    expect(commitEvents[0].snapshot).toEqual({ count: 10 });
    // snapshot 与 entry.data 是克隆隔离的
    expect(commitEvents[0].snapshot).not.toBe(entry.data);
  });

  test('update 抛错：data 被 rollback + rev 不递增 + 错误原样抛出', async () => {
    const driverCtl = createStubDriver();
    const boom = new Error('recipe boom');
    const { entry, actions } = buildActions<{ count: number }>({ data: { count: 5 }, driver: driverCtl.driver });

    await expect(
      actions.update((draft) => {
        draft.count = 99;
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(entry.data.count).toBe(5);
    expect(entry.rev).toBe(0);
  });

  test('replace：新对象结构同形时原地替换 + 产生 mutations', async () => {
    const driverCtl = createStubDriver();
    const commitEvents: CommitEvent<{ a: number; b?: string }>[] = [];
    const { entry, actions } = buildActions<{ a: number; b?: string }>({
      data: { a: 1, b: 'old' },
      driver: driverCtl.driver,
      listeners: { onCommit: (evt) => commitEvents.push(evt) },
    });

    await actions.replace({ a: 2 });

    expect(entry.data).toEqual({ a: 2 });
    expect(commitEvents).toHaveLength(1);
    expect(commitEvents[0].source).toBe('replace');
  });

  test('replace：结构不一致（对象 vs 数组）抛 TypeError', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<Record<string, number>>({
      data: { a: 1 },
      driver: driverCtl.driver,
    });

    await expect(actions.replace([1, 2, 3] as unknown as Record<string, number>)).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 2. 状态机流转
// ---------------------------------------------------------------------------

describe('actions / 状态机流转', () => {
  test('update 完整流程：idle → acquiring → holding → committing → holding → released → idle', async () => {
    const driverCtl = createStubDriver();
    const phases: string[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: {
        onLockStateChange: (evt) => phases.push(evt.phase),
      },
    });

    await actions.update((draft) => {
      draft.v = 1;
    });

    expect(phases).toEqual(['acquiring', 'holding', 'committing', 'holding', 'released', 'idle']);
  });

  test('getLock + update：不自动 release，phase 停留在 holding', async () => {
    const driverCtl = createStubDriver();
    const phases: string[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: { onLockStateChange: (evt) => phases.push(evt.phase) },
    });

    await actions.getLock();
    await actions.update((draft) => {
      draft.v = 1;
    });

    expect(actions.isHolding).toBe(true);
    // 最后一个事件应为 holding（commit 后），没有 released
    expect(phases[phases.length - 1]).toBe('holding');
    expect(phases).not.toContain('released');

    // 主动 release 后才会 released → idle
    actions.release();
    expect(phases[phases.length - 2]).toBe('released');
    expect(phases[phases.length - 1]).toBe('idle');
  });

  test('release 幂等：非持锁状态调用是 no-op', async () => {
    const driverCtl = createStubDriver();
    const phases: string[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: { onLockStateChange: (evt) => phases.push(evt.phase) },
    });

    actions.release();
    actions.release();
    expect(phases).toEqual([]);
  });

  test('isHolding：holding / committing 为 true，其他 phase 为 false', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({ data: { v: 0 }, driver: driverCtl.driver });

    expect(actions.isHolding).toBe(false);
    await actions.getLock();
    expect(actions.isHolding).toBe(true);
    actions.release();
    expect(actions.isHolding).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. dispose
// ---------------------------------------------------------------------------

describe('actions / dispose', () => {
  test('dispose 后所有写入方法抛 LockDisposedError；releaseFromRegistry 被调用一次', async () => {
    const driverCtl = createStubDriver();
    const { actions, releaseSpy } = buildActions<{ v: number }>({ data: { v: 0 }, driver: driverCtl.driver });

    await actions.dispose();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    await expect(
      actions.update((d) => {
        d.v = 1;
      }),
    ).rejects.toThrow(LockDisposedError);
    await expect(actions.getLock()).rejects.toThrow(LockDisposedError);
    expect(() => actions.read()).toThrow(LockDisposedError);
  });

  test('dispose 幂等：多次调用 releaseFromRegistry 只触发一次', async () => {
    const driverCtl = createStubDriver();
    const { actions, releaseSpy } = buildActions<{ v: number }>({ data: { v: 0 }, driver: driverCtl.driver });

    await actions.dispose();
    await actions.dispose();
    await actions.dispose();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  test('持锁中 dispose：自动 release handle + 广播 onRevoked("dispose") + phase 终态 disposed', async () => {
    const driverCtl = createStubDriver();
    const phases: string[] = [];
    const revokes: RevokeEvent[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: {
        onLockStateChange: (evt) => phases.push(evt.phase),
        onRevoked: (evt) => revokes.push(evt),
      },
    });

    await actions.getLock();
    const releaseBefore = driverCtl.releaseCount;
    await actions.dispose();

    expect(driverCtl.releaseCount).toBe(releaseBefore + 1);
    expect(revokes).toHaveLength(1);
    expect(revokes[0].reason).toBe('dispose');
    expect(phases[phases.length - 1]).toBe('disposed');
  });
});

// ---------------------------------------------------------------------------
// 4. signal 自动 dispose
// ---------------------------------------------------------------------------

describe('actions / signal 自动 dispose', () => {
  test('options.signal.abort → 自动 dispose（释放 refCount）', async () => {
    const driverCtl = createStubDriver();
    const controller = new AbortController();
    const { actions, releaseSpy } = buildActions<{ v: number }>(
      { data: { v: 0 }, driver: driverCtl.driver },
      { signal: controller.signal },
    );

    expect(releaseSpy).not.toHaveBeenCalled();
    controller.abort();
    await flushMicrotasks();

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    await expect(
      actions.update((d) => {
        d.v = 1;
      }),
    ).rejects.toThrow(LockDisposedError);
  });

  test('构造期 signal 已 aborted → 延迟到 microtask 触发 dispose', async () => {
    const driverCtl = createStubDriver();
    const controller = new AbortController();
    controller.abort();

    const { actions, releaseSpy } = buildActions<{ v: number }>(
      { data: { v: 0 }, driver: driverCtl.driver },
      { signal: controller.signal },
    );

    // 同步查询时：构造刚完成，dispose 尚未触发（microtask 未执行）
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(actions.isHolding).toBe(false);

    await flushMicrotasks();
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. acquireTimeout
// ---------------------------------------------------------------------------

describe('actions / acquireTimeout', () => {
  test('driver 挂起 + 到期 → 抛 LockTimeoutError，phase 回到 idle', async () => {
    const driverCtl = createStubDriver();
    driverCtl.pauseNextAcquire();
    const phases: string[] = [];
    const { actions } = buildActions<{ v: number }>(
      {
        data: { v: 0 },
        driver: driverCtl.driver,
        listeners: { onLockStateChange: (evt) => phases.push(evt.phase) },
      },
      { timeout: 30 },
    );

    await expect(actions.getLock()).rejects.toThrow(LockTimeoutError);
    expect(phases).toEqual(['acquiring', 'idle']);
  });

  test('callOptions.acquireTimeout 覆盖 options.timeout', async () => {
    const driverCtl = createStubDriver();
    driverCtl.pauseNextAcquire();
    const { actions } = buildActions<{ v: number }>({ data: { v: 0 }, driver: driverCtl.driver }, { timeout: 60_000 });

    const start = Date.now();
    await expect(actions.getLock({ acquireTimeout: 20 })).rejects.toThrow(LockTimeoutError);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('callOptions.signal abort → 抛 LockAbortedError', async () => {
    const driverCtl = createStubDriver();
    driverCtl.pauseNextAcquire();
    const controller = new AbortController();
    const { actions } = buildActions<{ v: number }>(
      { data: { v: 0 }, driver: driverCtl.driver },
      { timeout: NEVER_TIMEOUT },
    );

    const promise = actions.getLock({ signal: controller.signal });
    // 先让 acquiring 进入 await 态
    await flushMicrotasks();
    controller.abort();

    await expect(promise).rejects.toThrow(LockAbortedError);
  });
});

// ---------------------------------------------------------------------------
// 6. driver revoke（onRevokedByDriver）
// ---------------------------------------------------------------------------

describe('actions / driver revoke', () => {
  test('持锁后 driver.triggerRevoke("force")：aliveToken 失效 + 广播 onRevoked + driver.release 被调用', async () => {
    const driverCtl = createStubDriver();
    const revokes: RevokeEvent[] = [];
    const phases: string[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: {
        onLockStateChange: (evt) => phases.push(evt.phase),
        onRevoked: (evt) => revokes.push(evt),
      },
    });

    await actions.getLock();
    const releaseBefore = driverCtl.releaseCount;
    driverCtl.triggerRevoke('force');

    expect(revokes).toHaveLength(1);
    expect(revokes[0].reason).toBe('force');
    expect(driverCtl.releaseCount).toBe(releaseBefore + 1);
    expect(phases[phases.length - 1]).toBe('revoked');
    expect(actions.isHolding).toBe(false);
  });

  test('recipe 执行期被 revoke：recipe resolve 后抛 LockRevokedError + data rollback', async () => {
    const driverCtl = createStubDriver();
    const recipeGate = withResolvers<void>();
    const { entry, actions } = buildActions<{ v: number }>({ data: { v: 0 }, driver: driverCtl.driver });

    const updatePromise = actions.update(async (draft) => {
      draft.v = 99;
      await recipeGate.promise;
    });
    // 等待 recipe 进入 await
    await flushMicrotasks();
    driverCtl.triggerRevoke('force');
    recipeGate.resolve();

    await expect(updatePromise).rejects.toThrow(LockRevokedError);
    expect(entry.data.v).toBe(0);
    expect(entry.rev).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. holdTimeout
// ---------------------------------------------------------------------------

describe('actions / holdTimeout', () => {
  test('持锁期 holdTimeout 到期 → 自动 revoke("timeout")', async () => {
    const driverCtl = createStubDriver();
    const revokes: RevokeEvent[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      listeners: { onRevoked: (evt) => revokes.push(evt) },
    });

    await actions.getLock({ holdTimeout: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(revokes).toHaveLength(1);
    expect(revokes[0].reason).toBe('timeout');
    expect(actions.isHolding).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. dataReady 失败
// ---------------------------------------------------------------------------

describe('actions / dataReady', () => {
  test('dataReadyState === "failed"：update 抛 LockDisposedError', async () => {
    const driverCtl = createStubDriver();
    const cause = new Error('getValue failed');
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      dataReadyState: 'failed',
      dataReadyError: cause,
    });

    await expect(
      actions.update((d) => {
        d.v = 1;
      }),
    ).rejects.toThrow(LockDisposedError);
  });

  test('dataReadyState === "pending"：update 先等待 dataReadyPromise resolve 再 acquire', async () => {
    const driverCtl = createStubDriver();
    const gate = withResolvers<void>();
    const { entry, actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      dataReadyState: 'pending',
      dataReadyPromise: gate.promise,
    });

    let updateDone = false;
    const updatePromise = actions
      .update((draft) => {
        draft.v = 42;
      })
      .then(() => {
        updateDone = true;
      });

    await flushMicrotasks();
    expect(driverCtl.acquireCount).toBe(0);
    expect(updateDone).toBe(false);

    // getValue resolve 前把 state 也切到 ready（模拟 resolveInitialData 的 onStateChange）
    (entry as { dataReadyState: 'pending' | 'ready' | 'failed' }).dataReadyState = 'ready';
    gate.resolve();
    await updatePromise;

    expect(driverCtl.acquireCount).toBe(1);
    expect(entry.data.v).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 9. authority
// ---------------------------------------------------------------------------

describe('actions / authority', () => {
  test('有 authority：pullOnAcquire 被调用 + onCommitSuccess 被调用 + 不直接 fanoutCommit', async () => {
    const driverCtl = createStubDriver();
    const pullOnAcquireSpy = vi.fn();
    const onCommitSuccessSpy = vi.fn();
    const authority = {
      pullOnAcquire: pullOnAcquireSpy,
      onCommitSuccess: onCommitSuccessSpy,
      dispose: vi.fn(),
    } as unknown as StorageAuthority<{ v: number }>;

    const commitEvents: CommitEvent<{ v: number }>[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      authority,
      listeners: { onCommit: (evt) => commitEvents.push(evt) },
    });

    await actions.update((draft) => {
      draft.v = 7;
    });

    expect(pullOnAcquireSpy).toHaveBeenCalledTimes(1);
    expect(onCommitSuccessSpy).toHaveBeenCalledTimes(1);
    expect(onCommitSuccessSpy.mock.calls[0][0]).toMatchObject({
      source: 'update',
      mutations: [{ path: ['v'], op: 'set', value: 7 }],
    });
    // authority 存在时 actions 不直接 fanoutCommit
    expect(commitEvents).toHaveLength(0);
  });

  test('无 authority：fanoutCommit 直接派发 onCommit', async () => {
    const driverCtl = createStubDriver();
    const commitEvents: CommitEvent<{ v: number }>[] = [];
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
      authority: null,
      listeners: { onCommit: (evt) => commitEvents.push(evt) },
    });

    await actions.update((draft) => {
      draft.v = 7;
    });

    expect(commitEvents).toHaveLength(1);
    expect(commitEvents[0].rev).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 10. read
// ---------------------------------------------------------------------------

describe('actions / read', () => {
  test('read 返回深克隆，修改不影响 entry.data', async () => {
    const driverCtl = createStubDriver();
    const { entry, actions } = buildActions<{ list: number[] }>({
      data: { list: [1, 2, 3] },
      driver: driverCtl.driver,
    });

    const snapshot = actions.read();
    snapshot.list.push(999);
    expect(entry.data.list).toEqual([1, 2, 3]);
  });

  test('read 不抢锁；acquireCount 保持 0', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({ data: { v: 1 }, driver: driverCtl.driver });

    actions.read();
    actions.read();
    expect(driverCtl.acquireCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. acquire ctx 透传
// ---------------------------------------------------------------------------

describe('actions / acquire ctx 透传', () => {
  test('driver.acquire 收到的 context：name / token / force / timeouts 均来自 options', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>(
      { id: 'my-lock', data: { v: 0 }, driver: driverCtl.driver },
      { timeout: 5000 },
    );

    await actions.getLock({ force: true, acquireTimeout: 1234 });

    const ctx = driverCtl.lastContext;
    expect(ctx).not.toBeNull();
    expect(ctx?.name).toBe(`${LOCK_PREFIX}:my-lock`);
    expect(typeof ctx?.token).toBe('string');
    expect(ctx?.token.startsWith(`${LOCK_PREFIX}:my-lock:token:`)).toBe(true);
    expect(ctx?.force).toBe(true);
    expect(ctx?.acquireTimeout).toBe(1234);
    expect(ctx?.holdTimeout).toBe(5000);
    expect(ctx?.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// 12. 参数校验
// ---------------------------------------------------------------------------

describe('actions / 参数校验', () => {
  test('update 非函数 → TypeError', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({ data: { v: 0 }, driver: driverCtl.driver });

    await expect(actions.update(undefined as unknown as () => void)).rejects.toThrow(TypeError);
  });

  test('replace 非对象 → TypeError', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({ data: { v: 0 }, driver: driverCtl.driver });

    await expect(actions.replace(null as unknown as { v: number })).rejects.toThrow(TypeError);
    await expect(actions.replace('str' as unknown as { v: number })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 13. 最小 thenable 安全（回归保护：用户 driver / listener 可能返回只有 .then 没有 .catch
//     的 Promises/A+ 合规 thenable，实现侧必须用 Promise.resolve(...) 正规化再挂 .catch，
//     否则 `(x as Promise).catch()` 会抛 "catch is not a function" TypeError 穿透到调用链）
// ---------------------------------------------------------------------------

describe('actions / 最小 thenable 安全（回归保护）', () => {
  /**
   * 构造一个只实现 .then 不实现 .catch 的最小 thenable（Promises/A+ 合规）
   *
   * 类型注释：TS lib 要求 `.then()` 返回 `PromiseLike<TResult1 | TResult2>`（依赖 onFulfilled/onRejected
   * 的返回类型推断），但测试专用 thenable 始终返回 `PromiseLike<void>` —— 用双重断言
   * `as unknown as PromiseLike<void>` 豁免泛型推断。biome 的 noExplicitAny 不适用于此类测试骨架
   */
  function createMinimalRejectedThenable(reason: unknown): PromiseLike<void> {
    const thenable: PromiseLike<void> = {
      // biome-ignore lint/suspicious/noThenProperty: 测试专用：刻意构造 Promises/A+ 最小 thenable 验证实现侧的正规化保护
      then: <TResult1 = void, TResult2 = never>(
        _onFulfilled?: ((value: undefined) => TResult1 | PromiseLike<TResult1>) | null,
        onRejectedCallback?: ((rejectReason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> => {
        // 延迟到 microtask 触发 reject，模拟真实异步 release
        queueMicrotask(() => {
          if (onRejectedCallback) {
            onRejectedCallback(reason);
          }
        });
        return createMinimalRejectedThenable(reason) as unknown as PromiseLike<TResult1 | TResult2>;
      },
    };
    return thenable;
  }

  test('driver.release 返回最小 rejected thenable → dispose 不抛 TypeError', async () => {
    // 自定义 driver：release 返回的 thenable 没有 .catch 属性
    // 若实现侧写 `(result as Promise).catch(...)` 会抛 TypeError，穿透到 dispose 调用
    const releaseInvocations: 'called'[] = [];
    const driver: LockDriver = {
      acquire: (): Promise<LockDriverHandle> => {
        return Promise.resolve({
          release: (): PromiseLike<void> => {
            releaseInvocations.push('called');
            return createMinimalRejectedThenable(new Error('release-failed'));
          },
          onRevokedByDriver: (): void => {
            /* no-op */
          },
        });
      },
      destroy: (): void => {
        /* no-op */
      },
    };

    const { actions } = buildActions<{ v: number }>({ data: { v: 0 }, driver });

    await actions.getLock();
    // dispose 触发 releaseLockHandle → driver.release() → 最小 thenable
    // 如果没有 Promise.resolve 正规化，这里会抛 TypeError
    await actions.dispose();
    await flushMicrotasks();

    expect(releaseInvocations).toEqual(['called']);
  });

  test('listener.onCommit 返回最小 rejected thenable → update 不抛 TypeError + 不阻断其他 listener', async () => {
    const driverCtl = createStubDriver();
    const otherListenerCommits: number[] = [];

    const { actions } = buildActions<{ v: number }>(
      {
        data: { v: 0 },
        driver: driverCtl.driver,
        listeners: {
          onCommit: (): PromiseLike<void> => {
            // fanoutEvent 里会走 Promise.resolve(...).catch(...) 正规化；
            // 若回退为 (result as Promise).catch(...) 会抛 TypeError
            return createMinimalRejectedThenable(new Error('listener-failed'));
          },
        },
      },
      {
        listeners: {
          // 第二个 listener：验证前一个 listener 的最小 thenable 不阻断后续分发
          onCommit: (evt): void => {
            otherListenerCommits.push(evt.rev);
          },
        },
      },
    );

    await actions.update((d) => {
      d.v = 1;
    });
    await flushMicrotasks();

    // 第二个 listener 被正常调用（第一个 listener 的最小 thenable 未阻断分发）
    expect(otherListenerCommits).toEqual([1]);
  });

  test('dispose-race：acquire 期间 dispose 触发 → safeReleaseHandle 处理最小 thenable 不抛 TypeError', async () => {
    // 场景：acquire promise 未 resolve 时触发 dispose → state.disposed=true；
    // 随后 acquire 完成拿到 handle → L431 的 safeReleaseHandle 独立路径被激活；
    // 若 safeReleaseHandle 未做 Promise.resolve 正规化，最小 thenable 的 .catch
    // 不存在会抛 TypeError 穿透到外层调用链（acquireOnce 的 finally 之外）。
    // 用例 1 走的是 releaseDriverHandle 路径（持锁态 dispose），该路径与
    // safeReleaseHandle 是 DRY 的两份 copy，需要独立回归测试保护。
    const releaseInvocations: 'called'[] = [];
    let resolveAcquire: ((acquiredHandle: LockDriverHandle) => void) | null = null;
    const driver: LockDriver = {
      acquire: (): Promise<LockDriverHandle> =>
        new Promise<LockDriverHandle>((resolve) => {
          resolveAcquire = resolve;
        }),
      destroy: (): void => {
        /* no-op */
      },
    };

    const { actions } = buildActions<{ v: number }>({ data: { v: 0 }, driver });

    // 1) 发起 getLock，acquire promise 挂起
    const getLockPromise = actions.getLock();
    await flushMicrotasks();

    // 2) 在 acquire 未完成时触发 dispose（state.disposed=true）
    //    注意：此刻 actions 内部还在 await driver.acquire(ctx)，dispose 无 handle 可 release
    const disposePromise = actions.dispose();

    // 3) acquire 完成拿到 handle：actions 检测到 state.disposed=true
    //    → 走 L431 safeReleaseHandle(handle) 独立释放路径
    const handle: LockDriverHandle = {
      release: (): PromiseLike<void> => {
        releaseInvocations.push('called');
        return createMinimalRejectedThenable(new Error('dispose-race-release-failed'));
      },
      onRevokedByDriver: (): void => {
        /* no-op */
      },
    };
    // resolveAcquire 在 driver.acquire Promise executor 回调里被赋值，TS CFA 不跨作用域推断
    // 所以认为它仍为 null —— 通过 unknown 中转显式断言为非 null 函数类型
    (resolveAcquire as unknown as (acquiredHandle: LockDriverHandle) => void)(handle);

    // 4) getLock 应抛 LockDisposedError（acquire 成功但 disposed=true → throwDisposed）
    await expect(getLockPromise).rejects.toThrow(LockDisposedError);
    await disposePromise;
    await flushMicrotasks();

    // 5) safeReleaseHandle 被调用，handle.release 被执行，且过程中不抛 TypeError 穿透
    expect(releaseInvocations).toEqual(['called']);
  });
});

// ---------------------------------------------------------------------------
// afterEach 清理
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});
