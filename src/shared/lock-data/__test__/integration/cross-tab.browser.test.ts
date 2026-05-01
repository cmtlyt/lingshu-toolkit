/**
 * 真跨 Tab 的 storage-authority 端到端集成测试（browser 环境）
 *
 * 覆盖目标：验证 lockData 在"同源多 Tab"场景下的完整同步链路：
 * - TabA commit → 写入 localStorage（真实 API）→ TabB 收到 storage 事件 → onSync 触发
 * - TabA 与 TabB 各自独立的 actions / listeners / 状态，不互相干扰
 * - TabA dispose 不影响 TabB 继续工作
 *
 * 为什么走 browser：
 * - 真实 `localStorage` / `BroadcastChannel` / `sessionStorage` / `StorageEvent` 派发链路
 * - 验证 `adapters/authority.ts::subscribe` 对 `event.storageArea === localStorage && event.key === key` 的过滤契约
 * - 验证 serialize + extract 快路径在真实大 snapshot 下的正确性
 *
 * 关键模拟技巧（原生 storage 事件限制）：
 * 原生 `localStorage.setItem(k, v)` **不会**在同一 document 内触发 `storage` 事件
 * （W3C 规范：storage 事件仅跨 document 投递）。为了在单浏览器环境下模拟"TabA → TabB"，
 * 采用以下策略：
 * - **TabA adapter**：封装真实 localStorage.setItem，write 后手动 `window.dispatchEvent(new StorageEvent(...))`
 * - **TabB adapter**：直接复用默认 `createDefaultAuthorityAdapter`（它监听 window 的 storage 事件）
 *
 * 这样 TabB 收到的就是"像来自另一个 Tab 的真 StorageEvent"，走真实 extract + apply 链路
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildAuthorityKey, createDefaultAuthorityAdapter } from '../../adapters/authority';
import { createDefaultChannelAdapter } from '../../adapters/channel';
import { createDefaultSessionStoreAdapter } from '../../adapters/session-store';
import { __resetDefaultRegistry } from '../../core/entry';
import { lockData } from '../../index';
import type {
  AuthorityAdapter,
  AuthorityAdapterContext,
  LockDataAdapters,
  LockDriverContext,
  LockDriverHandle,
  LoggerAdapter,
} from '../../types';

// ---------------------------------------------------------------------------
// 辅助：进程内互斥锁工厂
// ---------------------------------------------------------------------------

/**
 * 进程内互斥锁工厂（作为 adapters.getLock 注入 CustomDriver）
 *
 * 同一浏览器文档里两个 "Tab" 实际在同一线程，但测试里逻辑上要求两侧独立持锁空间；
 * 通过每个 Tab 注入自己的 factory 实现"逻辑隔离"
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
// 辅助：TabA 的"写入 + 主动派发 storage 事件"authority 包装
// ---------------------------------------------------------------------------

/**
 * 包装 TabA 的 AuthorityAdapter：在默认 adapter 的 write/remove 之后，
 * 手动派发 StorageEvent 让同 window 内的 TabB 监听器能收到（模拟"来自另一个 Tab"）
 *
 * 原生 storage 事件限制：localStorage.setItem 不会在同一 document 内触发 storage 事件；
 * 通过 `new StorageEvent('storage', { key, newValue, storageArea: localStorage })` + `window.dispatchEvent`
 * 模拟跨 Tab 事件派发
 */
function createTabAAuthority(ctx: AuthorityAdapterContext, logger: LoggerAdapter): AuthorityAdapter {
  const inner = createDefaultAuthorityAdapter(ctx, { logger });
  if (inner === null) {
    throw new Error('localStorage is not available in browser test environment');
  }
  const key = buildAuthorityKey(ctx.id);

  function dispatchAcrossTab(oldValue: string | null, newValue: string | null): void {
    const event = new StorageEvent('storage', {
      key,
      oldValue,
      newValue,
      storageArea: localStorage,
      url: globalThis.location.href,
    });
    globalThis.dispatchEvent(event);
  }

  return {
    read: () => inner.read(),
    write: (raw: string): void => {
      const oldValue = inner.read();
      inner.write(raw);
      dispatchAcrossTab(oldValue, raw);
    },
    remove: (): void => {
      const oldValue = inner.read();
      inner.remove();
      dispatchAcrossTab(oldValue, null);
    },
    subscribe: (onExternalUpdate) => inner.subscribe(onExternalUpdate),
  };
}

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

interface SharedData {
  count: number;
  label: string;
}

function createLogger(): LoggerAdapter {
  return { warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** 基于时间戳的唯一 id，避免 Registry / localStorage / BroadcastChannel name 冲突 */
function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 清理单个 id 对应的所有 localStorage / sessionStorage / BroadcastChannel 残留
 *
 * 测试间污染是 browser 集成测试的常见坑：同 id 在不同用例里创建的 storage key 会串扰；
 * 这里按 id 做精确清理，避免影响其他用例
 */
function cleanupStorage(id: string): void {
  try {
    localStorage.removeItem(buildAuthorityKey(id));
    sessionStorage.clear();
  } catch {
    /* 测试环境兜底 */
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('lockData 真跨 Tab storage-authority 端到端 (browser)', () => {
  beforeEach(() => {
    __resetDefaultRegistry();
  });

  afterEach(() => {
    __resetDefaultRegistry();
    // sessionStorage 每个用例开头清理；localStorage 按 id 精确清理（单个用例 afterEach 里做）
  });

  test('场景 1：TabA commit → TabB 通过真实 StorageEvent 收到 onSync', async () => {
    const id = uniqueId('xtab-1');
    const logger = createLogger();
    const lockA = createInMemoryLockFactory();
    const lockB = createInMemoryLockFactory();

    const tabBSyncEvents: Array<{ rev: number; source: string }> = [];

    // TabA：write 时手动派发 StorageEvent
    const tabAAdapters: LockDataAdapters<SharedData> = {
      getLock: lockA,
      getAuthority: (ctx) => createTabAAuthority(ctx, logger),
      getChannel: (ctx) => createDefaultChannelAdapter(ctx, { logger }),
      getSessionStore: (ctx) => createDefaultSessionStoreAdapter(ctx, { logger }),
      logger,
    };

    const tabA = await lockData<SharedData>(
      { count: 0, label: 'A-init' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: tabAAdapters,
      },
    );
    const [, actionsA] = tabA;

    // 关键：重置 Registry，让 TabB 用完全独立的 Entry
    __resetDefaultRegistry();

    // TabB：默认 adapter（监听 window 的 storage 事件）
    const tabBAdapters: LockDataAdapters<SharedData> = {
      getLock: lockB,
      // TabB 用默认 adapter；它会 subscribe window 的 storage 事件
      // TabA 的 write 手动派发的 StorageEvent 会被 TabB 收到
      logger,
    };
    const tabB = await lockData<SharedData>(
      { count: 0, label: 'B-init' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: tabBAdapters,
        listeners: {
          onSync: (event): void => {
            tabBSyncEvents.push({ rev: event.rev, source: event.source });
          },
        },
      },
    );
    const [viewB, actionsB] = tabB;

    // TabA commit：count 0 → 42
    await actionsA.update((draft) => {
      draft.count = 42;
      draft.label = 'from-A';
    });

    // TabB 应该通过 storage 事件收到 onSync
    await vi.waitFor(
      () => {
        expect(tabBSyncEvents.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 500, interval: 10 },
    );

    const firstSync = tabBSyncEvents[0];
    expect(firstSync.source).toBe('storage-event');
    expect(firstSync.rev).toBe(1);
    expect(viewB.count).toBe(42);
    expect(viewB.label).toBe('from-A');

    await actionsA.dispose();
    await actionsB.dispose();
    cleanupStorage(id);
  });

  test('场景 2：TabA 多次 commit → TabB 依次收到递增 rev 的 onSync', async () => {
    const id = uniqueId('xtab-2');
    const logger = createLogger();

    const tabBSyncEvents: number[] = [];

    const tabA = await lockData<SharedData>(
      { count: 0, label: 'A' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          getAuthority: (ctx) => createTabAAuthority(ctx, logger),
          logger,
        },
      },
    );
    const [, actionsA] = tabA;

    __resetDefaultRegistry();

    const tabB = await lockData<SharedData>(
      { count: 0, label: 'B' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          logger,
        },
        listeners: {
          onSync: (event): void => {
            tabBSyncEvents.push(event.rev);
          },
        },
      },
    );
    const [viewB, actionsB] = tabB;

    // TabA 连续 3 次 commit
    await actionsA.update((draft) => {
      draft.count = 1;
    });
    await actionsA.update((draft) => {
      draft.count = 2;
    });
    await actionsA.update((draft) => {
      draft.count = 3;
    });

    // TabB 应收到 3 次 onSync，rev 依次 1/2/3
    await vi.waitFor(
      () => {
        expect(tabBSyncEvents.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 1000, interval: 10 },
    );

    expect(tabBSyncEvents.slice(0, 3)).toEqual([1, 2, 3]);
    expect(viewB.count).toBe(3);

    await actionsA.dispose();
    await actionsB.dispose();
    cleanupStorage(id);
  });

  test('场景 3：TabA 自己 commit 不会触发自己的 onSync（本 Tab 过滤契约）', async () => {
    const id = uniqueId('xtab-3');
    const logger = createLogger();

    const tabASyncEvents: number[] = [];

    const tabA = await lockData<SharedData>(
      { count: 0, label: 'A' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          getAuthority: (ctx) => createTabAAuthority(ctx, logger),
          logger,
        },
        listeners: {
          onSync: (event): void => {
            tabASyncEvents.push(event.rev);
          },
        },
      },
    );
    const [, actionsA] = tabA;

    await actionsA.update((draft) => {
      draft.count = 10;
    });

    // 给 storage 事件一个投递窗口（即使有派发，本 Tab subscribe 应该被 storageArea 过滤掉）
    // 实际 createDefaultAuthorityAdapter 里 dispatchAcrossTab 构造的 StorageEvent
    // 的 storageArea === localStorage，默认 adapter 的 subscribe 只过滤 event.key ≠ key，
    // 所以本 Tab 其实也会收到自己派发的事件 —— 但 readIfNewer 里 `remoteRev <= lastAppliedRev`
    // 会过滤（TabA commit 已经 lastAppliedRev = rev），等价于 no-op，不会触发 emitSync
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(tabASyncEvents).toEqual([]);

    await actionsA.dispose();
    cleanupStorage(id);
  });

  test('场景 4：TabA dispose 后 TabB 继续 commit 不受影响', async () => {
    const id = uniqueId('xtab-4');
    const logger = createLogger();

    const tabA = await lockData<SharedData>(
      { count: 0, label: 'A' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          getAuthority: (ctx) => createTabAAuthority(ctx, logger),
          logger,
        },
      },
    );
    const [, actionsA] = tabA;

    __resetDefaultRegistry();

    const tabB = await lockData<SharedData>(
      { count: 0, label: 'B' },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          getAuthority: (ctx) => createTabAAuthority(ctx, logger),
          logger,
        },
      },
    );
    const [viewB, actionsB] = tabB;

    // TabA dispose
    await actionsA.dispose();

    // TabB 继续 commit 应成功
    await actionsB.update((draft) => {
      draft.count = 99;
      draft.label = 'B-still-alive';
    });
    expect(viewB.count).toBe(99);
    expect(viewB.label).toBe('B-still-alive');

    await actionsB.dispose();
    cleanupStorage(id);
  });

  test('场景 5：跨 Tab commit 的 TabB data 应是独立副本（clone 隔离）', async () => {
    const id = uniqueId('xtab-5');
    const logger = createLogger();

    const tabA = await lockData<{ items: number[] }>(
      { items: [] },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          getAuthority: (ctx) => createTabAAuthority(ctx, logger),
          logger,
        },
      },
    );
    const [viewA, actionsA] = tabA;

    __resetDefaultRegistry();

    const tabB = await lockData<{ items: number[] }>(
      { items: [] },
      {
        id,
        syncMode: 'storage-authority',
        adapters: {
          getLock: createInMemoryLockFactory(),
          logger,
        },
      },
    );
    const [viewB, actionsB] = tabB;

    await actionsA.update((draft) => {
      draft.items.push(1, 2, 3);
    });

    await vi.waitFor(
      () => {
        expect(viewB.items.length).toBe(3);
      },
      { timeout: 500, interval: 10 },
    );

    // 关键：TabA 和 TabB 的 items 数组**不应是同一引用**（已通过 JSON 序列化 + deserialize 隔离）
    // 此断言通过对比 view 内部的 array 不是同一引用来验证
    expect(viewA.items).not.toBe(viewB.items);
    expect(viewA.items).toEqual([1, 2, 3]);
    expect(viewB.items).toEqual([1, 2, 3]);

    await actionsA.dispose();
    await actionsB.dispose();
    cleanupStorage(id);
  });
});
