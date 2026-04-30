/**
 * listeners fanout 单元测试
 *
 * 覆盖 RFC.md L666-667 契约：
 * 1. 四类事件（onLockStateChange / onRevoked / onCommit / onSync）分发到全部 listener
 * 2. listener 未提供对应 hook 时跳过
 * 3. 同步 throw 异常隔离：logger.error 记录后继续下一个
 * 4. 异步 Promise reject 异常隔离：logger.error 记录后继续下一个
 * 5. 事件对象原样透传，不做拷贝
 * 6. 空 listenersSet no-op
 */

import { describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { fanoutCommit, fanoutLockStateChange, fanoutRevoked, fanoutSync } from '@/shared/lock-data/core/fanout';
import type {
  CommitEvent,
  LockDataListeners,
  LockStateChangeEvent,
  LoggerAdapter,
  RevokeEvent,
  SyncEvent,
} from '@/shared/lock-data/types';

function createTestLogger(): LoggerAdapter & {
  warnMock: ReturnType<typeof vi.fn>;
  errorMock: ReturnType<typeof vi.fn>;
  debugMock: ReturnType<typeof vi.fn>;
} {
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  const debugMock = vi.fn();
  return { warn: warnMock, error: errorMock, debug: debugMock, warnMock, errorMock, debugMock };
}

// ---------------------------------------------------------------------------
// fanoutLockStateChange
// ---------------------------------------------------------------------------

describe('fanoutLockStateChange', () => {
  test('向全部 listener 的 onLockStateChange 派发事件', () => {
    const logger = resolveLoggerAdapter();
    const hook1 = vi.fn();
    const hook2 = vi.fn();
    const listeners = new Set<LockDataListeners<{ a: number }>>([
      { onLockStateChange: hook1 },
      { onLockStateChange: hook2 },
    ]);
    const event: LockStateChangeEvent = { phase: 'acquiring', token: 'tk-1' };

    fanoutLockStateChange(listeners, event, logger);

    expect(hook1).toHaveBeenCalledWith(event);
    expect(hook2).toHaveBeenCalledWith(event);
  });

  test('listener 未提供 onLockStateChange 时跳过，其他 listener 正常触发', () => {
    const logger = resolveLoggerAdapter();
    const hook = vi.fn();
    const listeners = new Set<LockDataListeners<{ a: number }>>([
      { onCommit: vi.fn() }, // 无 onLockStateChange
      { onLockStateChange: hook },
    ]);
    const event: LockStateChangeEvent = { phase: 'holding', token: 'tk-2' };

    fanoutLockStateChange(listeners, event, logger);

    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('空 listenersSet no-op', () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const event: LockStateChangeEvent = { phase: 'idle', token: 'tk-0' };

    expect(() => fanoutLockStateChange(new Set<LockDataListeners<{ a: number }>>(), event, resolved)).not.toThrow();
    expect(logger.errorMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fanoutRevoked / fanoutCommit / fanoutSync —— 基本分发
// ---------------------------------------------------------------------------

describe('fanoutRevoked', () => {
  test('向 onRevoked 派发事件', () => {
    const logger = resolveLoggerAdapter();
    const hook = vi.fn();
    const listeners = new Set<LockDataListeners<{ a: number }>>([{ onRevoked: hook }]);
    const event: RevokeEvent = { reason: 'force', token: 'tk-1' };

    fanoutRevoked(listeners, event, logger);

    expect(hook).toHaveBeenCalledWith(event);
  });
});

describe('fanoutCommit', () => {
  test('向 onCommit 派发事件（含 snapshot 引用透传）', () => {
    const logger = resolveLoggerAdapter();
    const hook = vi.fn();
    const snapshot = { count: 10 };
    const listeners = new Set<LockDataListeners<typeof snapshot>>([{ onCommit: hook }]);
    const event: CommitEvent<typeof snapshot> = {
      source: 'update',
      token: 'tk-1',
      rev: 1,
      mutations: [],
      snapshot,
    };

    fanoutCommit(listeners, event, logger);

    expect(hook).toHaveBeenCalledTimes(1);
    // 事件对象必须是同一个引用（fanout 不做拷贝）
    expect(hook.mock.calls[0][0]).toBe(event);
    expect(hook.mock.calls[0][0].snapshot).toBe(snapshot);
  });
});

describe('fanoutSync', () => {
  test('向 onSync 派发事件', () => {
    const logger = resolveLoggerAdapter();
    const hook = vi.fn();
    const snapshot = { count: 99 };
    const listeners = new Set<LockDataListeners<typeof snapshot>>([{ onSync: hook }]);
    const event: SyncEvent<typeof snapshot> = { source: 'storage-event', rev: 5, snapshot };

    fanoutSync(listeners, event, logger);

    expect(hook).toHaveBeenCalledWith(event);
  });
});

// ---------------------------------------------------------------------------
// 异常隔离 —— 同步 throw
// ---------------------------------------------------------------------------

describe('fanout 异常隔离 — 同步 throw', () => {
  test('单个 listener 抛错不阻断其他 listener 派发', () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const order: string[] = [];
    const throwingHook = vi.fn(() => {
      order.push('throw');
      throw new Error('hook boom');
    });
    const okHook = vi.fn(() => {
      order.push('ok');
    });
    const listeners = new Set<LockDataListeners<{ a: number }>>([{ onCommit: throwingHook }, { onCommit: okHook }]);

    const event: CommitEvent<{ a: number }> = {
      source: 'update',
      token: 'tk-1',
      rev: 1,
      mutations: [],
      snapshot: { a: 1 },
    };

    expect(() => fanoutCommit(listeners, event, resolved)).not.toThrow();
    expect(order).toEqual(['throw', 'ok']);
    expect(throwingHook).toHaveBeenCalledTimes(1);
    expect(okHook).toHaveBeenCalledTimes(1);
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    expect(logger.errorMock).toHaveBeenCalledWith(
      expect.stringContaining('listener threw (onCommit)'),
      expect.any(Error),
    );
  });

  test('多个 listener 同步抛错，每个都记录且全部继续执行', () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const hook1 = vi.fn(() => {
      throw new Error('boom-1');
    });
    const hook2 = vi.fn(() => {
      throw new Error('boom-2');
    });
    const hook3 = vi.fn();
    const listeners = new Set<LockDataListeners<{ a: number }>>([
      { onLockStateChange: hook1 },
      { onLockStateChange: hook2 },
      { onLockStateChange: hook3 },
    ]);
    const event: LockStateChangeEvent = { phase: 'holding', token: 'tk-1' };

    fanoutLockStateChange(listeners, event, resolved);

    expect(hook1).toHaveBeenCalledTimes(1);
    expect(hook2).toHaveBeenCalledTimes(1);
    expect(hook3).toHaveBeenCalledTimes(1);
    expect(logger.errorMock).toHaveBeenCalledTimes(2);
  });

  test('错误消息包含 hook 名称便于定位', () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const listeners = new Set<LockDataListeners<{ a: number }>>([
      {
        onRevoked: () => {
          throw new Error('revoked boom');
        },
      },
    ]);

    fanoutRevoked(listeners, { reason: 'dispose', token: 'tk-1' }, resolved);

    expect(logger.errorMock).toHaveBeenCalledWith(
      expect.stringContaining('listener threw (onRevoked)'),
      expect.any(Error),
    );
  });
});

// ---------------------------------------------------------------------------
// 异常隔离 —— 异步 Promise reject
// ---------------------------------------------------------------------------

describe('fanout 异常隔离 — 异步 Promise reject', () => {
  test('hook 返回 rejected Promise 被捕获并记录，不产生 UnhandledRejection', async () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const asyncError = new Error('async boom');
    const hook = vi.fn(() => Promise.reject(asyncError));
    const listeners = new Set<LockDataListeners<{ a: number }>>([{ onSync: hook }]);
    const event: SyncEvent<{ a: number }> = {
      source: 'storage-event',
      rev: 1,
      snapshot: { a: 1 },
    };

    fanoutSync(listeners, event, resolved);

    // 让微任务队列跑完
    await Promise.resolve();
    await Promise.resolve();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(logger.errorMock).toHaveBeenCalledWith(expect.stringContaining('listener threw (onSync)'), asyncError);
  });

  test('hook 返回的 resolved Promise 不触发 error log', async () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const hook = vi.fn(() => Promise.resolve());
    const listeners = new Set<LockDataListeners<{ a: number }>>([{ onSync: hook }]);
    const event: SyncEvent<{ a: number }> = {
      source: 'storage-event',
      rev: 1,
      snapshot: { a: 1 },
    };

    fanoutSync(listeners, event, resolved);

    await Promise.resolve();
    await Promise.resolve();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(logger.errorMock).not.toHaveBeenCalled();
  });

  test('hook 同步返回非 Promise（void / 普通值）不触发 .catch 链', () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    // @ts-expect-error 允许 hook 返回任意值；fanout 只关心是否 thenable
    const hook = vi.fn(() => 42);
    const listeners = new Set<LockDataListeners<{ a: number }>>([{ onSync: hook }]);
    const event: SyncEvent<{ a: number }> = {
      source: 'storage-event',
      rev: 1,
      snapshot: { a: 1 },
    };

    expect(() => fanoutSync(listeners, event, resolved)).not.toThrow();
    expect(logger.errorMock).not.toHaveBeenCalled();
  });

  test('混合同步抛错 + 异步 reject：各自独立记录', async () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const syncError = new Error('sync boom');
    const asyncError = new Error('async boom');
    const listeners = new Set<LockDataListeners<{ a: number }>>([
      {
        onCommit: () => {
          throw syncError;
        },
      },
      { onCommit: () => Promise.reject(asyncError) },
      { onCommit: vi.fn() },
    ]);
    const event: CommitEvent<{ a: number }> = {
      source: 'update',
      token: 'tk-1',
      rev: 1,
      mutations: [],
      snapshot: { a: 1 },
    };

    fanoutCommit(listeners, event, resolved);
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.errorMock).toHaveBeenCalledTimes(2);
    // 第一次是同步 throw（在 fanout 返回前已记录）
    expect(logger.errorMock).toHaveBeenCalledWith(expect.stringContaining('listener threw (onCommit)'), syncError);
    expect(logger.errorMock).toHaveBeenCalledWith(expect.stringContaining('listener threw (onCommit)'), asyncError);
  });
});

// ---------------------------------------------------------------------------
// 多 listener 分发顺序
// ---------------------------------------------------------------------------

describe('fanout 多 listener 分发顺序', () => {
  test('按 Set 迭代顺序分发（插入顺序）', () => {
    const logger = resolveLoggerAdapter();
    const order: number[] = [];
    const listeners = new Set<LockDataListeners<{ a: number }>>();
    listeners.add({ onLockStateChange: () => order.push(1) });
    listeners.add({ onLockStateChange: () => order.push(2) });
    listeners.add({ onLockStateChange: () => order.push(3) });

    fanoutLockStateChange(listeners, { phase: 'holding', token: 'tk-1' }, logger);

    expect(order).toEqual([1, 2, 3]);
  });
});
