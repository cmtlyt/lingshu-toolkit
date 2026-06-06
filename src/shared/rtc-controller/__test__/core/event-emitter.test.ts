import { describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '../../adapters/logger';
import { createEventEmitter } from '../../core/event-emitter';
import type { EventMap } from '../../types';

interface TestEvents extends EventMap {
  chat: { text: string };
  ping: undefined;
  data: { value: number };
}

function createTestEmitter() {
  const logger = resolveLoggerAdapter();
  return { emitter: createEventEmitter<TestEvents>(logger), logger };
}

describe('event-emitter', () => {
  test('on 注册 handler 并通过 dispatch 触发', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    emitter.on('chat', handler);
    emitter.dispatch('chat', { text: 'hello' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ text: 'hello' });
  });

  test('on 返回取消监听函数', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    const unsub = emitter.on('chat', handler);
    unsub();
    emitter.dispatch('chat', { text: 'hello' });

    expect(handler).not.toHaveBeenCalled();
  });

  test('多个 handler 按注册顺序触发', () => {
    const { emitter } = createTestEmitter();
    const order: number[] = [];

    emitter.on('ping', () => order.push(1));
    emitter.on('ping', () => order.push(2));
    emitter.on('ping', () => order.push(3));
    emitter.dispatch('ping');

    expect(order).toEqual([1, 2, 3]);
  });

  test('once handler 只触发一次', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    emitter.once('chat', handler);
    emitter.dispatch('chat', { text: 'first' });
    emitter.dispatch('chat', { text: 'second' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ text: 'first' });
  });

  test('once 返回的取消函数可在触发前取消', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    const unsub = emitter.once('chat', handler);
    unsub();
    emitter.dispatch('chat', { text: 'hello' });

    expect(handler).not.toHaveBeenCalled();
  });

  test('off 移除指定 handler', () => {
    const { emitter } = createTestEmitter();
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    emitter.on('chat', handlerA);
    emitter.on('chat', handlerB);
    emitter.off('chat', handlerA);
    emitter.dispatch('chat', { text: 'hello' });

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  test('off 对不存在的 handler 静默忽略', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    expect(() => emitter.off('chat', handler)).not.toThrow();
  });

  test('off 对不存在的事件名静默忽略', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    expect(() => emitter.off('ping', handler)).not.toThrow();
  });

  test('dispatch 不存在的事件名静默忽略', () => {
    const { emitter } = createTestEmitter();

    expect(() => emitter.dispatch('ping')).not.toThrow();
  });

  test('dispatch void payload 事件无需传参', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    emitter.on('ping', handler);
    emitter.dispatch('ping');

    expect(handler).toHaveBeenCalledOnce();
  });

  test('handler 抛错不阻断后续 handler（异常隔离）', () => {
    const { emitter } = createTestEmitter();
    const handlerA = vi.fn(() => {
      throw new Error('boom');
    });
    const handlerB = vi.fn();

    emitter.on('chat', handlerA);
    emitter.on('chat', handlerB);

    expect(() => emitter.dispatch('chat', { text: 'hello' })).not.toThrow();
    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  test('handler 抛错时 logger.error 被调用', () => {
    const errorSpy = vi.fn();
    const logger = resolveLoggerAdapter({ warn: vi.fn(), error: errorSpy });
    const emitter = createEventEmitter<TestEvents>(logger);

    emitter.on('chat', () => {
      throw new Error('test error');
    });
    emitter.dispatch('chat', { text: 'hello' });

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain('chat');
  });

  test('遍历过程中 on 新增 handler 不影响当前分发（快照遍历）', () => {
    const { emitter } = createTestEmitter();
    const lateHandler = vi.fn();

    emitter.on('chat', () => {
      emitter.on('chat', lateHandler);
    });
    emitter.dispatch('chat', { text: 'hello' });

    expect(lateHandler).not.toHaveBeenCalled();

    emitter.dispatch('chat', { text: 'second' });
    expect(lateHandler).toHaveBeenCalledOnce();
  });

  test('遍历过程中 off 移除 handler 不影响当前分发（快照遍历）', () => {
    const { emitter } = createTestEmitter();
    const handlerB = vi.fn();
    let unsub: () => void;

    emitter.on('chat', () => {
      unsub();
    });
    unsub = emitter.on('chat', handlerB);
    emitter.dispatch('chat', { text: 'hello' });

    expect(handlerB).toHaveBeenCalledOnce();
  });

  test('同一 handler 注册多次，每次注册独立', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    emitter.on('chat', handler);
    emitter.on('chat', handler);
    emitter.dispatch('chat', { text: 'hello' });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('off 只移除第一个匹配的 handler', () => {
    const { emitter } = createTestEmitter();
    const handler = vi.fn();

    emitter.on('chat', handler);
    emitter.on('chat', handler);
    emitter.off('chat', handler);
    emitter.dispatch('chat', { text: 'hello' });

    expect(handler).toHaveBeenCalledOnce();
  });

  test('clear 清理所有事件监听器', () => {
    const { emitter } = createTestEmitter();
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    emitter.on('chat', handlerA);
    emitter.on('ping', handlerB);
    emitter.clear();
    emitter.dispatch('chat', { text: 'hello' });
    emitter.dispatch('ping');

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).not.toHaveBeenCalled();
  });

  test('once 与 on 混合场景', () => {
    const { emitter } = createTestEmitter();
    const onceHandler = vi.fn();
    const onHandler = vi.fn();

    emitter.once('data', onceHandler);
    emitter.on('data', onHandler);
    emitter.dispatch('data', { value: 1 });
    emitter.dispatch('data', { value: 2 });

    expect(onceHandler).toHaveBeenCalledOnce();
    expect(onceHandler).toHaveBeenCalledWith({ value: 1 });
    expect(onHandler).toHaveBeenCalledTimes(2);
  });

  test('多个 once handler 各自独立触发一次', () => {
    const { emitter } = createTestEmitter();
    const handlerA = vi.fn();
    const handlerB = vi.fn();

    emitter.once('ping', handlerA);
    emitter.once('ping', handlerB);
    emitter.dispatch('ping');

    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();

    emitter.dispatch('ping');
    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledOnce();
  });

  test('once handler 在 dispatch 遍历中被 off 移除后，indexOf 返回 -1 不 splice', () => {
    const { emitter } = createTestEmitter();
    let unsub: () => void;

    const handler = vi.fn(() => {
      // handler 执行时主动 off 自己，dispatch 内部再次 indexOf 会返回 -1
      unsub();
    });

    unsub = emitter.once('chat', handler);
    emitter.dispatch('chat', { text: 'hello' });

    expect(handler).toHaveBeenCalledOnce();
    // 第二次 dispatch 不再触发（once 语义 + 已被 off）
    emitter.dispatch('chat', { text: 'world' });
    expect(handler).toHaveBeenCalledOnce();
  });
});
