/**
 * adapters/authority.ts 在 Node 环境下的单元测试
 *
 * 通过在 globalThis 上注入内存版 localStorage + 事件总线，覆盖：
 * 1. 能力探测：localStorage 不存在 / 存在但 setItem 抛错 时工厂返回 null
 * 2. read / write / remove 的基础读写语义
 * 3. write 触发 QuotaExceededError 时 warn 降级，不抛出
 * 4. subscribe 仅响应同 key + 同 storageArea 的 storage 事件
 * 5. subscribe 解绑后不再触发回调
 * 6. 订阅回调抛错时走 logger.error，不影响事件系统
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildAuthorityKey, createDefaultAuthorityAdapter } from '@/shared/lock-data/adapters/authority';
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

/**
 * 适配器仅读取 StorageEvent 的三个字段（key / newValue / storageArea），
 * Node 环境下 StorageEvent 全局类不存在，此处用结构相容的纯对象承载
 */
interface StorageEventLike {
  readonly key: string | null;
  readonly newValue: string | null;
  readonly storageArea: Storage | null;
}

/** 事件目标：负责 storage 事件的派发 */
interface StorageEventBus {
  listeners: Set<(event: StorageEventLike) => void>;
  addEventListener: (type: 'storage', handler: (event: StorageEventLike) => void) => void;
  removeEventListener: (type: 'storage', handler: (event: StorageEventLike) => void) => void;
  dispatch: (event: StorageEventLike) => void;
}

function createEventBus(): StorageEventBus {
  const listeners = new Set<(event: StorageEventLike) => void>();
  return {
    listeners,
    addEventListener(type, handler): void {
      if (type !== 'storage') {
        return;
      }
      listeners.add(handler);
    },
    removeEventListener(type, handler): void {
      if (type !== 'storage') {
        return;
      }
      listeners.delete(handler);
    },
    dispatch(event): void {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

/**
 * 构造一个可控的 mock Storage，支持：
 * - 正常 get/set/remove
 * - 通过 `failWriteOn` 字段让某个 key 的写入抛 QuotaExceededError
 */
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
        // 模拟 QuotaExceededError（浏览器下是 DOMException name === 'QuotaExceededError'）
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data.set(key, value);
    },
  };
  return storage;
}

describe('adapters/authority (node, memory-mocked)', () => {
  const g = globalThis as {
    localStorage?: Storage;
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  const originalLocalStorage = g.localStorage;
  const originalAdd = g.addEventListener;
  const originalRemove = g.removeEventListener;

  let bus: StorageEventBus;
  let storage: MockStorage;

  beforeEach(() => {
    bus = createEventBus();
    storage = createMockStorage();
    g.localStorage = storage;
    g.addEventListener = bus.addEventListener;
    g.removeEventListener = bus.removeEventListener;
  });

  afterEach(() => {
    g.localStorage = originalLocalStorage;
    g.addEventListener = originalAdd;
    g.removeEventListener = originalRemove;
  });

  describe('能力探测', () => {
    test('localStorage 不存在时工厂返回 null 并 warn', () => {
      g.localStorage = undefined;
      const logger = createLoggerSpy();

      const adapter = createDefaultAuthorityAdapter({ id: 'x' }, { logger });

      expect(adapter).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/localStorage is not available/u);
    });

    test('localStorage 存在但写探测抛错时工厂返回 null', () => {
      // 让探测 key 的写入始终失败
      storage.failWriteOn.add(`${LOCK_PREFIX}:__probe__`);
      const logger = createLoggerSpy();

      const adapter = createDefaultAuthorityAdapter({ id: 'x' }, { logger });

      expect(adapter).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('read / write / remove', () => {
    test('write 后 read 能拿到同一个 raw 字符串', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });
      expect(adapter).not.toBeNull();

      adapter?.write('{"rev":1}');
      expect(adapter?.read()).toBe('{"rev":1}');
      expect(storage._data.get(buildAuthorityKey('k'))).toBe('{"rev":1}');
    });

    test('remove 后 read 返回 null', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });

      adapter?.write('payload');
      adapter?.remove();

      expect(adapter?.read()).toBeNull();
    });

    test('write 触发 QuotaExceededError 时 warn 降级，不抛出', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });

      storage.failWriteOn.add(buildAuthorityKey('k'));

      expect(() => adapter?.write('x')).not.toThrow();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/Failed to write authority snapshot/u);
    });

    test('read 抛错时降级为返回 null 并 warn', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });

      storage.failReadOn.add(buildAuthorityKey('k'));

      expect(adapter?.read()).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe', () => {
    test('仅响应同 key + 同 storageArea 的事件', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });
      const cb = vi.fn();
      adapter?.subscribe(cb);

      const targetKey = buildAuthorityKey('k');

      // 不同 storageArea（别的 storage 实例）：忽略
      bus.dispatch({
        key: targetKey,
        newValue: 'new',
        storageArea: createMockStorage(),
      });

      // 不同 key：忽略
      bus.dispatch({
        key: 'other-key',
        newValue: 'new',
        storageArea: storage,
      });

      // 同 storageArea + 同 key：触发
      bus.dispatch({
        key: targetKey,
        newValue: 'hit',
        storageArea: storage,
      });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith('hit');
    });

    test('解绑后不再触发回调', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });
      const cb = vi.fn();

      const unsubscribe = adapter?.subscribe(cb) || (() => void 0);
      unsubscribe();

      bus.dispatch({
        key: buildAuthorityKey('k'),
        newValue: 'ignored',
        storageArea: storage,
      });

      expect(cb).not.toHaveBeenCalled();
    });

    test('回调抛错时走 logger.error，后续事件仍可派发', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });

      const throwing = vi.fn(() => {
        throw new Error('subscriber-boom');
      });
      adapter?.subscribe(throwing);

      bus.dispatch({
        key: buildAuthorityKey('k'),
        newValue: 'v1',
        storageArea: storage,
      });

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(logger.errorMock).toHaveBeenCalledTimes(1);
      expect(logger.errorMock.mock.calls[0][0]).toMatch(/Authority subscribe callback threw/u);

      // 再派一次，确认事件系统未被异常污染
      bus.dispatch({
        key: buildAuthorityKey('k'),
        newValue: 'v2',
        storageArea: storage,
      });
      expect(throwing).toHaveBeenCalledTimes(2);
    });

    test('globalThis.addEventListener 不可用时 subscribe 返回 noop 解绑', () => {
      g.addEventListener = undefined;

      const logger = createLoggerSpy();
      const adapter = createDefaultAuthorityAdapter({ id: 'k' }, { logger });
      const cb = vi.fn();

      const unsubscribe = adapter?.subscribe(cb);

      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe?.()).not.toThrow();
      expect(
        logger.warnMock.mock.calls.some((call) => /addEventListener is not available/u.test(String(call[0]))),
      ).toBe(true);
    });
  });

  describe('key 构建', () => {
    test('buildAuthorityKey 遵循 prefix + id + latest 的 key 约定', () => {
      expect(buildAuthorityKey('my-id')).toBe(`${LOCK_PREFIX}:my-id:latest`);
    });
  });
});
