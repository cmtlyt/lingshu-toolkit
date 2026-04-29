/**
 * adapters/channel.ts 的单元测试（node 环境 + mock BroadcastChannel）
 *
 * 说明：
 *   真实浏览器下，同一 Tab 内的两个 BroadcastChannel 实例不会互相收到
 *   自己 postMessage 发出的消息（规范要求）；真跨 Tab 的广播能力属于
 *   Phase 4 集成测试范畴。本阶段只验证适配器作为"代理封装"的行为契约：
 *   ① 能力探测、② 方法委托、③ close 幂等与降级、④ 回调异常隔离、⑤ key 构建。
 *
 *   因此这里用 mock 的 BroadcastChannel 实现（共享 listener 总线），
 *   用来模拟跨实例通信的代理效果。
 *
 * 覆盖点：
 * 1. 能力探测：BroadcastChannel 构造器不存在 / 构造抛错时工厂返回 null
 * 2. postMessage：委托到底层 BroadcastChannel
 * 3. close 幂等；关闭后 post / subscribe 降级 noop + warn
 * 4. subscribe：回调抛错时走 logger.error，不影响其他订阅与后续消息
 * 5. subscribe：解绑后不再触发
 * 6. key 隔离：不同 channel 名（'session' vs 'custom'）互不干扰
 * 7. buildChannelName 的 key 构建约定
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildChannelName, createDefaultChannelAdapter } from '@/shared/lock-data/adapters/channel';
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
 * Mock BroadcastChannel 实现
 *
 * 关键差异：与真实浏览器行为相反，这里 **允许同名实例互相收到自己的消息**，
 * 以便在 node 单测里验证 "发→收" 代理链路。真实浏览器行为由 Phase 4
 * 集成测试覆盖。
 */
interface MockBus {
  /** 名称 -> 该名称下所有活跃实例的 message handlers */
  registry: Map<string, Set<(event: { data: unknown }) => void>>;
  /** 用于测试控制：让构造过程抛错 */
  shouldConstructorThrow: boolean;
  /** 用于测试控制：让 postMessage 抛错 */
  shouldPostThrow: boolean;
}

function createMockBus(): MockBus {
  return {
    registry: new Map(),
    shouldConstructorThrow: false,
    shouldPostThrow: false,
  };
}

interface MockChannelCtor {
  new (
    name: string,
  ): {
    readonly name: string;
    postMessage: (message: unknown) => void;
    close: () => void;
    addEventListener: (type: 'message', handler: (event: { data: unknown }) => void) => void;
    removeEventListener: (type: 'message', handler: (event: { data: unknown }) => void) => void;
  };
}

function createMockBroadcastChannelCtor(bus: MockBus): MockChannelCtor {
  return class MockBroadcastChannel {
    readonly name: string;
    private _handlers: Set<(event: { data: unknown }) => void> = new Set();
    private _closed = false;

    constructor(name: string) {
      if (bus.shouldConstructorThrow) {
        throw new Error('mock-broadcast-channel-ctor-failed');
      }
      this.name = name;
      const set = bus.registry.get(name) ?? new Set();
      set.add(this._dispatch);
      bus.registry.set(name, set);
    }

    private _dispatch = (event: { data: unknown }): void => {
      if (this._closed) {
        return;
      }
      for (const handler of this._handlers) {
        handler(event);
      }
    };

    postMessage(message: unknown): void {
      if (this._closed) {
        throw new Error('InvalidStateError');
      }
      if (bus.shouldPostThrow) {
        throw new Error('mock-post-failed');
      }
      const listeners = bus.registry.get(this.name);
      if (!listeners) {
        return;
      }
      for (const dispatch of listeners) {
        dispatch({ data: message });
      }
    }

    close(): void {
      this._closed = true;
      const listeners = bus.registry.get(this.name);
      listeners?.delete(this._dispatch);
      if (listeners && listeners.size === 0) {
        bus.registry.delete(this.name);
      }
    }

    addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void {
      if (type !== 'message') {
        return;
      }
      this._handlers.add(handler);
    }

    removeEventListener(type: 'message', handler: (event: { data: unknown }) => void): void {
      if (type !== 'message') {
        return;
      }
      this._handlers.delete(handler);
    }
  };
}

describe('adapters/channel (node, mocked BroadcastChannel)', () => {
  const g = globalThis as { BroadcastChannel?: unknown };
  const originalBroadcastChannel = g.BroadcastChannel;
  let bus: MockBus;

  beforeEach(() => {
    bus = createMockBus();
    g.BroadcastChannel = createMockBroadcastChannelCtor(bus);
  });

  afterEach(() => {
    g.BroadcastChannel = originalBroadcastChannel;
  });

  describe('能力探测', () => {
    test('BroadcastChannel 构造器不存在时工厂返回 null 并 warn', () => {
      g.BroadcastChannel = undefined;
      const logger = createLoggerSpy();

      const adapter = createDefaultChannelAdapter({ id: 'x', channel: 'session' }, { logger });

      expect(adapter).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/BroadcastChannel is not available/u);
    });

    test('构造器存在但实例化抛错时工厂返回 null', () => {
      bus.shouldConstructorThrow = true;
      const logger = createLoggerSpy();

      const adapter = createDefaultChannelAdapter({ id: 'x', channel: 'session' }, { logger });

      expect(adapter).toBeNull();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('postMessage', () => {
    test('委托到底层 BroadcastChannel：同名实例互相能收到', () => {
      const logger = createLoggerSpy();
      const a = createDefaultChannelAdapter({ id: 'shared-id', channel: 'session' }, { logger });
      const b = createDefaultChannelAdapter({ id: 'shared-id', channel: 'session' }, { logger });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();

      const received: unknown[] = [];
      b?.subscribe((msg) => {
        received.push(msg);
      });

      a?.postMessage({ type: 'probe', seq: 1 });
      a?.postMessage({ type: 'reply', seq: 2 });

      expect(received).toEqual([
        { type: 'probe', seq: 1 },
        { type: 'reply', seq: 2 },
      ]);
    });

    test('postMessage 抛错时降级 warn 不抛出', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultChannelAdapter({ id: 'err', channel: 'session' }, { logger });

      bus.shouldPostThrow = true;

      expect(() => adapter?.postMessage('x')).not.toThrow();
      expect(logger.warnMock).toHaveBeenCalledTimes(1);
      expect(logger.warnMock.mock.calls[0][0]).toMatch(/BroadcastChannel.postMessage failed/u);
    });
  });

  describe('channel 名隔离', () => {
    test('不同 channel 名（session vs custom）互不干扰', () => {
      const logger = createLoggerSpy();
      const sessionRecv = createDefaultChannelAdapter({ id: 'iso', channel: 'session' }, { logger });
      const customRecv = createDefaultChannelAdapter({ id: 'iso', channel: 'custom' }, { logger });

      const sessionReceived: unknown[] = [];
      const customReceived: unknown[] = [];
      sessionRecv?.subscribe((msg) => sessionReceived.push(msg));
      customRecv?.subscribe((msg) => customReceived.push(msg));

      const sessionSender = createDefaultChannelAdapter({ id: 'iso', channel: 'session' }, { logger });
      const customSender = createDefaultChannelAdapter({ id: 'iso', channel: 'custom' }, { logger });

      sessionSender?.postMessage('for-session');
      customSender?.postMessage('for-custom');

      expect(sessionReceived).toEqual(['for-session']);
      expect(customReceived).toEqual(['for-custom']);
    });
  });

  describe('subscribe', () => {
    test('解绑后不再触发回调', () => {
      const logger = createLoggerSpy();
      const sender = createDefaultChannelAdapter({ id: 'unsub', channel: 'session' }, { logger });
      const receiver = createDefaultChannelAdapter({ id: 'unsub', channel: 'session' }, { logger });

      const cb = vi.fn();
      const unsubscribe = receiver?.subscribe(cb) || (() => void 0);

      sender?.postMessage('first');
      expect(cb).toHaveBeenCalledTimes(1);

      unsubscribe();

      sender?.postMessage('second');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('回调抛错时走 logger.error，其他订阅与后续消息不受影响', () => {
      const logger = createLoggerSpy();
      const sender = createDefaultChannelAdapter({ id: 'boom', channel: 'session' }, { logger });
      const receiver = createDefaultChannelAdapter({ id: 'boom', channel: 'session' }, { logger });

      const throwing = vi.fn(() => {
        throw new Error('subscriber-boom');
      });
      const safe = vi.fn();
      receiver?.subscribe(throwing);
      receiver?.subscribe(safe);

      sender?.postMessage('msg-1');

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(safe).toHaveBeenCalledTimes(1);
      expect(logger.errorMock).toHaveBeenCalledTimes(1);
      expect(logger.errorMock.mock.calls[0][0]).toMatch(/Channel subscribe callback threw/u);

      sender?.postMessage('msg-2');

      expect(throwing).toHaveBeenCalledTimes(2);
      expect(safe).toHaveBeenCalledTimes(2);
    });
  });

  describe('close', () => {
    test('多次 close 幂等且不抛错', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultChannelAdapter({ id: 'close-idem', channel: 'session' }, { logger });

      expect(() => {
        adapter?.close();
        adapter?.close();
        adapter?.close();
      }).not.toThrow();
    });

    test('close 后 postMessage 降级 warn 且不抛错', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultChannelAdapter({ id: 'closed-post', channel: 'session' }, { logger });

      adapter?.close();
      expect(() => adapter?.postMessage('ignored')).not.toThrow();

      expect(
        logger.warnMock.mock.calls.some((call) => /postMessage on closed ChannelAdapter/u.test(String(call[0]))),
      ).toBe(true);
    });

    test('close 后 subscribe 返回 noop 解绑函数', () => {
      const logger = createLoggerSpy();
      const adapter = createDefaultChannelAdapter({ id: 'closed-sub', channel: 'session' }, { logger });

      adapter?.close();

      const unsubscribe = adapter?.subscribe(() => void 0);
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe?.()).not.toThrow();

      expect(
        logger.warnMock.mock.calls.some((call) => /subscribe on closed ChannelAdapter/u.test(String(call[0]))),
      ).toBe(true);
    });
  });

  describe('key 构建', () => {
    test('buildChannelName 遵循 prefix + id + channel 的 key 约定', () => {
      expect(buildChannelName('my-id', 'session')).toBe(`${LOCK_PREFIX}:my-id:session`);
      expect(buildChannelName('my-id', 'custom')).toBe(`${LOCK_PREFIX}:my-id:custom`);
    });
  });
});
