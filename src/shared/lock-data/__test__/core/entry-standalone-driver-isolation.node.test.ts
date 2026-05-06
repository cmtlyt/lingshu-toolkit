/**
 * standalone（无 id）实例的 driver / authority 隔离 — node 路径
 *
 * 修复背景：`src/shared/lock-data/fixes/standalone-id-leak.md`
 *
 * 在修复前，`acquireStandalone` 用伪 id `'__local__'` 喂 factory，导致：
 * 1. `pickDriver` 把 `'__local__'` 当真实非空 id，不再走 LocalLockDriver 短路；
 *    用户传 `mode: 'web-locks'` 等会被强制起跨 Tab driver
 * 2. `attachAuthority` 看到 syncMode='storage-authority' + 非空 id 就启用 authority，
 *    所有"无 id + storage-authority"实例落到同一个 `__local__` 命名空间互相污染
 * 3. CustomDriver 收到 `LockDriverContext.name = ${LOCK_PREFIX}:__local__` 的伪锁名
 * 4. 两个无 id 实例 + 跨 Tab driver 时共用同一锁名，互相阻塞
 *
 * 修复方案：拆分 `Entry.id`（展示用，仍 `'__local__'` 占位）与 `Entry.lockId`
 * （语义判定用，standalone 路径 = `undefined`）；下游全部基于 lockId 判定。
 *
 * 本文件覆盖 5 个回归断言（均 node 环境，不依赖浏览器能力）：
 * 1. 无 id + `mode: 'web-locks'` → 不抛 "navigator.locks unavailable"，证明走 LocalLockDriver
 * 2. 无 id + `syncMode: 'storage-authority'` → authority 不启用（stub 工厂零调用）
 * 3. 无 id + `adapters.getLock` → CustomDriver 拿到 `name === ${LOCK_PREFIX}:__local__` 占位
 *    （而非伪真实 id）
 * 4. 无 id + `adapters.getLock` → CustomDriver 多次调用使用稳定占位 name（无并发污染）
 * 5. 两个无 id 实例并发 update → 互不阻塞（每个 standalone 独占 LocalLockDriver 实例）
 */

/** biome-ignore-all lint/nursery/useGlobalThis: test file uses AbortController */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOCK_PREFIX } from '@/shared/lock-data/constants';
import { __resetDefaultRegistry, lockData } from '@/shared/lock-data/core/entry';
import type {
  AuthorityAdapterContext,
  ChannelAdapterContext,
  LockDataActions,
  LockDataAdapters,
  LockDriverContext,
  LockDriverHandle,
  LoggerAdapter,
  SessionStoreAdapterContext,
} from '@/shared/lock-data/types';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function createSilentLogger(): LoggerAdapter & {
  warnMock: ReturnType<typeof vi.fn>;
  errorMock: ReturnType<typeof vi.fn>;
} {
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  return {
    warn: warnMock,
    error: errorMock,
    debug: vi.fn(),
    warnMock,
    errorMock,
  };
}

/** 立即 grant 的 stub getLock；记录每次入参 */
function createStubGetLock(): {
  getLock: NonNullable<LockDataAdapters<unknown>['getLock']>;
  calls: LockDriverContext[];
  releaseMock: ReturnType<typeof vi.fn>;
} {
  const calls: LockDriverContext[] = [];
  const releaseMock = vi.fn();
  const getLock: NonNullable<LockDataAdapters<unknown>['getLock']> = (ctx) => {
    calls.push(ctx);
    const handle: LockDriverHandle = {
      release: releaseMock,
      onRevokedByDriver: () => {
        /* no-op */
      },
    };
    return handle;
  };
  return { getLock, calls, releaseMock };
}

afterEach(() => {
  __resetDefaultRegistry();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. driver 选择回归
// ---------------------------------------------------------------------------

describe('standalone-driver-isolation / pickDriver 走 LocalLockDriver', () => {
  test('无 id + mode="web-locks" 不抛 "navigator.locks unavailable"（node 环境无 web-locks 能力）', async () => {
    // 修复前：standalone 路径 id 是 '__local__'（非空），pickDriver 跳过 "无 id 短路"
    // 进入 mode='web-locks' 分支 → createWebLocksOrThrow 在 node 环境检测 navigator.locks
    // 不可用，抛 TypeError "mode='web-locks' requested but navigator.locks is unavailable"
    // 修复后：lockId === undefined，pickDriver 直接 LocalLockDriver；本调用不抛错
    const result = lockData(
      { v: 0 },
      {
        mode: 'web-locks',
        adapters: { logger: createSilentLogger() },
      },
    );
    // 同步路径返回 [view, actions]；如果 pickDriver 抛错则上述 lockData 调用会同步抛错
    expect(Array.isArray(result)).toBe(true);
    const [, actions] = result as readonly [{ v: number }, LockDataActions<{ v: number }>];

    // update 也不应抛错（LocalLockDriver 的 acquire 立即 grant）
    await expect(
      actions.update((draft) => {
        draft.v = 1;
      }),
    ).resolves.toBeUndefined();

    await actions.dispose();
  });

  test('无 id + mode="broadcast" 同样走 LocalLockDriver 分支（不抛 "BroadcastChannel unavailable"）', async () => {
    const result = lockData(
      { v: 0 },
      {
        mode: 'broadcast',
        adapters: { logger: createSilentLogger() },
      },
    );
    expect(Array.isArray(result)).toBe(true);
    const [, actions] = result as readonly [{ v: number }, LockDataActions<{ v: number }>];
    await expect(
      actions.update((draft) => {
        draft.v = 2;
      }),
    ).resolves.toBeUndefined();
    await actions.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. authority 启用回归
// ---------------------------------------------------------------------------

describe('standalone-driver-isolation / attachAuthority 不启用', () => {
  test('无 id + syncMode="storage-authority" → 用户 getAuthority/getChannel/getSessionStore 全程零调用', async () => {
    const getAuthority = vi.fn((_ctx: AuthorityAdapterContext) => null);
    const getChannel = vi.fn((_ctx: ChannelAdapterContext) => null);
    const getSessionStore = vi.fn((_ctx: SessionStoreAdapterContext) => null);

    const result = lockData(
      { v: 0 },
      {
        syncMode: 'storage-authority',
        adapters: {
          logger: createSilentLogger(),
          getAuthority,
          getChannel,
          getSessionStore,
        },
      },
    );

    // 修复前：lockData 会走 attachAuthority → 三个工厂被分别调用一次 + 拼出 authority 实例
    // 修复后：lockId === undefined → attachAuthority 整个分支被跳过，三个工厂零调用
    expect(getAuthority).not.toHaveBeenCalled();
    expect(getChannel).not.toHaveBeenCalled();
    expect(getSessionStore).not.toHaveBeenCalled();

    // 同步路径返回（没有 authority.init() 合并到 dataReadyPromise）
    expect(Array.isArray(result)).toBe(true);
    const [, actions] = result as readonly [{ v: number }, LockDataActions<{ v: number }>];
    await actions.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. CustomDriver acquire 入参 name 回归
// ---------------------------------------------------------------------------

describe('standalone-driver-isolation / CustomDriver name 不再泄漏伪真实 id', () => {
  test('无 id + adapters.getLock → CustomDriver 收到的 name 是 LOCK_PREFIX:__local__ 占位 fallback', async () => {
    const stub = createStubGetLock();
    const [, actions] = lockData(
      { v: 0 },
      {
        adapters: { logger: createSilentLogger(), getLock: stub.getLock },
      },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];

    await actions.update((draft) => {
      draft.v = 1;
    });

    // 修复前后 name 字符串都是 `${LOCK_PREFIX}:__local__`，但语义来源不同：
    //   修复前：来自 actions.ts 拼 entry.id（伪真实 id）→ CustomDriver 误以为存在真实 id
    //   修复后：来自 buildAcquireName(entry) 在 lockId === undefined 时的占位 fallback
    // 这里仅断言"用户拿到的 name 与 buildDriverDeps 占位一致"——是契约层面的稳定保证
    expect(stub.calls.length).toBeGreaterThan(0);
    expect(stub.calls[0].name).toBe(`${LOCK_PREFIX}:__local__`);

    await actions.dispose();
  });

  test('无 id + adapters.getLock 多次 update → 每次 acquire 的 name 稳定为占位（无 id 拼接）', async () => {
    const stub = createStubGetLock();
    const [, actions] = lockData(
      { count: 0 },
      {
        adapters: { logger: createSilentLogger(), getLock: stub.getLock },
      },
    ) as readonly [{ count: number }, LockDataActions<{ count: number }>];

    await actions.update((draft) => {
      draft.count = 1;
    });
    await actions.update((draft) => {
      draft.count = 2;
    });
    await actions.update((draft) => {
      draft.count = 3;
    });

    // 至少 3 次 acquire；每次 name 都应是同一个占位字符串
    expect(stub.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of stub.calls) {
      expect(call.name).toBe(`${LOCK_PREFIX}:__local__`);
    }

    await actions.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. 两个 standalone 实例并发不串扰
// ---------------------------------------------------------------------------

describe('standalone-driver-isolation / 多个无 id 实例彼此独立', () => {
  test('两个无 id 实例并发 update → 各自独立完成（不会因为"假共享锁名"互相阻塞）', async () => {
    // 关键契约：两个 standalone 实例由 acquireStandalone 各自走一次 factory，
    // 每个 Entry 持有独立的 LocalLockDriver 实例 —— 即便两者 name 都是 ':__local__'
    // 占位，也不会共享锁状态（LocalLockDriver 的互斥范围是 driver 实例本身）
    const logger = createSilentLogger();
    const [viewA, actionsA] = lockData({ v: 0 }, { adapters: { logger } }) as readonly [
      { v: number },
      LockDataActions<{ v: number }>,
    ];
    const [viewB, actionsB] = lockData({ v: 0 }, { adapters: { logger } }) as readonly [
      { v: number },
      LockDataActions<{ v: number }>,
    ];

    // 并发发起 update；若两者共享同一把锁，第二个会排队 / 抢占
    await Promise.all([
      actionsA.update((draft) => {
        draft.v = 1;
      }),
      actionsB.update((draft) => {
        draft.v = 2;
      }),
    ]);

    expect(viewA.v).toBe(1);
    expect(viewB.v).toBe(2);

    await actionsA.dispose();
    await actionsB.dispose();
  });
});
