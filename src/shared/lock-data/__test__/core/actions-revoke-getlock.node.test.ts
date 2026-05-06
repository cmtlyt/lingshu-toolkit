/**
 * 回归测试：handleRevoke 必须清空 acquiredByGetLock，
 * 否则上一轮 getLock() 留下的 flag 会污染下一轮 update() 的 maybeAutoRelease 决策
 *
 * 对应修复方案：src/shared/lock-data/fixes/revoke-clear-acquired-by-get-lock.md
 *
 * 缺陷复现路径：
 *   await actions.getLock();         // state.acquiredByGetLock = true
 *   driverCtl.triggerRevoke('force');  // handleRevoke 旧实现未清 flag
 *   await actions.update(recipe);    // recipe 后 maybeAutoRelease 误判 → 锁被永久留住
 *
 * 测试场景：
 *   1. driver force revoke → 下一次 update 后自动 release
 *   2. holdTimeout revoke → 下一次 update 后自动 release（需要 vi.useFakeTimers）
 *   3. 反向校验：正常 getLock + update（无 revoke）→ 仍持锁（getLock 语义未被误伤）
 *
 * 选用 node 环境：actions 不依赖浏览器 API；fakeTimers 在 node 环境下更稳定
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ResolvedAdapters } from '@/shared/lock-data/adapters/index';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { createActions } from '@/shared/lock-data/core/actions';
import type { Entry } from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/index';
import type { LockDataListeners, LockDataOptions, LockDriverContext, LockDriverHandle } from '@/shared/lock-data/types';

// ---------------------------------------------------------------------------
// stub 构造（精简版，仅覆盖本测试需要的能力）
// ---------------------------------------------------------------------------

interface StubDriverController {
  readonly driver: LockDriver;
  triggerRevoke: (reason: 'force' | 'timeout') => void;
  acquireCount: number;
  releaseCount: number;
}

function createStubDriver(): StubDriverController {
  let revokeCallback: ((reason: 'force' | 'timeout') => void) | null = null;
  let releaseCount = 0;
  let acquireCount = 0;

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
    acquire: (_ctx: LockDriverContext) => {
      acquireCount++;
      revokeCallback = null;
      return Promise.resolve(makeHandle());
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
    triggerRevoke: (reason): void => {
      if (revokeCallback) {
        revokeCallback(reason);
      }
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
  readonly data: T;
  readonly driver: LockDriver;
  readonly listeners?: LockDataListeners<T>;
}

function createStubEntry<T extends object>(opts: StubEntryOptions<T>): Entry<T> {
  const listenersSet = new Set<LockDataListeners<T>>();
  if (opts.listeners) {
    listenersSet.add(opts.listeners);
  }
  return {
    id: 'test-id',
    data: opts.data,
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
    dataReadyState: 'ready',
    dataReadyError: undefined,
  };
}

function buildActions<T extends object>(
  entryOpts: StubEntryOptions<T>,
  options: LockDataOptions<T> = {},
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
    options,
    releaseFromRegistry: vi.fn(),
  });
  return { entry, actions };
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe('actions / revoke 后必须清空 acquiredByGetLock（修复回归）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('driver force revoke 后，下一次 update 仍会自动 release', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
    });

    // 1. 走 getLock 路径置位 acquiredByGetLock = true
    await actions.getLock();
    expect(actions.isHolding).toBe(true);

    // 2. driver 主动撤销（模拟其他 Tab force 抢占）
    driverCtl.triggerRevoke('force');
    expect(actions.isHolding).toBe(false);

    // 3. 修复前：acquiredByGetLock 残留 true → update 后 maybeAutoRelease 提前 return
    //    修复后：handleRevoke 已清 flag → update 走完正常 release 流程
    const releaseBefore = driverCtl.releaseCount;
    await actions.update((draft) => {
      draft.v = 1;
    });

    // 关键断言 1：update 后必须自动 release（修复前会保持 holding）
    expect(actions.isHolding).toBe(false);
    // 关键断言 2：driver handle.release 被调用（acquire 一次 + release 一次）
    expect(driverCtl.releaseCount).toBe(releaseBefore + 1);
  });

  test("revoke reason='timeout' 同样清空 flag：下一次 update 仍会自动 release", async () => {
    // 直接通过 triggerRevoke('timeout') 驱动 handleRevoke 的 timeout 路径，
    // 不依赖 fakeTimers 的精确时序（两条路径都走 handleRevoke，
    // reason 字段只影响 fanoutRevoked 事件，不影响清理逻辑）
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
    });

    await actions.getLock();
    driverCtl.triggerRevoke('timeout');
    expect(actions.isHolding).toBe(false);

    const releaseBefore = driverCtl.releaseCount;
    await actions.update((draft) => {
      draft.v = 1;
    });

    expect(actions.isHolding).toBe(false);
    expect(driverCtl.releaseCount).toBe(releaseBefore + 1);
  });

  test('反向校验：getLock + update（无 revoke）→ 锁仍被保留，未误伤 getLock 语义', async () => {
    const driverCtl = createStubDriver();
    const { actions } = buildActions<{ v: number }>({
      data: { v: 0 },
      driver: driverCtl.driver,
    });

    await actions.getLock();
    await actions.update((draft) => {
      draft.v = 1;
    });

    // 没有 revoke 的情况下：getLock 留下的锁不该被 update 自动释放
    expect(actions.isHolding).toBe(true);
    expect(driverCtl.releaseCount).toBe(0);

    // 主动 release 确认行为正常
    actions.release();
    expect(actions.isHolding).toBe(false);
    expect(driverCtl.releaseCount).toBe(1);
  });
});
