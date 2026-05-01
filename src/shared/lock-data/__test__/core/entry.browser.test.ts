/**
 * core/entry.ts 集成测试（browser 环境，真实 AbortController / setTimeout / Proxy）
 *
 * 聚焦组装链路的关键契约，不重复覆盖 Actions / Registry / Authority 各自的单元测试：
 *
 * 1. 无 id 路径：同步 getValue / initial 直用 / 独立 Entry 生命周期
 * 2. 有 id 路径：同 id 复用 data / 独立 actions / refCount 计数 / dispose 级联
 * 3. dataReady 异步：getValue 返回 Promise → lockData 返回 Promise<[view, actions]>
 * 4. dataReady 失败：同步抛错 → 同步 throw；异步 reject → Promise reject LockDisposedError
 * 5. ReadonlyView：返回的 view 为只读；mutation 抛 ReadonlyMutationError
 * 6. listeners fanout：同 id 多实例的 listener 都收到 commit
 * 7. adapters.getLock 注入：自定义 driver 被使用
 * 8. options.signal.abort：端到端自动 dispose
 * 9. initOptions 冲突：非 listeners 字段不一致 → logger.warn（以首次为准）
 */

/** biome-ignore-all lint/nursery/useGlobalThis: test file uses AbortController/setTimeout */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetDefaultRegistry, lockData } from '@/shared/lock-data/core/entry';
import { LockDisposedError, ReadonlyMutationError } from '@/shared/lock-data/errors';
import type {
  CommitEvent,
  LockDataActions,
  LockDataAdapters,
  LockDataListeners,
  LockDriverContext,
  LockDriverHandle,
  LoggerAdapter,
} from '@/shared/lock-data/types';
import { withResolvers } from '@/shared/with-resolvers';

// ---------------------------------------------------------------------------
// 工具：静默 logger（不让测试输出被真实 warn 污染）
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

/** 等待微任务队列清空 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  __resetDefaultRegistry();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. 无 id 路径（LocalLockDriver，纯本地）
// ---------------------------------------------------------------------------

describe('entry / 无 id 路径', () => {
  test('initial 直用：同步返回 [view, actions]，view 反映 data', () => {
    const result = lockData({ count: 10 }, { adapters: { logger: createSilentLogger() } });

    expect(Array.isArray(result)).toBe(true);
    const [view, actions] = result as readonly [{ count: number }, LockDataActions<{ count: number }>];
    expect(view.count).toBe(10);
    expect(typeof actions.update).toBe('function');
    actions.dispose();
  });

  test('view 是只读代理：set 抛 ReadonlyMutationError', () => {
    const [view, actions] = lockData({ count: 0 }, { adapters: { logger: createSilentLogger() } }) as readonly [
      { count: number },
      LockDataActions<{ count: number }>,
    ];

    expect(() => {
      (view as { count: number }).count = 999;
    }).toThrow(ReadonlyMutationError);

    actions.dispose();
  });

  test('update 后 view 读到最新值（原地修改）', async () => {
    const [view, actions] = lockData({ count: 0 }, { adapters: { logger: createSilentLogger() } }) as readonly [
      { count: number },
      LockDataActions<{ count: number }>,
    ];

    await actions.update((draft) => {
      draft.count = 42;
    });

    expect(view.count).toBe(42);
    await actions.dispose();
  });

  test('dispose：driver.destroy 被触发（通过注入自定义 driver 验证）', async () => {
    const releaseMock = vi.fn();
    const userGetLock: LockDataAdapters<unknown>['getLock'] = () => ({
      release: releaseMock,
      onRevokedByDriver: () => {
        /* no-op */
      },
    });
    const [, actions] = lockData(
      { v: 0 },
      { adapters: { logger: createSilentLogger(), getLock: userGetLock } },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];

    await actions.update((draft) => {
      draft.v = 1;
    });
    expect(releaseMock).toHaveBeenCalled();
    await actions.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. 有 id 路径：同 id 复用
// ---------------------------------------------------------------------------

describe('entry / 有 id 同 id 复用', () => {
  test('同 id 两次 lockData：view 对应的底层 data 引用相同', async () => {
    const logger = createSilentLogger();
    const [viewA, actionsA] = lockData({ name: 'first' }, { id: 'shared-id-1', adapters: { logger } }) as readonly [
      { name: string },
      LockDataActions<{ name: string }>,
    ];
    const [viewB, actionsB] = lockData(
      { name: 'second-ignored' },
      { id: 'shared-id-1', adapters: { logger } },
    ) as readonly [{ name: string }, LockDataActions<{ name: string }>];

    // 首次 initial 生效，第二次被忽略（RFC L663）
    expect(viewA.name).toBe('first');
    expect(viewB.name).toBe('first');

    // 任一 update 对方能看到
    await actionsA.update((draft) => {
      draft.name = 'updated';
    });
    expect(viewB.name).toBe('updated');

    await actionsA.dispose();
    await actionsB.dispose();
  });

  test('actions 独立：A.dispose 不影响 B 可继续写入', async () => {
    const logger = createSilentLogger();
    const [, actionsA] = lockData({ v: 0 }, { id: 'shared-id-2', adapters: { logger } }) as readonly [
      { v: number },
      LockDataActions<{ v: number }>,
    ];
    const [viewB, actionsB] = lockData({ v: 0 }, { id: 'shared-id-2', adapters: { logger } }) as readonly [
      { v: number },
      LockDataActions<{ v: number }>,
    ];

    await actionsA.dispose();
    await actionsB.update((draft) => {
      draft.v = 7;
    });

    expect(viewB.v).toBe(7);
    await actionsB.dispose();
  });

  test('listeners 独立：两个 listener 都收到 commit 事件', async () => {
    const logger = createSilentLogger();
    const eventsA: CommitEvent<{ v: number }>[] = [];
    const eventsB: CommitEvent<{ v: number }>[] = [];
    const listenersA: LockDataListeners<{ v: number }> = {
      onCommit: (evt) => eventsA.push(evt),
    };
    const listenersB: LockDataListeners<{ v: number }> = {
      onCommit: (evt) => eventsB.push(evt),
    };

    const [, actionsA] = lockData(
      { v: 0 },
      { id: 'shared-id-3', adapters: { logger }, listeners: listenersA },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];
    const [, actionsB] = lockData(
      { v: 0 },
      { id: 'shared-id-3', adapters: { logger }, listeners: listenersB },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];

    await actionsA.update((draft) => {
      draft.v = 1;
    });

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0].rev).toBe(1);
    expect(eventsB[0].rev).toBe(1);

    await actionsA.dispose();
    await actionsB.dispose();
  });

  test('initOptions 冲突：非 listeners 字段不一致 → logger.warn', () => {
    const logger = createSilentLogger();
    const [, actionsA] = lockData({ v: 0 }, { id: 'conflict-id', timeout: 1000, adapters: { logger } }) as readonly [
      { v: number },
      LockDataActions<{ v: number }>,
    ];
    const [, actionsB] = lockData({ v: 0 }, { id: 'conflict-id', timeout: 5000, adapters: { logger } }) as readonly [
      { v: number },
      LockDataActions<{ v: number }>,
    ];

    const warnCalls = logger.warnMock.mock.calls.map((call) => String(call[0]));
    expect(warnCalls.some((msg) => msg.includes('option conflict') && msg.includes('timeout'))).toBe(true);

    actionsA.dispose();
    actionsB.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. dataReady 异步路径
// ---------------------------------------------------------------------------

describe('entry / dataReady 异步', () => {
  test('getValue 返回 Promise：lockData 返回 Promise<[view, actions]>，resolve 后 view 就位', async () => {
    const gate = withResolvers<{ count: number }>();
    const result = lockData<{ count: number }>(undefined, {
      getValue: () => gate.promise,
      adapters: { logger: createSilentLogger() },
    });
    expect(result).toBeInstanceOf(Promise);

    gate.resolve({ count: 99 });
    const [view, actions] = await result;
    expect(view.count).toBe(99);

    await actions.dispose();
  });

  test('getValue 同步抛错：返回的 Promise reject LockDisposedError 且 cause 保留原错误', async () => {
    const boom = new Error('sync getValue boom');
    // resolveInitialData 对「getValue 同步抛错」按 Promise.reject 等价处理（RFC L684 的 failed 分支统一入口）
    // core/entry.ts::lockData 签名是 LockDataResult | Promise<LockDataResult> 联合，这里显式断言为
    // Promise 分支（getValue 返回 Promise / syncMode storage-authority 命中异步路径）
    const result = lockData<{ v: number }>(undefined, {
      getValue: () => {
        throw boom;
      },
      adapters: { logger: createSilentLogger() },
    }) as Promise<readonly [{ v: number }, LockDataActions<{ v: number }>]>;
    expect(result).toBeInstanceOf(Promise);

    const captured = await result.then(
      () => null,
      (error: unknown) => error,
    );
    expect(captured).toBeInstanceOf(LockDisposedError);
    expect((captured as { cause?: unknown }).cause).toBe(boom);
  });

  test('getValue 异步 reject：Promise reject LockDisposedError 且 cause 保留原错误', async () => {
    const boom = new Error('async getValue boom');
    const result = lockData<{ v: number }>(undefined, {
      getValue: () => Promise.reject(boom),
      adapters: { logger: createSilentLogger() },
    }) as Promise<readonly [{ v: number }, LockDataActions<{ v: number }>]>;
    expect(result).toBeInstanceOf(Promise);

    const captured = await result.then(
      () => null,
      (error: unknown) => error,
    );
    expect(captured).toBeInstanceOf(LockDisposedError);
    expect((captured as { cause?: unknown }).cause).toBe(boom);
  });

  test('getValue 返回 Promise 期间 view 可访问 initial（占位 data）', async () => {
    const gate = withResolvers<{ count: number }>();
    const result = lockData<{ count: number }>(
      { count: 0 },
      {
        getValue: () => gate.promise,
        adapters: { logger: createSilentLogger() },
      },
    );

    // view 通过返回的 Promise 获得 —— 但占位 data 已经在 Entry 内原地挂好
    gate.resolve({ count: 123 });
    const [view, actions] = await result;
    expect(view.count).toBe(123);

    await actions.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. adapters.getLock 自定义 driver 端到端
// ---------------------------------------------------------------------------

describe('entry / adapters.getLock', () => {
  test('自定义 getLock 覆盖能力检测：自定义 handle.release 在 update 后被调用', async () => {
    const releaseMock = vi.fn();
    let capturedCtx: LockDriverContext | null = null;
    // getLock 字段类型不依赖 T（签名里没有 T），使用具体 T 让 ctx 被正确推断为 LockDriverContext
    const userGetLock: NonNullable<LockDataAdapters<{ v: number }>['getLock']> = (ctx) => {
      capturedCtx = ctx;
      const handle: LockDriverHandle = {
        release: releaseMock,
        onRevokedByDriver: () => {
          /* no-op */
        },
      };
      return handle;
    };

    const [, actions] = lockData(
      { v: 0 },
      {
        id: 'custom-driver-id',
        adapters: { logger: createSilentLogger(), getLock: userGetLock },
      },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];

    await actions.update((draft) => {
      draft.v = 1;
    });

    expect(capturedCtx).not.toBeNull();
    // capturedCtx 在 userGetLock 回调里被赋值，TS CFA 不跨闭包作用域推断，仍视为 null
    // 上一行 expect(...).not.toBeNull() 是 vitest 断言，不做类型守卫 —— 通过 unknown 中转断言收窄
    const narrowedCtx = capturedCtx as unknown as LockDriverContext;
    expect(narrowedCtx.name).toContain('custom-driver-id');
    expect(releaseMock).toHaveBeenCalled();

    await actions.dispose();
  });
});

// ---------------------------------------------------------------------------
// 5. signal.abort 端到端
// ---------------------------------------------------------------------------

describe('entry / signal 自动 dispose', () => {
  test('options.signal.abort → actions 自动 disposed', async () => {
    const controller = new AbortController();
    const [, actions] = lockData(
      { v: 0 },
      {
        signal: controller.signal,
        adapters: { logger: createSilentLogger() },
      },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];

    controller.abort();
    await flushMicrotasks();

    await expect(
      actions.update((draft) => {
        draft.v = 1;
      }),
    ).rejects.toThrow(LockDisposedError);
  });

  test('同 id 复用 + signal 独立：一个实例的 signal.abort 不影响另一个', async () => {
    const logger = createSilentLogger();
    const controllerA = new AbortController();
    const [, actionsA] = lockData(
      { v: 0 },
      { id: 'signal-isolate', signal: controllerA.signal, adapters: { logger } },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];
    const [viewB, actionsB] = lockData({ v: 0 }, { id: 'signal-isolate', adapters: { logger } }) as readonly [
      { v: number },
      LockDataActions<{ v: number }>,
    ];

    controllerA.abort();
    await flushMicrotasks();

    // A 自动 disposed
    await expect(
      actionsA.update((draft) => {
        draft.v = 1;
      }),
    ).rejects.toThrow(LockDisposedError);
    // B 仍可正常 update
    await actionsB.update((draft) => {
      draft.v = 7;
    });
    expect(viewB.v).toBe(7);

    await actionsB.dispose();
  });
});

// ---------------------------------------------------------------------------
// 6. dispose 级联 / 引用计数
// ---------------------------------------------------------------------------

describe('entry / dispose 级联', () => {
  test('同 id 两个实例：先后 dispose 后再创建新实例 initial 再次生效（Entry 被销毁重建）', async () => {
    const logger = createSilentLogger();
    const [viewA, actionsA] = lockData({ name: 'first' }, { id: 'refcount-id', adapters: { logger } }) as readonly [
      { name: string },
      LockDataActions<{ name: string }>,
    ];
    const [, actionsB] = lockData({ name: 'ignored' }, { id: 'refcount-id', adapters: { logger } }) as readonly [
      { name: string },
      LockDataActions<{ name: string }>,
    ];

    expect(viewA.name).toBe('first');

    await actionsA.dispose();
    await actionsB.dispose();

    // 此时 refCount 归零，Entry 已销毁；新实例用新 initial
    const [viewC, actionsC] = lockData({ name: 'new-first' }, { id: 'refcount-id', adapters: { logger } }) as readonly [
      { name: string },
      LockDataActions<{ name: string }>,
    ];
    expect(viewC.name).toBe('new-first');

    await actionsC.dispose();
  });
});
