/**
 * adapters/session-store.ts 在 Node 环境下的单元测试
 *
 * 通过在 globalThis 上注入内存版 sessionStorage，覆盖：
 * 1. 能力探测：sessionStorage 不存在 / 存在但 setItem 抛错 时工厂返回 null
 * 2. read / write 的基础读写语义
 * 3. write 触发 QuotaExceededError 时 warn 降级，不抛出
 * 4. read 抛错时降级为返回 null 并 warn
 * 5. key 构建遵循 prefix + id + epoch 约定
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildSessionStoreKey, createDefaultSessionStoreAdapter } from '@/shared/lock-data/adapters/session-store';
import { LOCK_PREFIX } from '@/shared/lock-data/constants';
import type { LoggerAdapter } from '@/shared/lock-data/types';

function createLoggerSpy(): LoggerAdapter & {
  warnMock: ReturnType<typeof vi.fn>;
  errorMock: ReturnType<typeof vi.fn>;
} {
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  return {
    warn: warnMock,
    error: errorMock,
    warnMock,
    errorMock,
  };
}

interface MockStorage extends Storage {
  _data: Map<string, string>;
  failWriteOn: Set<string>;
  failReadOn: Set<string>;
}

function createMockStorage(): MockStorage {
  const data = new Map<string, string>();
  const failWriteOn = new Set<string>();
  const failReadOn = new Set<string>();
  const storage: MockStorage = {
    _data: data,
    failWriteOn,
    failReadOn,
    get length(): number {
      return data.size;
    },
    clear(): void {
      data.clear();
    },
    getItem(key: string): string | null {
      if (failReadOn.has(key)) {
        throw new Error('read-failed');
      }
      return data.get(key) ?? null;
    },
    key(index: number): string | null {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      data.delete(key);
    },
    setItem(key: string, value: string): void {
      if (failWriteOn.has(key)) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data.set(key, value);
    },
  };
  return storage;
}

describe('adapters/session-store (node, memory-mocked)', () => {
  const g = globalThis as { sessionStorage?: Storage };
  const originalSessionStorage = g.sessionStorage;
  let storage: MockStorage;

  beforeEach(() => {
    storage = createMockStorage();
    g.sessionStorage = storage;
  });

  afterEach(() => {
    g.sessionStorage = originalSessionStorage;
  });

  describe('能力探测', () => {
    test('sessionStorage 不存在时工厂返回 null 并 warn', () => {
      g.sessionStorage = undefined;
      const logger = createLoggerSpy();

      const adapter = createDefaultSessionStoreAdapter({ id: 'x' }, { logger });

      expect(adapter).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/sessionStorage is not available/u);
    });

    test('sessionStorage 存在但写探测抛错时工厂返回 null 并 warn', () => {
      storage.failWriteOn.add(`${LOCK_PREFIX}:__probe__`);
      const logger = createLoggerSpy();

      const adapter = createDefaultSessionStoreAdapter({ id: 'x' }, { logger });

      expect(adapter).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/fall back to "persistent"/u);
    });
  });

  describe('read / write', () => {
    test('write 后 read 能拿到同一个 raw 字符串', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultSessionStoreAdapter({ id: 'k' }, { logger });
      expect(adapter).not.toBeNull();

      adapter?.write('epoch-1');
      expect(adapter?.read()).toBe('epoch-1');
      expect(storage._data.get(buildSessionStoreKey('k'))).toBe('epoch-1');
    });

    test('write 覆盖式更新', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultSessionStoreAdapter({ id: 'k' }, { logger });

      adapter?.write('epoch-1');
      adapter?.write('epoch-2');

      expect(adapter?.read()).toBe('epoch-2');
    });

    test('未写入时 read 返回 null', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultSessionStoreAdapter({ id: 'empty' }, { logger });

      expect(adapter?.read()).toBeNull();
    });

    test('write 触发 QuotaExceededError 时 warn 降级，不抛出', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultSessionStoreAdapter({ id: 'k' }, { logger });

      storage.failWriteOn.add(buildSessionStoreKey('k'));

      expect(() => adapter?.write('x')).not.toThrow();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/Failed to write session store/u);
    });

    test('read 抛错时降级为返回 null 并 warn', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultSessionStoreAdapter({ id: 'k' }, { logger });

      storage.failReadOn.add(buildSessionStoreKey('k'));

      expect(adapter?.read()).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/Failed to read session store/u);
    });
  });

  describe('key 构建', () => {
    test('buildSessionStoreKey 遵循 prefix + id + epoch 的 key 约定', () => {
      expect(buildSessionStoreKey('my-id')).toBe(`${LOCK_PREFIX}:my-id:epoch`);
    });

    test('不同 id 之间的 key 互不干扰', () => {
      const logger = createLoggerSpy();
      const a = createDefaultSessionStoreAdapter({ id: 'id-a' }, { logger });
      const b = createDefaultSessionStoreAdapter({ id: 'id-b' }, { logger });

      a?.write('a-epoch');
      b?.write('b-epoch');

      expect(a?.read()).toBe('a-epoch');
      expect(b?.read()).toBe('b-epoch');
    });
  });
});
