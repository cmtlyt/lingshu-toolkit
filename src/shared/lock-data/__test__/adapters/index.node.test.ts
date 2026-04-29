/**
 * adapters/index.ts (pickDefaultAdapters) 的单元测试
 *
 * 覆盖点：
 * 1. 空对象 → 全部字段走默认实现
 * 2. logger / clone 的用户覆盖直接透传实例
 * 3. 用户未提供 logger 时，默认 logger 会被注入给所有 adapter 工厂
 *    —— 通过"用户提供 logger 时，默认 adapter 内部降级日志走用户 logger"反向验证
 * 4. getAuthority / getChannel / getSessionStore 用户工厂返回非 null → 使用用户实例
 * 5. getAuthority / getChannel / getSessionStore 用户工厂返回 null → fallback 到默认工厂
 * 6. getLock 透传（不被聚合层解释）
 * 7. 工厂每次调用都返回新实例（不缓存）
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pickDefaultAdapters } from '@/shared/lock-data/adapters';
import { LOCK_PREFIX } from '@/shared/lock-data/constants';
import type {
  AuthorityAdapter,
  ChannelAdapter,
  LockDriverHandle,
  LoggerAdapter,
  SessionStoreAdapter,
} from '@/shared/lock-data/types';

function createLoggerSpy(): LoggerAdapter & {
  warnMock: ReturnType<typeof vi.fn>;
  errorMock: ReturnType<typeof vi.fn>;
} {
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  return { warn: warnMock, error: errorMock, warnMock, errorMock };
}

/**
 * 最小 mock：支持默认 authority / channel / session-store 能力探测通过
 * 保证"不传用户适配器时，默认工厂能正常返回实例"
 */
interface MockStorage extends Storage {
  _data: Map<string, string>;
}

function createMockStorage(): MockStorage {
  const data = new Map<string, string>();
  return {
    _data: data,
    get length(): number {
      return data.size;
    },
    clear(): void {
      data.clear();
    },
    getItem(key): string | null {
      return data.get(key) ?? null;
    },
    key(index): string | null {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key): void {
      data.delete(key);
    },
    setItem(key, value): void {
      data.set(key, value);
    },
  };
}

/** 最小 mock BroadcastChannel 让能力探测通过 */
class MockBroadcastChannel {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  postMessage(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

describe('adapters/index (pickDefaultAdapters)', () => {
  const g = globalThis as {
    localStorage?: Storage;
    sessionStorage?: Storage;
    BroadcastChannel?: unknown;
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  const originals = {
    localStorage: g.localStorage,
    sessionStorage: g.sessionStorage,
    BroadcastChannel: g.BroadcastChannel,
    addEventListener: g.addEventListener,
    removeEventListener: g.removeEventListener,
  };

  beforeEach(() => {
    g.localStorage = createMockStorage();
    g.sessionStorage = createMockStorage();
    g.BroadcastChannel = MockBroadcastChannel;
    g.addEventListener = vi.fn();
    g.removeEventListener = vi.fn();
  });

  afterEach(() => {
    g.localStorage = originals.localStorage;
    g.sessionStorage = originals.sessionStorage;
    g.BroadcastChannel = originals.BroadcastChannel;
    g.addEventListener = originals.addEventListener;
    g.removeEventListener = originals.removeEventListener;
  });

  describe('空适配器：全部走默认实现', () => {
    test('传 undefined 时返回完整 ResolvedAdapters', () => {
      const resolved = pickDefaultAdapters();

      expect(typeof resolved.logger.warn).toBe('function');
      expect(typeof resolved.logger.error).toBe('function');
      expect(typeof resolved.clone).toBe('function');
      expect(typeof resolved.getAuthority).toBe('function');
      expect(typeof resolved.getChannel).toBe('function');
      expect(typeof resolved.getSessionStore).toBe('function');
      expect(resolved.getLock).toBeUndefined();
    });

    test('传空对象时 getAuthority 默认工厂可返回能用的实例', () => {
      const resolved = pickDefaultAdapters({});

      const authority = resolved.getAuthority({ id: 'test' });
      expect(authority).not.toBeNull();
      authority?.write('raw-1');
      expect(authority?.read()).toBe('raw-1');
      expect((g.localStorage as MockStorage)._data.get(`${LOCK_PREFIX}:test:latest`)).toBe('raw-1');
    });

    test('clone 默认实现可工作', () => {
      const resolved = pickDefaultAdapters({});
      const source = { nested: { value: 42 } };
      const cloned = resolved.clone(source);

      expect(cloned).not.toBe(source);
      expect(cloned).toEqual(source);
    });
  });

  describe('logger / clone 实例透传', () => {
    test('用户提供 logger 时产物代理到用户方法（新契约：logger 走 resolveLoggerAdapter 混合）', () => {
      const userLogger = createLoggerSpy();
      const resolved = pickDefaultAdapters({ logger: userLogger });

      // 新契约下 resolved.logger 是混合产物（新对象），不再引用相等
      // 但用户实现的方法会被代理调用
      resolved.logger.warn('w');
      resolved.logger.error('e');

      expect(userLogger.warnMock).toHaveBeenCalledWith('w');
      expect(userLogger.errorMock).toHaveBeenCalledWith('e');

      // 用户未实现 debug → 应由默认 logger 补全，且产物的 debug 可直接调用不崩
      expect(typeof resolved.logger.debug).toBe('function');
      expect(() => resolved.logger.debug('d')).not.toThrow();
    });

    test('用户 logger 被传递给所有 adapter 工厂：authority 降级时走用户 logger', () => {
      const userLogger = createLoggerSpy();

      // 构造一个"对探测 key 正常，对业务 key 写入抛 Quota"的 storage
      // 保证：能力探测通过（adapter 不为 null）→ 业务 write 才能走到降级分支
      const baseStorage = createMockStorage();
      const businessKey = `${LOCK_PREFIX}:k:latest`;
      const storageWithBusinessFail: Storage = {
        get length(): number {
          return baseStorage.length;
        },
        clear(): void {
          baseStorage.clear();
        },
        getItem(key): string | null {
          return baseStorage.getItem(key);
        },
        key(index): string | null {
          return baseStorage.key(index);
        },
        removeItem(key): void {
          baseStorage.removeItem(key);
        },
        setItem(key, value): void {
          if (key === businessKey) {
            const err = new Error('Quota');
            err.name = 'QuotaExceededError';
            throw err;
          }
          baseStorage.setItem(key, value);
        },
      };
      g.localStorage = storageWithBusinessFail;

      const resolved = pickDefaultAdapters({ logger: userLogger });
      const authority = resolved.getAuthority({ id: 'k' });
      expect(authority).not.toBeNull();

      authority?.write('x');

      // 用户 logger 应当收到 authority 的业务降级 warn
      expect(
        userLogger.warnMock.mock.calls.some((call) => /Failed to write authority snapshot/u.test(String(call[0]))),
      ).toBe(true);
    });

    test('用户提供 clone 时直接透传', () => {
      const userClone = vi.fn(<V>(value: V): V => value);
      // @ts-expect-error
      const resolved = pickDefaultAdapters({ clone: userClone });

      expect(resolved.clone).toBe(userClone);

      const source = { a: 1 };
      const cloned = resolved.clone(source);
      expect(cloned).toBe(source);
      expect(userClone).toHaveBeenCalledWith(source);
    });
  });

  describe('getAuthority 合并', () => {
    test('用户工厂返回非 null 时使用用户实例', () => {
      const userAuthority: AuthorityAdapter = {
        read: vi.fn(() => 'user-value'),
        write: vi.fn(),
        remove: vi.fn(),
        subscribe: vi.fn(() => () => void 0),
      };
      const userFactory = vi.fn(() => userAuthority);
      const resolved = pickDefaultAdapters({ getAuthority: userFactory });

      const result = resolved.getAuthority({ id: 'k' });

      expect(userFactory).toHaveBeenCalledWith({ id: 'k' });
      expect(result).toBe(userAuthority);
    });

    test('用户工厂返回 null 时 fallback 到默认工厂', () => {
      const userFactory = vi.fn(() => null);
      const resolved = pickDefaultAdapters({ getAuthority: userFactory });

      const result = resolved.getAuthority({ id: 'k' });

      expect(userFactory).toHaveBeenCalledWith({ id: 'k' });
      // 默认工厂在 mock localStorage 下应当返回非 null
      expect(result).not.toBeNull();
    });

    test('未提供用户工厂时直接使用默认工厂', () => {
      const resolved = pickDefaultAdapters({});
      const result = resolved.getAuthority({ id: 'k' });
      expect(result).not.toBeNull();
    });
  });

  describe('getChannel 合并', () => {
    test('用户工厂返回非 null 时使用用户实例', () => {
      const userChannel: ChannelAdapter = {
        postMessage: vi.fn(),
        subscribe: vi.fn(() => () => void 0),
        close: vi.fn(),
      };
      const userFactory = vi.fn(() => userChannel);
      const resolved = pickDefaultAdapters({ getChannel: userFactory });

      const result = resolved.getChannel({ id: 'k', channel: 'session' });

      expect(userFactory).toHaveBeenCalledWith({ id: 'k', channel: 'session' });
      expect(result).toBe(userChannel);
    });

    test('用户工厂返回 null 时 fallback 到默认工厂', () => {
      const userFactory = vi.fn(() => null);
      const resolved = pickDefaultAdapters({ getChannel: userFactory });

      const result = resolved.getChannel({ id: 'k', channel: 'session' });

      expect(userFactory).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });
  });

  describe('getSessionStore 合并', () => {
    test('用户工厂返回非 null 时使用用户实例', () => {
      const userStore: SessionStoreAdapter = {
        read: vi.fn(() => 'user-epoch'),
        write: vi.fn(),
      };
      const userFactory = vi.fn(() => userStore);
      const resolved = pickDefaultAdapters({ getSessionStore: userFactory });

      const result = resolved.getSessionStore({ id: 'k' });

      expect(userFactory).toHaveBeenCalledWith({ id: 'k' });
      expect(result).toBe(userStore);
    });

    test('用户工厂返回 null 时 fallback 到默认工厂', () => {
      const userFactory = vi.fn(() => null);
      const resolved = pickDefaultAdapters({ getSessionStore: userFactory });

      const result = resolved.getSessionStore({ id: 'k' });

      expect(userFactory).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });
  });

  describe('getLock 透传', () => {
    test('用户传入 getLock 原样透传', () => {
      const handle: LockDriverHandle = {
        release: vi.fn(),
        onRevokedByDriver: vi.fn(),
      };
      const userGetLock = vi.fn(() => handle);

      const resolved = pickDefaultAdapters({ getLock: userGetLock });

      expect(resolved.getLock).toBe(userGetLock);
    });

    test('未提供 getLock 时为 undefined', () => {
      const resolved = pickDefaultAdapters({});
      expect(resolved.getLock).toBeUndefined();
    });
  });

  describe('工厂独立性', () => {
    test('getAuthority 连续调用返回独立实例', () => {
      const resolved = pickDefaultAdapters({});
      const a = resolved.getAuthority({ id: 'id-1' });
      const b = resolved.getAuthority({ id: 'id-2' });

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    test('getChannel 连续调用返回独立实例', () => {
      const resolved = pickDefaultAdapters({});
      const a = resolved.getChannel({ id: 'id-1', channel: 'session' });
      const b = resolved.getChannel({ id: 'id-1', channel: 'custom' });

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });
  });
});
