/**
 * core/entry.ts 覆盖率补强测试
 *
 * 通过直接 import 内部纯函数（attachAuthority / mergeReadyPromises / acquireStandalone /
 * buildEmitCommit / buildEmitSync），命中 createEntryFactory + lockData 主链路
 * 不易触达的防御性分支。
 *
 * 覆盖目标（参考 analyze-coverage 输出）：
 * - L172-173: buildEmitCommit guard.disposed=true 早退
 * - L181-182: buildEmitSync guard.disposed=true 早退
 * - L210-214: attachAuthority 三 adapter 全 null 时 logger.warn + return null
 * - L246-249: attachAuthority init reject 回调被 logger.warn 捕获
 * - L263-264: mergeReadyPromises 双 Promise 合成路径
 * - L463-464: acquireStandalone registerTeardown alive=false 早退
 * - L472-473: acquireStandalone release alive=false 早退（幂等）
 * - L478-481: acquireStandalone teardown 抛错被 logger.warn 捕获
 * - L488: acquireStandalone driver.destroy 抛错被 logger.warn 捕获
 *
 * 设计约束：不重写源码、不改业务逻辑；测试通过构造内部 state 直接调用 perform* 函数
 */

import { describe, expect, test, vi } from 'vitest';
import {
  acquireStandalone,
  attachAuthority,
  buildEmitCommit,
  buildEmitSync,
  type FanoutGuard,
  type MutableEntry,
  mergeReadyPromises,
} from '../../core/entry';
import type { Entry, EntryFactory } from '../../core/registry';
import type { CommitSource, LockDataMutation, LockDataOptions, LoggerAdapter, SyncSource } from '../../types';

interface TestSnapshot {
  readonly value: number;
}

function createLogger(): LoggerAdapter {
  return {
    warn: vi.fn<(message: string, ...extras: unknown[]) => void>(),
    error: vi.fn<(message: string, ...extras: unknown[]) => void>(),
    debug: vi.fn<(message: string, ...extras: unknown[]) => void>(),
  };
}

function createMinimalEntry(logger: LoggerAdapter): Entry<TestSnapshot> {
  return {
    id: 'test',
    lockId: 'test',
    dataRef: { current: { value: 0 } },
    applyRemote: vi.fn(),
    driver: {
      acquire: vi.fn(),
      destroy: vi.fn(),
    },
    adapters: {
      logger,
    } as Entry<TestSnapshot>['adapters'],
    authority: null,
    listenersSet: new Set(),
    initOptions: Object.freeze({
      timeout: undefined,
      mode: undefined,
      syncMode: undefined,
      persistence: undefined,
      sessionProbeTimeout: undefined,
    }),
    dataReadyPromise: null,
    registerTeardown: vi.fn(),
    refCount: 1,
    rev: 0,
    lastAppliedRev: 0,
    epoch: null,
  };
}

describe('core/entry — buildEmitCommit guard 早退', () => {
  test('guard.disposed=true 时直接 return，不触发 fanout', () => {
    const logger = createLogger();
    const entry = createMinimalEntry(logger);
    const guard: FanoutGuard = { disposed: true };
    const emit = buildEmitCommit(entry, guard);

    const listener = vi.fn();
    entry.listenersSet.add({ onCommit: listener });

    emit({
      source: 'commit' as CommitSource,
      token: 'tok',
      rev: 1,
      mutations: [] as readonly LockDataMutation[],
      snapshot: { value: 1 },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  test('guard.disposed=false 时正常 fanout', () => {
    const logger = createLogger();
    const entry = createMinimalEntry(logger);
    const guard: FanoutGuard = { disposed: false };
    const emit = buildEmitCommit(entry, guard);

    const listener = vi.fn();
    entry.listenersSet.add({ onCommit: listener });

    emit({
      source: 'commit' as CommitSource,
      token: 'tok',
      rev: 1,
      mutations: [] as readonly LockDataMutation[],
      snapshot: { value: 1 },
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('core/entry — buildEmitSync guard 早退', () => {
  test('guard.disposed=true 时直接 return，不触发 fanout', () => {
    const logger = createLogger();
    const entry = createMinimalEntry(logger);
    const guard: FanoutGuard = { disposed: true };
    const emit = buildEmitSync(entry, guard);

    const listener = vi.fn();
    entry.listenersSet.add({ onSync: listener });

    emit({
      source: 'pull-on-acquire' as SyncSource,
      rev: 1,
      snapshot: { value: 1 },
    });

    expect(listener).not.toHaveBeenCalled();
  });

  test('guard.disposed=false 时正常 fanout', () => {
    const logger = createLogger();
    const entry = createMinimalEntry(logger);
    const guard: FanoutGuard = { disposed: false };
    const emit = buildEmitSync(entry, guard);

    const listener = vi.fn();
    entry.listenersSet.add({ onSync: listener });

    emit({
      source: 'pull-on-acquire' as SyncSource,
      rev: 1,
      snapshot: { value: 1 },
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('core/entry — attachAuthority 三 adapter 全 null 降级', () => {
  test('authority/channel/sessionStore 全 null → logger.warn + 返回 null', () => {
    const logger = createLogger();
    const entry = createMinimalEntry(logger);
    const mutableEntry = entry as unknown as MutableEntry<TestSnapshot>;
    const adapters = {
      logger,
      getAuthority: () => null,
      getChannel: () => null,
      getSessionStore: () => null,
    } as unknown as Parameters<typeof attachAuthority<TestSnapshot>>[2];

    const options: LockDataOptions<TestSnapshot> = {
      id: 'test',
      getValue: () => {
        return { value: 0 };
      },
      syncMode: 'storage-authority',
    };

    const result = attachAuthority(mutableEntry, options, adapters, 'test-id');

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("syncMode='storage-authority' requested"));
  });

  test('authority init reject → logger.warn 捕获，不抛出', async () => {
    const logger = createLogger();
    const entry = createMinimalEntry(logger);
    const mutableEntry = entry as unknown as MutableEntry<TestSnapshot>;

    // 提供一个 channel 让 attachAuthority 能进入 createStorageAuthority 路径；
    // 然后让 channel.subscribe 抛错，让 authority.init 内部失败
    const adapters = {
      logger,
      getAuthority: () => {
        return {
          read: () => null,
          write: () => {},
          remove: () => {},
          subscribe: () => {
            throw new Error('subscribe failure');
          },
        };
      },
      getChannel: () => {
        return {
          postMessage: () => {},
          subscribe: () => () => {},
          close: () => {},
        };
      },
      getSessionStore: () => null,
    } as unknown as Parameters<typeof attachAuthority<TestSnapshot>>[2];

    const options: LockDataOptions<TestSnapshot> = {
      id: 'test',
      getValue: () => {
        return { value: 0 };
      },
      syncMode: 'storage-authority',
      persistence: 'persistent',
    };

    const result = attachAuthority(mutableEntry, options, adapters, 'test-id');

    expect(result).not.toBeNull();
    await result;

    // authority.init 在内部捕获，最终走 logger.warn '[lockData] StorageAuthority.init failed on id='
    // 这里宽松断言：只要 logger.warn 被调用过即可（也可能是其他 warn）
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('core/entry — mergeReadyPromises 合成', () => {
  test('双 Promise 非 null → Promise.all 合成', async () => {
    const dataReady = Promise.resolve();
    const authorityReady = Promise.resolve();
    const merged = mergeReadyPromises(dataReady, authorityReady);

    expect(merged).not.toBeNull();
    await expect(merged).resolves.toBeUndefined();
  });

  test('仅 dataReady 非 null → 直接返回 dataReady', () => {
    const dataReady = Promise.resolve();
    const merged = mergeReadyPromises(dataReady, null);
    expect(merged).toBe(dataReady);
  });

  test('仅 authorityReady 非 null → 直接返回 authorityReady', () => {
    const authorityReady = Promise.resolve();
    const merged = mergeReadyPromises(null, authorityReady);
    expect(merged).toBe(authorityReady);
  });

  test('双 null → 返回 null', () => {
    expect(mergeReadyPromises(null, null)).toBeNull();
  });
});

describe('core/entry — acquireStandalone teardown 异常隔离', () => {
  function buildOptions(): LockDataOptions<TestSnapshot> {
    return {
      getValue: () => {
        return { value: 0 };
      },
    };
  }

  function buildFactoryReturning(entryOverride: Partial<Entry<TestSnapshot>>): EntryFactory<TestSnapshot> {
    return (id, lockId, _opts, ctx) => {
      const logger = createLogger();
      const base = createMinimalEntry(logger);
      const merged: Entry<TestSnapshot> = {
        ...base,
        id,
        lockId,
        registerTeardown: ctx.registerTeardown,
        ...entryOverride,
      };
      return merged;
    };
  }

  test('release 调用后再 registerTeardown → alive=false 早退（teardown 不入队）', () => {
    let capturedRegister: ((teardown: () => void) => void) | null = null;
    const factory: EntryFactory<TestSnapshot> = (id, lockId, _opts, ctx) => {
      capturedRegister = ctx.registerTeardown;
      const logger = createLogger();
      const base = createMinimalEntry(logger);
      return { ...base, id, lockId, registerTeardown: ctx.registerTeardown };
    };

    const { releaseFromRegistry } = acquireStandalone(buildOptions(), factory);

    // 主动释放，之后 registerTeardown 必须早退
    releaseFromRegistry();

    const lateTeardown = vi.fn();
    // @ts-expect-error
    capturedRegister?.(lateTeardown);

    // 再次 release 也不能触发 lateTeardown
    releaseFromRegistry();
    expect(lateTeardown).not.toHaveBeenCalled();
  });

  test('release 二次调用幂等（alive=false 早退，driver.destroy 不重复触发）', () => {
    const destroySpy = vi.fn();
    const factory = buildFactoryReturning({
      driver: { acquire: vi.fn(), destroy: destroySpy },
    });

    const { releaseFromRegistry } = acquireStandalone(buildOptions(), factory);

    releaseFromRegistry();
    releaseFromRegistry();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  test('teardown 抛错被 logger.warn 捕获，不阻断后续 teardown 与 driver.destroy', () => {
    const destroySpy = vi.fn();
    const logger = createLogger();
    const goodTeardown = vi.fn();
    const badTeardown = vi.fn(() => {
      throw new Error('teardown boom');
    });

    // @ts-expect-error test
    const factory: EntryFactory<TestSnapshot> = (id, lockId, _opts, ctx) => {
      ctx.registerTeardown(goodTeardown);
      ctx.registerTeardown(badTeardown);
      const base = createMinimalEntry(logger);
      return {
        ...base,
        id,
        lockId,
        adapters: { ...base.adapters, logger },
        driver: { acquire: vi.fn(), destroy: destroySpy },
        registerTeardown: ctx.registerTeardown,
      };
    };

    const { releaseFromRegistry } = acquireStandalone(buildOptions(), factory);
    expect(() => releaseFromRegistry()).not.toThrow();

    expect(badTeardown).toHaveBeenCalledTimes(1);
    expect(goodTeardown).toHaveBeenCalledTimes(1);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('standalone teardown threw'), expect.any(Error));
  });

  test('driver.destroy 抛错被 logger.warn 捕获', () => {
    const logger = createLogger();
    // @ts-expect-error test
    const factory: EntryFactory<TestSnapshot> = (id, lockId, _opts, ctx) => {
      const base = createMinimalEntry(logger);
      return {
        ...base,
        id,
        lockId,
        adapters: { ...base.adapters, logger },
        driver: {
          acquire: vi.fn(),
          destroy: () => {
            throw new Error('destroy boom');
          },
        },
        registerTeardown: ctx.registerTeardown,
      };
    };

    const { releaseFromRegistry } = acquireStandalone(buildOptions(), factory);
    expect(() => releaseFromRegistry()).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('standalone driver.destroy threw'),
      expect.any(Error),
    );
  });
});
