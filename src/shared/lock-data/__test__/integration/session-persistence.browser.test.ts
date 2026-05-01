/**
 * session / persistent 两种持久化策略的完整生命周期集成测试（browser 环境）
 *
 * 覆盖目标：从 lockData 外部视角验证 resolveEpoch 六分支在真实 localStorage +
 * sessionStorage + BroadcastChannel 下的端到端行为：
 *
 * - **A 分支**：persistent 策略 → 固定 epoch=`'persistent'`；跨"进程"重启仍共享同一权威副本
 * - **C 分支**：session 策略 + sessionStorage 已有 epoch → 直接继承（模拟刷新 / bfcache）
 * - **F 分支**：session 策略 + 首次 + 无 reply → 生成新 UUID + 清空 authority
 * - **E 分支**：session 策略 + 首次 + 收到 reply → 继承响应方 epoch
 * - **epoch 隔离**：不同 epoch 下的 authority 数据互不可见（session 语义强过 localStorage 天然持久化）
 *
 * 为什么走 browser：
 * - 真实 `localStorage` / `sessionStorage` / `BroadcastChannel` 才能验证 resolveEpoch 的
 *   实际时序（F 分支的 authority.remove + UUID 生成、E 分支的 session-probe reply 投递）
 * - session-probe 协议依赖 BroadcastChannel 的真实投递；mock 下无法暴露时序 bug
 *
 * "模拟多进程启动"技巧：
 * - `__resetDefaultRegistry()` 清空进程级 Entry 缓存
 * - `sessionStorage.clear()` 模拟"新 Tab 首次启动"
 * - 保留 `localStorage` 模拟"权威副本在磁盘上延续"
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildAuthorityKey } from '../../adapters/authority';
import { buildSessionStoreKey } from '../../adapters/session-store';
import { PERSISTENT_EPOCH } from '../../constants';
import { __resetDefaultRegistry } from '../../core/entry';
import { lockData } from '../../index';
import type { LockDriverContext, LockDriverHandle } from '../../types';

// ---------------------------------------------------------------------------
// 辅助：进程内互斥锁工厂
// ---------------------------------------------------------------------------

/**
 * 进程内互斥锁工厂（作为 adapters.getLock 注入 CustomDriver）
 *
 * 浏览器环境下默认 `mode='auto'` 会走 web-locks / BroadcastChannel driver，
 * 其行为依赖浏览器能力探测，测试里显式注入 CustomDriver 让 driver 层与本测试无关
 */
function createInMemoryLockFactory(): (ctx: LockDriverContext) => Promise<LockDriverHandle> {
  interface Waiter {
    readonly token: string;
    readonly resolve: (handle: LockDriverHandle) => void;
  }
  interface Holder {
    readonly token: string;
    onRevoke: ((reason: 'force' | 'timeout') => void) | null;
    released: boolean;
  }

  const waiters: Waiter[] = [];
  let holder: Holder | null = null;

  function grant(token: string, resolve: (handle: LockDriverHandle) => void): void {
    const current: Holder = { token, onRevoke: null, released: false };
    holder = current;
    resolve({
      release: (): void => {
        if (holder !== current || current.released) {
          return;
        }
        current.released = true;
        holder = null;
        const next = waiters.shift();
        if (next) {
          grant(next.token, next.resolve);
        }
      },
      onRevokedByDriver: (callback): void => {
        current.onRevoke = callback;
      },
    });
  }

  function acquire(ctx: LockDriverContext): Promise<LockDriverHandle> {
    return new Promise<LockDriverHandle>((resolve, reject) => {
      if (ctx.force) {
        if (holder !== null) {
          const prev = holder;
          prev.released = true;
          holder = null;
          prev.onRevoke?.('force');
        }
        grant(ctx.token, resolve);
        return;
      }
      if (holder === null) {
        grant(ctx.token, resolve);
        return;
      }
      const waiter: Waiter = { token: ctx.token, resolve };
      waiters.push(waiter);
      ctx.signal.addEventListener(
        'abort',
        (): void => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(ctx.signal.reason ?? new Error('acquire aborted'));
          }
        },
        { once: true },
      );
    });
  }

  return acquire;
}

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

interface Counter {
  count: number;
}

/** 基于时间戳的唯一 id，避免测试间的 localStorage / Registry 污染 */
function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 按 id 精确清理 localStorage + sessionStorage 残留 */
function cleanupStorage(id: string): void {
  try {
    localStorage.removeItem(buildAuthorityKey(id));
    sessionStorage.removeItem(buildSessionStoreKey(id));
  } catch {
    /* 测试环境兜底 */
  }
}

/** 读取当前 localStorage 里权威副本的原始字符串；便于断言 */
function readAuthorityRaw(id: string): string | null {
  return localStorage.getItem(buildAuthorityKey(id));
}

/** 读取当前 sessionStorage 里的 epoch 值 */
function readSessionEpoch(id: string): string | null {
  return sessionStorage.getItem(buildSessionStoreKey(id));
}

/**
 * 从权威副本 raw 中提取 epoch 字段（测试断言辅助）
 *
 * 使用 JSON.parse 而非正则，保证断言结果的权威性（不依赖实现细节里的 extract 快路径）
 */
function parseEpochFromRaw(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { epoch?: unknown };
    return typeof parsed.epoch === 'string' ? parsed.epoch : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("lockData persistence='persistent' 生命周期 (browser)", () => {
  beforeEach(() => {
    __resetDefaultRegistry();
  });

  afterEach(() => {
    __resetDefaultRegistry();
    sessionStorage.clear();
  });

  test('A 分支：persistent 策略 → epoch 固定为常量 "persistent"', async () => {
    const id = uniqueId('a-branch');

    const result = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'persistent',
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [, actions] = result;

    await actions.update((draft) => {
      draft.count = 7;
    });

    // 权威副本已写入，epoch 字段固定为 'persistent'
    const raw = readAuthorityRaw(id);
    expect(raw).not.toBeNull();
    expect(parseEpochFromRaw(raw)).toBe(PERSISTENT_EPOCH);

    // persistent 策略不触达 sessionStorage（A 分支早返）
    expect(readSessionEpoch(id)).toBeNull();

    await actions.dispose();
    cleanupStorage(id);
  });

  test('persistent 策略跨"进程"启动 → 新 Entry 仍能读到旧权威副本', async () => {
    const id = uniqueId('persistent-restart');

    // 第一轮：TabA 写入 count=42，dispose
    const firstRound = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'persistent',
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    await firstRound[1].update((draft) => {
      draft.count = 42;
    });
    await firstRound[1].dispose();

    // 模拟进程重启（保留 localStorage，清空 sessionStorage + Registry）
    __resetDefaultRegistry();
    sessionStorage.clear();

    // 第二轮：新 Entry 启动，应读到上一轮的权威副本
    const secondRound = await lockData<Counter>(
      { count: 0 }, // 本地默认值会被 authority 覆盖
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'persistent',
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [view, actions] = secondRound;

    expect(view.count).toBe(42);

    await actions.dispose();
    cleanupStorage(id);
  });
});

describe("lockData persistence='session' 生命周期 (browser)", () => {
  beforeEach(() => {
    __resetDefaultRegistry();
    sessionStorage.clear();
  });

  afterEach(() => {
    __resetDefaultRegistry();
    sessionStorage.clear();
  });

  test('F 分支：首次启动 + 无 reply → 生成新 UUID + 清空 authority 残留', async () => {
    const id = uniqueId('f-branch');

    // 预埋：localStorage 里有上一会话组遗留的权威副本（用不同的 epoch 模拟）
    localStorage.setItem(
      buildAuthorityKey(id),
      `{"rev":99,"ts":${Date.now()},"epoch":"stale-epoch","snapshot":{"count":999}}`,
    );

    // 启动 session 策略 Entry：F 分支会 authority.remove() 清空残留
    const result = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50, // 缩短等待窗口加速测试
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [view, actions] = result;

    // 本地 view 保持初始值（不会被 stale-epoch 的残留污染）
    expect(view.count).toBe(0);

    // authority 里旧残留已被清空（F 分支 authorityCleared=true）
    expect(readAuthorityRaw(id)).toBeNull();

    // sessionStorage 里应写入新生成的 UUID（非 'persistent'）
    const epoch = readSessionEpoch(id);
    expect(epoch).not.toBeNull();
    expect(epoch).not.toBe(PERSISTENT_EPOCH);
    expect(epoch).not.toBe('stale-epoch');
    expect(typeof epoch).toBe('string');
    expect((epoch as string).length).toBeGreaterThan(0);

    // 自己 commit 后权威副本带的是新 epoch
    await actions.update((draft) => {
      draft.count = 5;
    });
    const raw = readAuthorityRaw(id);
    expect(parseEpochFromRaw(raw)).toBe(epoch);

    await actions.dispose();
    cleanupStorage(id);
  });

  test('C 分支：sessionStorage 已有 epoch（模拟刷新 / bfcache 恢复）→ 直接继承', async () => {
    const id = uniqueId('c-branch');
    const existingEpoch = 'abcd-1234-efgh-5678';

    // 预埋：sessionStorage 已有 epoch，localStorage 的权威副本用同一 epoch
    sessionStorage.setItem(buildSessionStoreKey(id), existingEpoch);
    localStorage.setItem(
      buildAuthorityKey(id),
      `{"rev":3,"ts":${Date.now()},"epoch":"${existingEpoch}","snapshot":{"count":30}}`,
    );

    const result = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [view, actions] = result;

    // C 分支直接继承 existingEpoch，首次 pull 命中，view.count=30
    expect(view.count).toBe(30);

    // sessionStorage 里的 epoch 保持不变
    expect(readSessionEpoch(id)).toBe(existingEpoch);

    // authority 未被清空（C 分支 authorityCleared=false）
    expect(readAuthorityRaw(id)).not.toBeNull();

    await actions.dispose();
    cleanupStorage(id);
  });

  test('epoch 隔离：不同 epoch 下的 authority 数据互不可见（session 语义强于 localStorage 持久化）', async () => {
    const id = uniqueId('epoch-isolation');

    // 预埋：localStorage 里有"上一会话组"的权威副本（带不同 epoch）
    const staleEpoch = 'stale-epoch-0000';
    localStorage.setItem(
      buildAuthorityKey(id),
      `{"rev":5,"ts":${Date.now()},"epoch":"${staleEpoch}","snapshot":{"count":500}}`,
    );

    // 本 Tab session 策略启动 → F 分支清空 authority（不应读到 staleEpoch 数据）
    const result = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [view, actions] = result;

    // 关键断言：view.count 保持本地初始值 0，未被 staleEpoch 的 500 污染
    expect(view.count).toBe(0);

    await actions.dispose();
    cleanupStorage(id);
  });

  test('session 策略下同 Tab 刷新：C 分支继承 epoch，新增 commit 仍用同一 epoch', async () => {
    const id = uniqueId('session-refresh');

    // 第一轮：首次启动，走 F 分支生成新 UUID
    const firstRound = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    await firstRound[1].update((draft) => {
      draft.count = 11;
    });
    const epochFirst = readSessionEpoch(id);
    expect(epochFirst).not.toBeNull();
    expect(epochFirst).not.toBe(PERSISTENT_EPOCH);
    await firstRound[1].dispose();

    // 模拟"刷新当前 Tab"：保留 sessionStorage，清 Registry
    __resetDefaultRegistry();

    // 第二轮：C 分支读 sessionStorage 里的 epochFirst，继承
    const secondRound = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [view, actions] = secondRound;

    // 刷新后应读到上一轮 commit 的数据（同 epoch 下 authority 可见）
    expect(view.count).toBe(11);
    // sessionStorage 里的 epoch 保持不变
    expect(readSessionEpoch(id)).toBe(epochFirst);

    // 再 commit 一次，epoch 仍是 epochFirst
    await actions.update((draft) => {
      draft.count = 22;
    });
    expect(parseEpochFromRaw(readAuthorityRaw(id))).toBe(epochFirst);

    await actions.dispose();
    cleanupStorage(id);
  });

  test('session 策略下新开 Tab（清 sessionStorage）：F 分支生成不同 UUID，与前 Tab epoch 不同', async () => {
    const id = uniqueId('new-tab');

    // 第一轮 Tab：首次启动 F 分支
    const firstTab = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const epochFirst = readSessionEpoch(id);
    expect(epochFirst).not.toBeNull();
    await firstTab[1].dispose();

    // 模拟"新开 Tab"：清空 sessionStorage + Registry，保留 localStorage
    __resetDefaultRegistry();
    sessionStorage.clear();

    // 第二轮 Tab：sessionStorage 没 epoch，channel 虽可用但没有活的 responder
    // （前一轮 dispose 解绑了 session-probe）→ 超时走 F 分支生成新 UUID
    const secondTab = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );

    const epochSecond = readSessionEpoch(id);
    expect(epochSecond).not.toBeNull();
    expect(epochSecond).not.toBe(epochFirst); // 关键：不同 Tab 得到不同 UUID

    await secondTab[1].dispose();
    cleanupStorage(id);
  });

  test('E 分支：同会话组内两个 Tab 共存 → 新 Tab 通过 session-probe 继承已有 epoch', async () => {
    const id = uniqueId('e-branch');

    // TabA：首次启动 F 分支生成 UUID 并保持存活（作为 session-probe responder）
    const tabA = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [, actionsA] = tabA;
    await actionsA.update((draft) => {
      draft.count = 77;
    });
    const epochA = readSessionEpoch(id);
    expect(epochA).not.toBeNull();

    // 模拟"同源新开 Tab"：清 Registry + sessionStorage（localStorage 和 TabA 的 BroadcastChannel 保留）
    // 注意：TabA 的 actions 仍然持有 Entry 引用，其 BroadcastChannel 监听器仍在工作
    __resetDefaultRegistry();
    sessionStorage.clear();

    // TabB 启动 → 广播 session-probe → TabA 回复 reply → TabB E 分支继承 epochA
    const tabB = await lockData<Counter>(
      { count: 0 },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 500, // 留足窗口等待 reply
        adapters: { getLock: createInMemoryLockFactory() },
      },
    );
    const [viewB, actionsB] = tabB;

    // E 分支：TabB 继承了 TabA 的 epoch
    expect(readSessionEpoch(id)).toBe(epochA);

    // 同 epoch 下 TabB 的首次 pull 能拿到 TabA commit 的数据
    expect(viewB.count).toBe(77);

    await actionsA.dispose();
    await actionsB.dispose();
    cleanupStorage(id);
  });
});
