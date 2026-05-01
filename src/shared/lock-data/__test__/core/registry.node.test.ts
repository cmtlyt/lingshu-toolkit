/**
 * InstanceRegistry 单元测试
 *
 * 覆盖 RFC.md「InstanceRegistry（同 id 进程内单例）」章节 L633-671 的全部契约：
 *
 * 1. 同 id 复用 —— data / driver / adapters / authority 引用稳定
 * 2. 后续 initial 忽略（RFC L660）
 * 3. listeners 每实例独立，listenersSet 按实例数累加
 * 4. 非 listeners 字段冲突 → logger.warn，以首次为准
 * 5. refCount 生命周期：归零触发 teardowns 逆序运行 + driver.destroy
 * 6. teardown / driver.destroy 异常隔离（不中断其他清理）
 * 7. releaseEntry 幂等
 * 8. Entry 销毁后 registerTeardown 成为 no-op（alive 守卫）
 * 9. 空 id 抛 TypeError
 * 10. resolveInitialData 三分支 + 异常分支
 * 11. applyInPlace（通过 Promise resolve 后 initial 原地覆写验证）
 * 12. createFailedInitError 携带 cause
 */

import { describe, expect, test, vi } from 'vitest';
import type { ResolvedAdapters } from '@/shared/lock-data/adapters/index';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import type { StorageAuthority } from '@/shared/lock-data/authority/index';
import {
  createFailedInitError,
  createInstanceRegistry,
  type Entry,
  type EntryFactory,
  freezeInitOptions,
  resolveInitialData,
} from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/types';
import { LockDisposedError } from '@/shared/lock-data/errors';
import type { LockDataListeners, LockDataOptions, LoggerAdapter } from '@/shared/lock-data/types';

// ---------------------------------------------------------------------------
// mock 工厂：最小可用的 adapters / driver / authority，不依赖浏览器环境
// ---------------------------------------------------------------------------

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

function createMockDriver(spies?: { destroy?: () => void }): LockDriver {
  return {
    acquire: vi.fn(),
    destroy: spies?.destroy || vi.fn(),
  };
}

function createMockAdapters<T>(logger?: LoggerAdapter): ResolvedAdapters<T> {
  const resolved = resolveLoggerAdapter(logger);
  return {
    logger: resolved,
    clone: <V>(value: V): V => value,
    getAuthority: () => null,
    getChannel: () => null,
    getSessionStore: () => null,
    getLock: undefined,
  };
}

/**
 * 构造一个最小 factory：按给定字段拼出 Entry，便于各测试聚焦单一关注点
 *
 * teardowns / onRegisterTeardown 用于观测 registerTeardown 注入链路是否被正确保留
 */
interface BuildFactoryArgs<T extends object> {
  readonly data: T;
  readonly driver?: LockDriver;
  readonly adapters?: ResolvedAdapters<T>;
  readonly authority?: StorageAuthority<T> | null;
  readonly onCreate?: (entry: Entry<T>) => void;
  readonly registerFirstTeardown?: () => void;
}

function buildFactory<T extends object>(args: BuildFactoryArgs<T>): EntryFactory<T> {
  return (id, options, ctx) => {
    const adapters = args.adapters || createMockAdapters<T>();
    const entry: Entry<T> = {
      id,
      data: args.data,
      driver: args.driver || createMockDriver(),
      adapters,
      authority: args.authority || null,
      listenersSet: new Set<LockDataListeners<T>>(),
      initOptions: freezeInitOptions(options),
      dataReadyPromise: null,
      registerTeardown: ctx.registerTeardown,
      refCount: 1,
      rev: 0,
      lastAppliedRev: 0,
      epoch: null,
      dataReadyState: 'ready',
      dataReadyError: undefined,
    };
    if (options.listeners) {
      entry.listenersSet.add(options.listeners);
    }
    if (args.registerFirstTeardown) {
      ctx.registerTeardown(args.registerFirstTeardown);
    }
    args.onCreate?.(entry);
    return entry;
  };
}

// ---------------------------------------------------------------------------
// createInstanceRegistry — 同 id 复用
// ---------------------------------------------------------------------------

describe('createInstanceRegistry — 同 id 复用', () => {
  test('同 id 二次 getOrCreateEntry 复用 data / driver / adapters / authority 引用', () => {
    const registry = createInstanceRegistry();
    const data = { count: 0 };
    const factory = buildFactory({ data });

    const first = registry.getOrCreateEntry<typeof data>('id-1', {}, factory);
    const second = registry.getOrCreateEntry<typeof data>('id-1', {}, factory);

    expect(second).toBe(first);
    expect(second.data).toBe(data);
    expect(second.driver).toBe(first.driver);
    expect(second.adapters).toBe(first.adapters);
  });

  test('每次复用 refCount 递增；factory 仅在首次调用', () => {
    const registry = createInstanceRegistry();
    const factory = vi.fn(buildFactory({ data: { a: 1 } }));

    const entry1 = registry.getOrCreateEntry('id-1', {}, factory);
    registry.getOrCreateEntry('id-1', {}, factory);
    registry.getOrCreateEntry('id-1', {}, factory);

    expect(entry1.refCount).toBe(3);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('listenersSet 每实例独立累加；listeners 相同对象不会重复加入', () => {
    const registry = createInstanceRegistry();
    const factory = buildFactory({ data: { a: 1 } });
    const listenersA: LockDataListeners<{ a: number }> = { onCommit: vi.fn() };
    const listenersB: LockDataListeners<{ a: number }> = { onSync: vi.fn() };

    const entry = registry.getOrCreateEntry('id-1', { listeners: listenersA }, factory);
    registry.getOrCreateEntry('id-1', { listeners: listenersB }, factory);
    // 同一 listeners 对象再次注册不会重复加入 Set
    registry.getOrCreateEntry('id-1', { listeners: listenersA }, factory);

    expect(entry.listenersSet.size).toBe(2);
    expect(entry.listenersSet.has(listenersA)).toBe(true);
    expect(entry.listenersSet.has(listenersB)).toBe(true);
  });

  test('listeners 非对象时不加入 listenersSet', () => {
    const registry = createInstanceRegistry();
    const factory = buildFactory({ data: { a: 1 } });

    const entry = registry.getOrCreateEntry('id-1', {}, factory);
    // 再次注册但不传 listeners
    registry.getOrCreateEntry('id-1', {}, factory);

    expect(entry.listenersSet.size).toBe(0);
  });

  test('peek.has / peek.size 反映当前注册表状态', () => {
    const registry = createInstanceRegistry();
    const factory = buildFactory({ data: { a: 1 } });

    expect(registry.peek.size()).toBe(0);
    expect(registry.peek.has('id-1')).toBe(false);

    registry.getOrCreateEntry('id-1', {}, factory);
    registry.getOrCreateEntry('id-2', {}, factory);

    expect(registry.peek.size()).toBe(2);
    expect(registry.peek.has('id-1')).toBe(true);
    expect(registry.peek.has('id-2')).toBe(true);
    expect(registry.peek.has('id-3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createInstanceRegistry — 冲突检查
// ---------------------------------------------------------------------------

describe('createInstanceRegistry — 冲突检查', () => {
  test('非 listeners 字段不一致触发 logger.warn，返回首次注册的 Entry', () => {
    const registry = createInstanceRegistry();
    const logger = createTestLogger();
    const adapters = createMockAdapters<{ a: number }>(logger);
    const factory = buildFactory({ data: { a: 1 }, adapters });

    const first = registry.getOrCreateEntry('id-1', { timeout: 1000, mode: 'auto' }, factory);
    const second = registry.getOrCreateEntry('id-1', { timeout: 2000, mode: 'web-locks' }, factory);

    expect(second).toBe(first);
    expect(first.initOptions.timeout).toBe(1000);
    expect(first.initOptions.mode).toBe('auto');
    expect(logger.warnMock).toHaveBeenCalledTimes(2); // timeout + mode 各一次
    // 验证 warn 消息提及 id / field / first / incoming
    const warnMessages = logger.warnMock.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes('id=id-1') && msg.includes('field=timeout'))).toBe(true);
    expect(warnMessages.some((msg) => msg.includes('field=mode'))).toBe(true);
  });

  test('所有配置字段一致时不触发 warn', () => {
    const registry = createInstanceRegistry();
    const logger = createTestLogger();
    const adapters = createMockAdapters<{ a: number }>(logger);
    const factory = buildFactory({ data: { a: 1 }, adapters });
    const options: LockDataOptions<{ a: number }> = {
      timeout: 500,
      mode: 'auto',
      syncMode: 'none',
      persistence: 'session',
    };

    registry.getOrCreateEntry('id-1', options, factory);
    registry.getOrCreateEntry('id-1', { ...options }, factory);

    expect(logger.warnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createInstanceRegistry — refCount / 销毁
// ---------------------------------------------------------------------------

describe('createInstanceRegistry — refCount / 销毁', () => {
  test('releaseEntry 把 refCount 减到 0 时触发 teardowns 逆序执行 + driver.destroy', () => {
    const registry = createInstanceRegistry();
    const order: string[] = [];
    const driver = createMockDriver({ destroy: () => order.push('driver.destroy') });
    const t1 = vi.fn(() => order.push('teardown-1'));
    const t2 = vi.fn(() => order.push('teardown-2'));
    const factory: EntryFactory<{ a: number }> = (id, options, ctx) => {
      ctx.registerTeardown(t1);
      ctx.registerTeardown(t2);
      return buildFactory({ data: { a: 1 }, driver })(id, options, ctx);
    };

    registry.getOrCreateEntry('id-1', {}, factory);
    registry.releaseEntry('id-1', undefined);

    // 逆序：t2 先于 t1
    expect(order).toEqual(['teardown-2', 'teardown-1', 'driver.destroy']);
    expect(registry.peek.has('id-1')).toBe(false);
  });

  test('refCount 未归零时不销毁 Entry', () => {
    const registry = createInstanceRegistry();
    const driver = createMockDriver();
    const teardown = vi.fn();
    const factory: EntryFactory<{ a: number }> = (id, options, ctx) => {
      ctx.registerTeardown(teardown);
      return buildFactory({ data: { a: 1 }, driver })(id, options, ctx);
    };

    registry.getOrCreateEntry('id-1', {}, factory);
    registry.getOrCreateEntry('id-1', {}, factory);
    registry.releaseEntry('id-1', undefined);

    expect(teardown).not.toHaveBeenCalled();
    expect(driver.destroy).not.toHaveBeenCalled();
    expect(registry.peek.has('id-1')).toBe(true);
  });

  test('releaseEntry 传入 listeners 时从 listenersSet 移除', () => {
    const registry = createInstanceRegistry();
    const listenersA: LockDataListeners<{ a: number }> = { onCommit: vi.fn() };
    const listenersB: LockDataListeners<{ a: number }> = { onSync: vi.fn() };
    const factory = buildFactory({ data: { a: 1 } });

    const entry = registry.getOrCreateEntry('id-1', { listeners: listenersA }, factory);
    registry.getOrCreateEntry('id-1', { listeners: listenersB }, factory);

    registry.releaseEntry('id-1', listenersA);

    expect(entry.listenersSet.has(listenersA)).toBe(false);
    expect(entry.listenersSet.has(listenersB)).toBe(true);
  });

  test('releaseEntry 在未知 id 上调用是 no-op', () => {
    const registry = createInstanceRegistry();
    expect(() => registry.releaseEntry('nonexistent', undefined)).not.toThrow();
  });

  test('refCount 已为 0 时再次 releaseEntry 是 no-op（多次 dispose 幂等）', () => {
    const registry = createInstanceRegistry();
    const driver = createMockDriver();
    const factory = buildFactory({ data: { a: 1 }, driver });

    registry.getOrCreateEntry('id-1', {}, factory);
    registry.releaseEntry('id-1', undefined);
    expect(driver.destroy).toHaveBeenCalledTimes(1);

    registry.releaseEntry('id-1', undefined);
    expect(driver.destroy).toHaveBeenCalledTimes(1);
  });

  test('单个 teardown 抛错不阻断其他 teardown 与 driver.destroy', () => {
    const registry = createInstanceRegistry();
    const logger = createTestLogger();
    const adapters = createMockAdapters<{ a: number }>(logger);
    const order: string[] = [];
    const driver = createMockDriver({ destroy: () => order.push('driver.destroy') });
    const boom = (): void => {
      order.push('teardown-throw');
      throw new Error('boom');
    };
    const okTeardown = (): void => {
      order.push('teardown-ok');
    };
    const factory: EntryFactory<{ a: number }> = (id, options, ctx) => {
      ctx.registerTeardown(okTeardown);
      ctx.registerTeardown(boom);
      return buildFactory({ data: { a: 1 }, driver, adapters })(id, options, ctx);
    };

    registry.getOrCreateEntry('id-1', {}, factory);
    expect(() => registry.releaseEntry('id-1', undefined)).not.toThrow();

    // 逆序：boom 先执行（抛错），okTeardown 继续执行
    expect(order).toEqual(['teardown-throw', 'teardown-ok', 'driver.destroy']);
    expect(logger.warnMock).toHaveBeenCalledWith(
      expect.stringContaining('teardown callback threw on id=id-1'),
      expect.any(Error),
    );
  });

  test('driver.destroy 抛错不影响销毁流程本身（logger.warn 记录）', () => {
    const registry = createInstanceRegistry();
    const logger = createTestLogger();
    const adapters = createMockAdapters<{ a: number }>(logger);
    const driver = createMockDriver({
      destroy: () => {
        throw new Error('destroy failed');
      },
    });
    const factory = buildFactory({ data: { a: 1 }, driver, adapters });

    registry.getOrCreateEntry('id-1', {}, factory);
    expect(() => registry.releaseEntry('id-1', undefined)).not.toThrow();

    expect(registry.peek.has('id-1')).toBe(false);
    expect(logger.warnMock).toHaveBeenCalledWith(
      expect.stringContaining('driver.destroy threw on id=id-1'),
      expect.any(Error),
    );
  });

  test('Entry 销毁后再调用 registerTeardown 被 alive 守卫吞掉', () => {
    const registry = createInstanceRegistry();
    let capturedRegister: ((teardown: () => void) => void) | undefined;
    const factory: EntryFactory<{ a: number }> = (id, options, ctx) => {
      capturedRegister = ctx.registerTeardown;
      return buildFactory({ data: { a: 1 } })(id, options, ctx);
    };

    registry.getOrCreateEntry('id-1', {}, factory);
    registry.releaseEntry('id-1', undefined);

    const lateTeardown = vi.fn();
    // 销毁后再调用 registerTeardown 不应抛错、不应执行回调
    expect(() => capturedRegister?.(lateTeardown)).not.toThrow();
    expect(lateTeardown).not.toHaveBeenCalled();
  });

  test('registerTeardown 对非 function 入参静默忽略', () => {
    const registry = createInstanceRegistry();
    let capturedRegister: ((teardown: () => void) => void) | undefined;
    const factory: EntryFactory<{ a: number }> = (id, options, ctx) => {
      capturedRegister = ctx.registerTeardown;
      return buildFactory({ data: { a: 1 } })(id, options, ctx);
    };

    registry.getOrCreateEntry('id-1', {}, factory);

    expect(() => capturedRegister?.(null as unknown as () => void)).not.toThrow();
    expect(() => capturedRegister?.(undefined as unknown as () => void)).not.toThrow();
    expect(() => capturedRegister?.('not a function' as unknown as () => void)).not.toThrow();
  });

  test('不同 id 的 Entry 独立销毁，互不影响', () => {
    const registry = createInstanceRegistry();
    const driver1 = createMockDriver();
    const driver2 = createMockDriver();
    const teardown1 = vi.fn();
    const teardown2 = vi.fn();
    const factory1: EntryFactory<{ a: number }> = (id, options, ctx) => {
      ctx.registerTeardown(teardown1);
      return buildFactory({ data: { a: 1 }, driver: driver1 })(id, options, ctx);
    };
    const factory2: EntryFactory<{ a: number }> = (id, options, ctx) => {
      ctx.registerTeardown(teardown2);
      return buildFactory({ data: { a: 2 }, driver: driver2 })(id, options, ctx);
    };

    registry.getOrCreateEntry('id-1', {}, factory1);
    registry.getOrCreateEntry('id-2', {}, factory2);
    registry.releaseEntry('id-1', undefined);

    expect(teardown1).toHaveBeenCalledTimes(1);
    expect(driver1.destroy).toHaveBeenCalledTimes(1);
    expect(teardown2).not.toHaveBeenCalled();
    expect(driver2.destroy).not.toHaveBeenCalled();
    expect(registry.peek.has('id-2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createInstanceRegistry — 参数校验
// ---------------------------------------------------------------------------

describe('createInstanceRegistry — 参数校验', () => {
  test('空字符串 id 抛 TypeError', () => {
    const registry = createInstanceRegistry();
    const factory = buildFactory({ data: { a: 1 } });

    expect(() => registry.getOrCreateEntry('', {}, factory)).toThrow(TypeError);
  });

  test('factory 抛错不会污染 Registry（后续同 id 再次调用走 miss 分支）', () => {
    const registry = createInstanceRegistry();
    const failingFactory: EntryFactory<{ a: number }> = () => {
      throw new Error('factory failed');
    };
    expect(() => registry.getOrCreateEntry('id-1', {}, failingFactory)).toThrow('factory failed');
    expect(registry.peek.has('id-1')).toBe(false);

    // 再次调用能正常走 miss 分支
    const okFactory = buildFactory({ data: { a: 1 } });
    const entry = registry.getOrCreateEntry('id-1', {}, okFactory);
    expect(entry.refCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// freezeInitOptions
// ---------------------------------------------------------------------------

describe('freezeInitOptions', () => {
  test('返回对象被 Object.freeze', () => {
    const frozen = freezeInitOptions({ timeout: 1000, mode: 'auto' });
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  test('仅包含冲突检查相关字段', () => {
    const frozen = freezeInitOptions({
      timeout: 1000,
      mode: 'auto',
      syncMode: 'storage-authority',
      persistence: 'session',
      sessionProbeTimeout: 100,
      // 以下字段不参与冲突检查
      id: 'id-1',
      listeners: { onCommit: vi.fn() },
    });

    expect(frozen.timeout).toBe(1000);
    expect(frozen.mode).toBe('auto');
    expect(frozen.syncMode).toBe('storage-authority');
    expect(frozen.persistence).toBe('session');
    expect(frozen.sessionProbeTimeout).toBe(100);
    expect('id' in frozen).toBe(false);
    expect('listeners' in frozen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveInitialData — 三分支
// ---------------------------------------------------------------------------

describe('resolveInitialData — 无 getValue（同步分支）', () => {
  test('initial 存在时直接作为 data，状态 ready，Promise null', () => {
    const logger = resolveLoggerAdapter();
    const initial = { count: 1 };
    const patch = resolveInitialData({}, initial, logger, vi.fn());

    expect(patch.data).toBe(initial);
    expect(patch.dataReadyPromise).toBeNull();
    expect(patch.dataReadyState).toBe('ready');
    expect(patch.dataReadyError).toBeUndefined();
  });

  test('initial 为 undefined 抛 TypeError（同步分支契约违反）', () => {
    const logger = resolveLoggerAdapter();
    expect(() => resolveInitialData<{ a: number }>({}, undefined, logger, vi.fn())).toThrow(TypeError);
  });
});

describe('resolveInitialData — getValue 同步返回', () => {
  test('同步返回值覆盖 initial（RFC L141）', () => {
    const logger = resolveLoggerAdapter();
    const initial = { count: 0 };
    const fromGetValue = { count: 99 };
    const patch = resolveInitialData({ getValue: () => fromGetValue }, initial, logger, vi.fn());

    expect(patch.data).toBe(fromGetValue);
    expect(patch.data).not.toBe(initial);
    expect(patch.dataReadyState).toBe('ready');
    expect(patch.dataReadyPromise).toBeNull();
  });

  test('getValue 同步抛错进入 failed 分支；onStateChange 被立即通知', () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const stateChanges: Array<{ state: string; error: unknown }> = [];
    const onStateChange = (state: 'pending' | 'ready' | 'failed', error: unknown): void => {
      stateChanges.push({ state, error });
    };
    const boom = new Error('getValue sync error');

    const patch = resolveInitialData(
      {
        getValue: (): never => {
          throw boom;
        },
      },
      { count: 0 },
      resolved,
      onStateChange,
    );

    expect(patch.dataReadyState).toBe('failed');
    expect(patch.dataReadyError).toBe(boom);
    expect(stateChanges).toEqual([{ state: 'failed', error: boom }]);
    expect(patch.dataReadyPromise).toBeInstanceOf(Promise);
    // 等待 reject，确认带原始 reason
    return expect(patch.dataReadyPromise).rejects.toBe(boom);
  });
});

describe('resolveInitialData — getValue 返回 Promise', () => {
  test('resolve 后 applyInPlace 原地覆写 initial 引用（引用稳定）', async () => {
    const logger = resolveLoggerAdapter();
    const initial = { count: 0, name: 'old' };
    const onStateChange = vi.fn();
    const patch = resolveInitialData<typeof initial>(
      { getValue: () => Promise.resolve({ count: 99, name: 'new' }) },
      initial,
      logger,
      onStateChange,
    );

    expect(patch.data).toBe(initial); // 引用不变
    expect(patch.dataReadyState).toBe('pending');

    await patch.dataReadyPromise;

    // 内容被 in-place 覆写，引用仍为 initial
    expect(patch.data).toBe(initial);
    expect(initial.count).toBe(99);
    expect(initial.name).toBe('new');
    expect(onStateChange).toHaveBeenCalledWith('ready', undefined);
  });

  test('resolve 后覆写 Symbol key（Reflect.ownKeys 路径）', async () => {
    const logger = resolveLoggerAdapter();
    const sym = Symbol('meta');
    const initial: Record<string | symbol, unknown> = { a: 1, [sym]: 'orig' };
    const next: Record<string | symbol, unknown> = { b: 2, [sym]: 'next' };
    const patch = resolveInitialData({ getValue: () => Promise.resolve(next) }, initial, logger, vi.fn());
    await patch.dataReadyPromise;

    expect(initial.a).toBeUndefined();
    expect(initial.b).toBe(2);
    expect(initial[sym]).toBe('next');
  });

  test('resolve 后覆写数组（长度截断 + push）', async () => {
    const logger = resolveLoggerAdapter();
    const initial: number[] = [1, 2, 3, 4, 5];
    const patch = resolveInitialData({ getValue: () => Promise.resolve([10, 20]) }, initial, logger, vi.fn());
    await patch.dataReadyPromise;

    expect(initial).toEqual([10, 20]);
    expect(initial.length).toBe(2);
  });

  test('source 为对象但 initial 为数组时 applyInPlace 抛错 → failed 态', async () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const initial: number[] = [1, 2];
    const onStateChange = vi.fn();
    const patch = resolveInitialData<unknown[]>(
      { getValue: () => Promise.resolve({ 0: 10, 1: 20 } as unknown as number[]) },
      initial,
      resolved,
      onStateChange,
    );

    await expect(patch.dataReadyPromise).rejects.toThrow(TypeError);
    expect(onStateChange).toHaveBeenCalledWith('failed', expect.any(TypeError));
    expect(logger.errorMock).toHaveBeenCalledWith(
      expect.stringContaining('failed to apply getValue result in-place'),
      expect.any(Error),
    );
  });

  test('Promise reject → failed 态，reject 原因透传', async () => {
    const logger = resolveLoggerAdapter();
    const onStateChange = vi.fn();
    const reason = new Error('fetch failed');
    const patch = resolveInitialData<{ a: number }>(
      { getValue: () => Promise.reject(reason) },
      { a: 0 },
      logger,
      onStateChange,
    );

    expect(patch.dataReadyState).toBe('pending');

    await expect(patch.dataReadyPromise).rejects.toBe(reason);
    expect(onStateChange).toHaveBeenCalledWith('failed', reason);
  });

  test('initial 为 undefined 时使用 {} 占位并 logger.warn', async () => {
    const logger = createTestLogger();
    const resolved = resolveLoggerAdapter(logger);
    const patch = resolveInitialData<{ count: number }>(
      { getValue: () => Promise.resolve({ count: 42 }) },
      undefined,
      resolved,
      vi.fn(),
    );

    expect(patch.data).toEqual({});
    expect(logger.warnMock).toHaveBeenCalledWith(
      expect.stringContaining('initial data is undefined during async getValue'),
    );

    await patch.dataReadyPromise;
    expect(patch.data).toEqual({ count: 42 });
  });
});

// ---------------------------------------------------------------------------
// createFailedInitError
// ---------------------------------------------------------------------------

describe('createFailedInitError', () => {
  test('产出 LockDisposedError 实例，cause 字段携带原始原因', () => {
    const original = new Error('network timeout');
    const err = createFailedInitError('id-1', original);

    expect(err).toBeInstanceOf(LockDisposedError);
    expect(err.message).toContain('id=id-1');
    expect(err.message).toContain('initialization failed during getValue');
    // Error cause 是 ES2022 标准字段
    expect((err as Error & { cause?: unknown }).cause).toBe(original);
  });

  test('cause 为非 Error 原因也能被保留', () => {
    const err = createFailedInitError('id-1', 'string reason');
    expect((err as Error & { cause?: unknown }).cause).toBe('string reason');
  });
});
