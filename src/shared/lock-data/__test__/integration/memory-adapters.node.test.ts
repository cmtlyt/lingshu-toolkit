/**
 * 全内存 adapter 的 lockData 集成测试（Node 环境）
 *
 * 覆盖目标：用 `createMemoryAdapters` 注入的"内存版 authority / channel / sessionStore"
 * 驱动 lockData 全链路，验证 Phase 1-6 的各模块在多 Tab 共享内存环境下真实串起来后
 * 的行为契约（而非单模块单测）。
 *
 * 为什么走 node：
 * - 不依赖真实 localStorage / BroadcastChannel / sessionStorage 的浏览器实现
 * - `getLock` 走 CustomDriver（pickDriver 优先级 1），避免 auto 降级链受 Node 版本
 *   （v24+ 原生 navigator.locks / node >= 18 的 BroadcastChannel）影响
 *
 * 测试场景（对应 RFC L1190-1230 读写路径）：
 * 1. 同 env 单 Tab：update 成功 → authority.write 被调用 + onCommit 触发
 * 2. 跨 Tab 同 env：TabA update → TabB authority.subscribe 回调 → onSync 触发（storage-event 路径）
 * 3. session-probe 协议：TabB 新建时没有 sessionScope，但 channel 可用 → 收到 TabA 的 session-reply → 继承 epoch（E 分支）
 * 4. 降级：authority / channel / sessionStore 全 null（env 没共享）→ lockData 仍能 dispose（退化为同进程共享）
 * 5. dispose 幂等 + teardown 逆序执行
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetDefaultRegistry } from '../../core/entry';
import type { LockDataAdapters, LockDriverContext, LockDriverHandle } from '../../index';
import { lockData } from '../../index';
import { createMemoryAdapters, createSharedMemoryEnv, type SharedMemoryEnv } from '../_helpers/memory-adapters';

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

interface Counter {
  count: number;
  label: string;
}

/**
 * 基于 Promise + FIFO 队列的进程内互斥锁工厂；作为 `adapters.getLock` 注入
 * 让 Node 环境下的测试不依赖任何浏览器能力探测
 *
 * 语义：
 * - acquire 立即授予当前空闲锁或排队等待
 * - force === true：直接强制抢占，触发前一个 holder 的 onRevokedByDriver('force')
 * - release 幂等，推进队首 waiter
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

  function pump(): void {
    if (holder !== null || waiters.length === 0) {
      return;
    }
    const next = waiters.shift();
    if (!next) {
      return;
    }
    grant(next.token, next.resolve);
  }

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
        pump();
      },
      onRevokedByDriver: (callback): void => {
        current.onRevoke = callback;
      },
    });
  }

  return (ctx: LockDriverContext): Promise<LockDriverHandle> => {
    return new Promise<LockDriverHandle>((resolve, reject) => {
      // force：直接抢占
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
      // 快路径：锁空闲，直接拿
      if (holder === null) {
        grant(ctx.token, resolve);
        return;
      }
      // 排队
      const waiter: Waiter = { token: ctx.token, resolve };
      waiters.push(waiter);
      // 监听外部 signal：超时 / dispose / 显式 abort 时出队 + reject
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
  };
}

/**
 * 构造一对 Tab 共享的 adapter 工厂：
 * - 两个 Tab 复用同一个 `SharedMemoryEnv`（authority storage + channel bus）
 * - 每个 Tab 独立的 sessionScope
 * - 每个 Tab 独立的 `getLock`（模拟两个 Tab 的独立锁空间）—— 真实 driver 层
 *   `web-locks` / `broadcast` / `storage` 在本用例里不参与
 */
function buildTabAdaptersFactory(env: SharedMemoryEnv): () => LockDataAdapters<Counter> {
  return () => {
    const memory = createMemoryAdapters(env);
    return {
      getLock: createInMemoryLockFactory(),
      getAuthority: memory.getAuthority,
      getChannel: memory.getChannel,
      getSessionStore: memory.getSessionStore,
    };
  };
}

/** 基于当前时间戳的唯一 id，避免进程单例 Registry 跨用例污染 */
function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('lockData + memory adapters 集成 (node)', () => {
  afterEach(() => {
    __resetDefaultRegistry();
  });

  test('场景 1：单 Tab update → authority.write 被调用 + onCommit 触发', async () => {
    const env = createSharedMemoryEnv();
    const buildTab = buildTabAdaptersFactory(env);
    const id = uniqueId('scene1');

    const commits: number[] = [];
    const result = await lockData<Counter>(
      { count: 0, label: 'init' },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        adapters: buildTab(),
        listeners: {
          onCommit: (event): void => {
            commits.push(event.rev);
          },
        },
      },
    );
    const [view, actions] = result;

    expect(view.count).toBe(0);
    expect(env.storage.size).toBe(0); // init 阶段无 authority.write（read 返回 null）

    await actions.update((draft) => {
      draft.count = 1;
      draft.label = 'updated';
    });

    expect(view.count).toBe(1);
    expect(view.label).toBe('updated');
    expect(commits).toEqual([1]);
    // authority.write 被调用：storage 里应该有 authority key + epoch key
    expect(env.storage.size).toBeGreaterThan(0);

    await actions.dispose();
  });

  test('场景 2：跨 Tab 同 env —— TabA commit 后 TabB 的 onSync 收到新值（storage-event 路径）', async () => {
    const env = createSharedMemoryEnv();
    const buildTab = buildTabAdaptersFactory(env);
    const id = uniqueId('scene2');

    const tabASyncEvents: number[] = [];
    const tabBSyncEvents: number[] = [];

    const tabA = await lockData<Counter>(
      { count: 0, label: 'A-init' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: buildTab(),
        listeners: {
          onSync: (event): void => {
            tabASyncEvents.push(event.rev);
          },
        },
      },
    );
    const [, actionsA] = tabA;

    // 关键：TabB 必须用新的 id（否则会命中进程单例 Registry，共享 TabA 的 Entry）
    // 但为了测试"跨 Tab"语义，我们确实要同 id + 不同 adapter 工厂 —— 这需要重置 Registry
    __resetDefaultRegistry();
    const tabB = await lockData<Counter>(
      { count: 0, label: 'B-init' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: buildTab(),
        listeners: {
          onSync: (event): void => {
            tabBSyncEvents.push(event.rev);
          },
        },
      },
    );
    const [viewB, actionsB] = tabB;

    // TabA commit
    await actionsA.update((draft) => {
      draft.count = 42;
      draft.label = 'from-A';
    });

    // TabB 通过 authority.subscribe → storage-event 收到 onSync
    // 由于 subscribe 是同步回调（memory-adapters 的 notifyStorageSubscribers 是同步的），
    // update 返回时 TabB 的 onSync 已经触发
    expect(tabBSyncEvents).toEqual([1]);
    expect(viewB.count).toBe(42);
    expect(viewB.label).toBe('from-A');

    // TabA 自己 commit 不会走 storage-event（本 Tab 过滤），但会走 onCommit
    expect(tabASyncEvents).toEqual([]);

    await actionsA.dispose();
    await actionsB.dispose();
  });

  test('场景 3：session-probe 协议 —— TabB 首次启动 + channel 可用 → 继承 TabA 的 epoch (E 分支)', async () => {
    const env = createSharedMemoryEnv();
    const buildTab = buildTabAdaptersFactory(env);
    const id = uniqueId('scene3');

    // TabA：首次启动，走 F 分支（无 sessionReply → 生成新 UUID + 清空 authority）
    const tabA = await lockData<Counter>(
      { count: 0, label: 'A' },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 50,
        adapters: buildTab(),
      },
    );
    const [, actionsA] = tabA;

    // TabA commit 一次，确保 authority 里有数据（带 TabA 的 epoch）
    await actionsA.update((draft) => {
      draft.count = 100;
    });
    expect(env.storage.size).toBeGreaterThan(0);

    // TabB：新建（清空进程 Registry 模拟新 Tab 进程）
    __resetDefaultRegistry();
    const tabB = await lockData<Counter>(
      { count: 0, label: 'B' },
      {
        id,
        syncMode: 'storage-authority',
        persistence: 'session',
        sessionProbeTimeout: 200,
        adapters: buildTab(),
      },
    );
    const [viewB, actionsB] = tabB;

    // TabB 通过 session-probe 收到 TabA 的 session-reply → 继承 epoch → 首次 pull 命中
    // 于是 viewB.count 应该是 TabA commit 后的值
    expect(viewB.count).toBe(100);

    await actionsA.dispose();
    await actionsB.dispose();
  });

  test('场景 4：authority 不可用 → 走 warn 降级链路，commit 仍然生效（不写 localStorage）', async () => {
    const id = uniqueId('scene4');
    const warnMock = vi.fn();

    const result = await lockData<Counter>(
      { count: 0, label: 'fallback' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          // 用户显式禁用 authority / sessionStore：`pickDefaultAdapters` 的 fallback 走默认工厂，
          // node 环境下默认 localStorage / sessionStorage 不可用 → 两个均返回 null（各自打 warn）。
          // channel 在 node >= 18 下原生 BroadcastChannel 可用 —— 此场景验证 authority 缺失
          // 但 channel 存在时的降级行为：resolveEpoch 触发 B 分支（sessionStore 不可用 → session
          // 降级为 persistent），后续 commit 因 `authority === null` 跳过 storage.setItem，
          // 仍能 emit onCommit、view 正常更新
          getAuthority: () => null,
          getSessionStore: () => null,
          logger: {
            warn: warnMock,
            error: vi.fn(),
            debug: vi.fn(),
          },
        },
      },
    );
    const [view, actions] = result;

    expect(view.count).toBe(0);
    // 命中三条典型降级 warn：authority / sessionStore / session→persistent 降级
    // 断言任一命中即可（具体条数因环境差异，此处做弱断言保证稳定）
    expect(warnMock).toHaveBeenCalled();
    expect(
      warnMock.mock.calls.some((call) =>
        /localStorage is not available|sessionStorage is not available|sessionStore adapter unavailable/u.test(
          String(call[0]),
        ),
      ),
    ).toBe(true);

    // 仍可 update —— commit 成功，view 更新
    await actions.update((draft) => {
      draft.count = 5;
    });
    expect(view.count).toBe(5);

    await actions.dispose();
    // dispose 幂等：第二次调用不抛错
    await expect(actions.dispose()).resolves.toBeUndefined();
  });

  test('场景 5：dispose 后 update / replace / getLock 抛 LockDisposedError', async () => {
    const env = createSharedMemoryEnv();
    const buildTab = buildTabAdaptersFactory(env);
    const id = uniqueId('scene5');

    const result = await lockData<Counter>(
      { count: 0, label: 'x' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: buildTab(),
      },
    );
    const [, actions] = result;

    await actions.dispose();

    await expect(
      actions.update((draft) => {
        draft.count = 1;
      }),
    ).rejects.toThrowError(/disposed/u);

    await expect(actions.replace({ count: 2, label: 'y' })).rejects.toThrowError(/disposed/u);

    await expect(actions.getLock()).rejects.toThrowError(/disposed/u);
  });

  test('场景 6：分支 A 同步入口 —— memory adapters + syncMode=none → 同步返回元组', () => {
    const id = uniqueId('scene6');
    // 无 syncMode → 分支 A（同步）
    const result = lockData<Counter>(
      { count: 7, label: 'sync' },
      {
        id,
        adapters: {
          getLock: createInMemoryLockFactory(),
        },
      },
    );
    // 同步分支：不是 Promise
    expect(result).not.toBeInstanceOf(Promise);
    const [view, actions] = result;
    expect(view.count).toBe(7);

    void actions.dispose();
  });

  test('场景 7：分支 B 异步 getValue + memory adapters', async () => {
    const id = uniqueId('scene7');
    const result = lockData<Counter>(undefined, {
      id,
      getValue: () => Promise.resolve({ count: 99, label: 'async' }),
      adapters: {
        getLock: createInMemoryLockFactory(),
      },
    });
    expect(result).toBeInstanceOf(Promise);

    const [view, actions] = await result;
    expect(view.count).toBe(99);
    expect(view.label).toBe('async');

    await actions.dispose();
  });
});
