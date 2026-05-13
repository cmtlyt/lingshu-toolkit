/**
 * InstanceRegistry 单元测试
 *
 * 覆盖 RFC.md「InstanceRegistry（同 id 进程内单例）」章节的全部契约：
 *
 * 1. 同 id 复用 —— dataRef / driver / adapters / authority 引用稳定
 * 2. listeners 每实例独立，listenersSet 按实例数累加
 * 3. 非 listeners 字段冲突 → logger.warn，以首次为准
 * 4. refCount 生命周期：归零触发 teardowns 逆序运行 + driver.destroy
 * 5. teardown / driver.destroy 异常隔离（不中断其他清理）
 * 6. releaseEntry 幂等
 * 7. Entry 销毁后 registerTeardown 成为 no-op（alive 守卫）
 * 8. 空 id 抛 TypeError
 * 9. prepareEntryData 同步 / 异步路径 + 同步抛错 fail-fast 路径
 * 10. 顶层数组运行时拒绝（assertJsonSafeInput 拦截）
 * 11. createFailedInitError 携带 cause
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
  prepareEntryData,
} from '@/shared/lock-data/core/registry';
import type { LockDriver } from '@/shared/lock-data/drivers/types';
import { InvalidOptionsError, LockDisposedError } from '@/shared/lock-data/errors';
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
  return (id, lockId, options, ctx) => {
    // Registry 路径下永远 lockId === id；防回归校验（本测试文件仅覆盖 InstanceRegistry，
    // 不涉及 standalone 调用）。用 throw 而非 expect —— biome `useExpectAssertions`
    // 不允许 expect 出现在 test() 外部的工厂函数里
    if (lockId !== id) {
      throw new Error(`buildFactory: lockId (${String(lockId)}) must equal id (${id}) on Registry path`);
    }
    const adapters = args.adapters || createMockAdapters<T>();
    const dataRef = { current: args.data };
    const entry: Entry<T> = {
      id,
      lockId,
      dataRef,
      applyRemote: (next: T): void => {
        dataRef.current = next;
      },
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

/**
 * 公共 mock options：满足 LockDataOptions<{a: number}>.getValue 必传约束
 *
 * 使用场景：测试用例聚焦 Registry 的 `getOrCreateEntry` 行为本身（refCount / factory 调用次数 /
 * teardown 注册等），不关心 getValue 实际执行；mock factory 也不会真的调用 getValue。
 *
 * 类型断言为 `LockDataOptions<{ a: number }>` 让 sed 批量替换后无须每处都写完整泛型。
 */
const noopOptions = {
  getValue: (): { a: number } => {
    return { a: 1 };
  },
};

// ---------------------------------------------------------------------------
// createInstanceRegistry — 同 id 复用
// ---------------------------------------------------------------------------

describe('createInstanceRegistry — 同 id 复用', () => {
  test('同 id 二次 getOrCreateEntry 复用 dataRef / driver / adapters / authority 引用', () => {
    const registry = createInstanceRegistry();
    const data = { count: 0 };
    const factory = buildFactory({ data });

    // typeof data 是 { count: number }，不同于 noopOptions 的 { a: number } 泛型；
    // 这里 mock factory 不会真正调用 getValue，构造一个匹配类型的 mock 即可
    const mockOptions = {
      getValue: (): typeof data => {
        return { count: 0 };
      },
    };
    const first = registry.getOrCreateEntry<typeof data>('id-1', mockOptions, factory);
    const second = registry.getOrCreateEntry<typeof data>('id-1', mockOptions, factory);

    expect(second).toBe(first);
    // wrapper 方案：dataRef wrapper 引用稳定（同一对象）；dataRef.current 指向用户传入的初始数据
    expect(second.dataRef).toBe(first.dataRef);
    expect(second.dataRef.current).toBe(data);
    expect(second.driver).toBe(first.driver);
    expect(second.adapters).toBe(first.adapters);
  });

  test('每次复用 refCount 递增；factory 仅在首次调用', () => {
    const registry = createInstanceRegistry();
    const factory = vi.fn(buildFactory({ data: { a: 1 } }));

    const entry1 = registry.getOrCreateEntry('id-1', noopOptions, factory);
    registry.getOrCreateEntry('id-1', noopOptions, factory);
    registry.getOrCreateEntry('id-1', noopOptions, factory);

    expect(entry1.refCount).toBe(3);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('listenersSet 每实例独立累加；listeners 相同对象不会重复加入', () => {
    const registry = createInstanceRegistry();
    const factory = buildFactory({ data: { a: 1 } });
    const listenersA: LockDataListeners<{ a: number }> = { onCommit: vi.fn() };
    const listenersB: LockDataListeners<{ a: number }> = { onSync: vi.fn() };

    const entry = registry.getOrCreateEntry('id-1', { ...noopOptions, listeners: listenersA }, factory);
    registry.getOrCreateEntry('id-1', { ...noopOptions, listeners: listenersB }, factory);
    // 同一 listeners 对象再次注册不会重复加入 Set
    registry.getOrCreateEntry('id-1', { ...noopOptions, listeners: listenersA }, factory);

    expect(entry.listenersSet.size).toBe(2);
    expect(entry.listenersSet.has(listenersA)).toBe(true);
    expect(entry.listenersSet.has(listenersB)).toBe(true);
  });

  test('listeners 非对象时不加入 listenersSet', () => {
    const registry = createInstanceRegistry();
    const factory = buildFactory({ data: { a: 1 } });

    const entry = registry.getOrCreateEntry('id-1', noopOptions, factory);
    // 再次注册但不传 listeners
    registry.getOrCreateEntry('id-1', noopOptions, factory);

    expect(entry.listenersSet.size).toBe(0);
  });

  test('peek.has / peek.size 反映当前注册表状态', () => {
    const registry = createInstanceRegistry();
    const factory = buildFactory({ data: { a: 1 } });

    expect(registry.peek.size()).toBe(0);
    expect(registry.peek.has('id-1')).toBe(false);

    registry.getOrCreateEntry('id-1', noopOptions, factory);
    registry.getOrCreateEntry('id-2', noopOptions, factory);

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

    const first = registry.getOrCreateEntry('id-1', { ...noopOptions, timeout: 1000, mode: 'auto' }, factory);
    const second = registry.getOrCreateEntry('id-1', { ...noopOptions, timeout: 2000, mode: 'web-locks' }, factory);

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
      ...noopOptions,
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
    const factory: EntryFactory<{ a: number }> = (id, lockId, options, ctx) => {
      ctx.registerTeardown(t1);
      ctx.registerTeardown(t2);
      return buildFactory({ data: { a: 1 }, driver })(id, lockId, options, ctx);
    };

    registry.getOrCreateEntry('id-1', noopOptions, factory);
    registry.releaseEntry('id-1', undefined);

    // 逆序：t2 先于 t1
    expect(order).toEqual(['teardown-2', 'teardown-1', 'driver.destroy']);
    expect(registry.peek.has('id-1')).toBe(false);
  });

  test('refCount 未归零时不销毁 Entry', () => {
    const registry = createInstanceRegistry();
    const driver = createMockDriver();
    const teardown = vi.fn();
    const factory: EntryFactory<{ a: number }> = (id, lockId, options, ctx) => {
      ctx.registerTeardown(teardown);
      return buildFactory({ data: { a: 1 }, driver })(id, lockId, options, ctx);
    };

    registry.getOrCreateEntry('id-1', noopOptions, factory);
    registry.getOrCreateEntry('id-1', noopOptions, factory);
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

    const entry = registry.getOrCreateEntry('id-1', { ...noopOptions, listeners: listenersA }, factory);
    registry.getOrCreateEntry('id-1', { ...noopOptions, listeners: listenersB }, factory);

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

    registry.getOrCreateEntry('id-1', noopOptions, factory);
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
    const factory: EntryFactory<{ a: number }> = (id, lockId, options, ctx) => {
      ctx.registerTeardown(okTeardown);
      ctx.registerTeardown(boom);
      return buildFactory({ data: { a: 1 }, driver, adapters })(id, lockId, options, ctx);
    };

    registry.getOrCreateEntry('id-1', noopOptions, factory);
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

    registry.getOrCreateEntry('id-1', noopOptions, factory);
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
    const factory: EntryFactory<{ a: number }> = (id, lockId, options, ctx) => {
      capturedRegister = ctx.registerTeardown;
      return buildFactory({ data: { a: 1 } })(id, lockId, options, ctx);
    };

    registry.getOrCreateEntry('id-1', noopOptions, factory);
    registry.releaseEntry('id-1', undefined);

    const lateTeardown = vi.fn();
    // 销毁后再调用 registerTeardown 不应抛错、不应执行回调
    expect(() => capturedRegister?.(lateTeardown)).not.toThrow();
    expect(lateTeardown).not.toHaveBeenCalled();
  });

  test('registerTeardown 对非 function 入参静默忽略', () => {
    const registry = createInstanceRegistry();
    let capturedRegister: ((teardown: () => void) => void) | undefined;
    const factory: EntryFactory<{ a: number }> = (id, lockId, options, ctx) => {
      capturedRegister = ctx.registerTeardown;
      return buildFactory({ data: { a: 1 } })(id, lockId, options, ctx);
    };

    registry.getOrCreateEntry('id-1', noopOptions, factory);

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
    const factory1: EntryFactory<{ a: number }> = (id, lockId, options, ctx) => {
      ctx.registerTeardown(teardown1);
      return buildFactory({ data: { a: 1 }, driver: driver1 })(id, lockId, options, ctx);
    };
    const factory2: EntryFactory<{ a: number }> = (id, lockId, options, ctx) => {
      ctx.registerTeardown(teardown2);
      return buildFactory({ data: { a: 2 }, driver: driver2 })(id, lockId, options, ctx);
    };

    registry.getOrCreateEntry('id-1', noopOptions, factory1);
    registry.getOrCreateEntry('id-2', noopOptions, factory2);
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

    expect(() => registry.getOrCreateEntry('', noopOptions, factory)).toThrow(TypeError);
  });

  test('factory 抛错不会污染 Registry（后续同 id 再次调用走 miss 分支）', () => {
    const registry = createInstanceRegistry();
    const failingFactory: EntryFactory<{ a: number }> = () => {
      throw new Error('factory failed');
    };
    expect(() => registry.getOrCreateEntry('id-1', noopOptions, failingFactory)).toThrow('factory failed');
    expect(registry.peek.has('id-1')).toBe(false);

    // 再次调用能正常走 miss 分支
    const okFactory = buildFactory({ data: { a: 1 } });
    const entry = registry.getOrCreateEntry('id-1', noopOptions, okFactory);
    expect(entry.refCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// freezeInitOptions
// ---------------------------------------------------------------------------

describe('freezeInitOptions', () => {
  // 公共 mock：freezeInitOptions 仅裁剪冲突字段，不会真正调用 getValue；
  // 用 noop fn 满足 LockDataOptions<T> 的 getValue 必传约束
  const noopGetValue = (): { a: number } => {
    return { a: 1 };
  };

  test('返回对象被 Object.freeze', () => {
    const frozen = freezeInitOptions<{ a: number }>({ getValue: noopGetValue, timeout: 1000, mode: 'auto' });
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  test('仅包含冲突检查相关字段', () => {
    const frozen = freezeInitOptions<{ a: number }>({
      getValue: noopGetValue,
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
    expect('getValue' in frozen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prepareEntryData — 同步路径
// ---------------------------------------------------------------------------

describe('prepareEntryData — 同步 getValue', () => {
  test('同步返回 plain object → firstValue 经 cloneByJson 隔离，dataReadyPromise 为 null', () => {
    const original = { count: 7, label: 'sync' };
    const result = prepareEntryData('id-sync-1', { getValue: () => original });

    expect(result.dataReadyPromise).toBeNull();
    expect(result.firstValue).toEqual(original);
    // JSON 拷贝隔离：firstValue 必须是独立副本，原对象后续 mutate 不影响 firstValue
    expect(result.firstValue).not.toBe(original);
    original.count = 999;
    expect(result.firstValue.count).toBe(7);
  });

  test('getValue 缺失（运行时校验兜底）→ TypeError', () => {
    expect(() => prepareEntryData<{ a: number }>('id-missing', {} as LockDataOptions<{ a: number }>)).toThrow(
      TypeError,
    );
  });

  test('getValue 同步抛错 → fail-fast LockDisposedError（cause 携带原始原因）', () => {
    const boom = new Error('sync getValue error');
    let captured: unknown;
    try {
      prepareEntryData('id-sync-throw', {
        getValue: (): never => {
          throw boom;
        },
      });
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(LockDisposedError);
    expect((captured as Error).message).toContain('id=id-sync-throw');
    expect((captured as Error & { cause?: unknown }).cause).toBe(boom);
  });

  test('同步返回顶层数组 → InvalidOptionsError（运行时双重 fail-fast）', () => {
    expect(() =>
      prepareEntryData('id-top-array', {
        // 运行时类型擦除路径下顶层数组也会被拦截
        getValue: () => [1, 2, 3] as unknown as { count: number },
      }),
    ).toThrow(InvalidOptionsError);
  });

  test('同步返回非 JSON-safe 值（含 Date 字段）→ TypeError', () => {
    expect(() =>
      prepareEntryData('id-not-json-safe', {
        getValue: () => ({ when: new Date() }) as unknown as { count: number },
      }),
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// prepareEntryData — 异步路径
// ---------------------------------------------------------------------------

describe('prepareEntryData — 异步 getValue', () => {
  test('Promise resolve → dataReadyPromise 携带 awaited 真实首值', async () => {
    const result = prepareEntryData('id-async-1', {
      getValue: () => Promise.resolve({ count: 42, label: 'async' }),
    });

    expect(result.dataReadyPromise).toBeInstanceOf(Promise);
    // 占位 firstValue：在 resolve 前作为 dataRef.current 的填充值
    expect(result.firstValue).toEqual({});

    const awaited = await result.dataReadyPromise;
    expect(awaited).toEqual({ count: 42, label: 'async' });
  });

  test('Promise reject → dataReadyPromise reject 为 LockDisposedError（cause 携带原始 reason）', async () => {
    const reason = new Error('fetch failed');
    const result = prepareEntryData<{ a: number }>('id-async-reject', {
      getValue: () => Promise.reject(reason),
    });

    expect(result.dataReadyPromise).toBeInstanceOf(Promise);
    await expect(result.dataReadyPromise).rejects.toBeInstanceOf(LockDisposedError);
    await expect(result.dataReadyPromise).rejects.toMatchObject({ cause: reason });
  });

  test('Promise resolve 顶层数组 → reject 为 LockDisposedError（cause = InvalidOptionsError）', async () => {
    const result = prepareEntryData<{ a: number }>('id-async-top-array', {
      getValue: () => Promise.resolve([1, 2, 3] as unknown as { a: number }),
    });

    await expect(result.dataReadyPromise).rejects.toBeInstanceOf(LockDisposedError);
    await expect(result.dataReadyPromise).rejects.toMatchObject({
      cause: expect.any(InvalidOptionsError),
    });
  });

  test('Promise resolve 非 JSON-safe（含 Map 字段）→ reject 为 LockDisposedError（cause = TypeError）', async () => {
    const result = prepareEntryData<{ a: number }>('id-async-not-json-safe', {
      getValue: () => Promise.resolve({ a: 1, m: new Map() } as unknown as { a: number }),
    });

    await expect(result.dataReadyPromise).rejects.toBeInstanceOf(LockDisposedError);
    await expect(result.dataReadyPromise).rejects.toMatchObject({
      cause: expect.any(TypeError),
    });
  });

  test('多次 await 同一 dataReadyPromise 拿到相同结果（共享语义）', async () => {
    // 同 Tab 二次 lockData 调用方的核心场景：refCount++ 后共享 dataReadyPromise
    const result = prepareEntryData('id-shared', {
      getValue: () => Promise.resolve({ a: 200 }),
    });

    const [first, second] = await Promise.all([result.dataReadyPromise, result.dataReadyPromise]);
    expect(first).toEqual({ a: 200 });
    expect(second).toEqual({ a: 200 });
    expect(first).toBe(second);
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
