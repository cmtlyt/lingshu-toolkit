/**
 * adapters/logger.ts 单元测试
 *
 * 覆盖点：
 * 1. warn / error / debug 三个方法齐全（契约必须项）
 * 2. 委托到全局 logger 时使用固定 fnName（ERROR_FN_NAME = 'lockData'）
 * 3. globalThis.$$lingshu$$.disableLogger = true 时方法仍可调用且不抛错
 *    （底层 shared/logger 负责返回 noop，适配器无需特殊处理）
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDefaultLogger, resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import type { LoggerAdapter } from '@/shared/lock-data/types';

describe('adapters/logger', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    globalThis.$$lingshu$$ = { disableLogger: false };
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => void 0);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => void 0);
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => void 0);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
    globalThis.$$lingshu$$ = {};
  });

  test('返回的适配器包含 warn / error / debug 三个方法', () => {
    const adapter = createDefaultLogger();
    expect(typeof adapter.warn).toBe('function');
    expect(typeof adapter.error).toBe('function');
    expect(typeof adapter.debug).toBe('function');
  });

  test('warn 委托到 console.warn，并带 lockData 前缀', () => {
    const adapter = createDefaultLogger();
    adapter.warn('hello', 1, { foo: 'bar' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0];
    expect(args[0]).toBe('[@cmtlyt/lingshu-toolkit#lockData]:');
    expect(args[1]).toBe('hello');
    expect(args[2]).toBe(1);
    expect(args[3]).toEqual({ foo: 'bar' });
  });

  test('error 委托到 console.error，并带 lockData 前缀', () => {
    const adapter = createDefaultLogger();
    const err = new Error('boom');
    adapter.error('failure', err);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0];
    expect(args[0]).toBe('[@cmtlyt/lingshu-toolkit#lockData]:');
    expect(args[1]).toBe('failure');
    expect(args[2]).toBe(err);
  });

  test('debug 委托到 console.debug，并带 lockData 前缀', () => {
    const adapter = createDefaultLogger();
    adapter.debug('trace', 'detail');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const args = debugSpy.mock.calls[0];
    expect(args[0]).toBe('[@cmtlyt/lingshu-toolkit#lockData]:');
    expect(args[1]).toBe('trace');
    expect(args[2]).toBe('detail');
  });

  test('globalThis.$$lingshu$$.disableLogger = true 时调用不抛错且不写入 console', () => {
    globalThis.$$lingshu$$ = { disableLogger: true };
    const adapter = createDefaultLogger();

    expect(() => adapter.warn('silent')).not.toThrow();
    expect(() => adapter.error('silent')).not.toThrow();
    expect(() => adapter.debug?.('silent')).not.toThrow();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  test('每次 createDefaultLogger 返回独立实例', () => {
    const a = createDefaultLogger();
    const b = createDefaultLogger();
    expect(a).not.toBe(b);
    expect(a.warn).not.toBe(b.warn);
  });

  describe('resolveLoggerAdapter（混合兜底）', () => {
    test('未传 userLogger 时产物三方法齐全，均走默认 logger', () => {
      const resolved = resolveLoggerAdapter();

      expect(typeof resolved.warn).toBe('function');
      expect(typeof resolved.error).toBe('function');
      expect(typeof resolved.debug).toBe('function');

      resolved.warn('w');
      resolved.error('e');
      resolved.debug('d');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledTimes(1);
    });

    test('userLogger 全实现时三方法全部走用户实例', () => {
      const userWarn = vi.fn();
      const userError = vi.fn();
      const userDebug = vi.fn();
      const userLogger: LoggerAdapter = { warn: userWarn, error: userError, debug: userDebug };

      const resolved = resolveLoggerAdapter(userLogger);
      resolved.warn('w');
      resolved.error('e');
      resolved.debug('d');

      expect(userWarn).toHaveBeenCalledTimes(1);
      expect(userError).toHaveBeenCalledTimes(1);
      expect(userDebug).toHaveBeenCalledTimes(1);

      // 默认 logger 未被触达
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    });

    test('userLogger 只实现 warn / error 时 debug 自动由默认 logger 补全', () => {
      const userWarn = vi.fn();
      const userError = vi.fn();
      const userLogger: LoggerAdapter = { warn: userWarn, error: userError };

      const resolved = resolveLoggerAdapter(userLogger);

      resolved.warn('w');
      resolved.error('e');
      // 即使用户未实现 debug，下游也可直接调用 debug 无需 guard
      resolved.debug('d', { detail: 1 });

      expect(userWarn).toHaveBeenCalledTimes(1);
      expect(userError).toHaveBeenCalledTimes(1);
      // debug 落到默认 logger —— console.debug 被触达
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const debugArgs = debugSpy.mock.calls[0];
      expect(debugArgs[0]).toBe('[@cmtlyt/lingshu-toolkit#lockData]:');
      expect(debugArgs[1]).toBe('d');
      expect(debugArgs[2]).toEqual({ detail: 1 });
    });

    test('userLogger 显式传 debug: undefined 时不会覆盖默认 debug', () => {
      const userWarn = vi.fn();
      const userError = vi.fn();
      const userLogger = { warn: userWarn, error: userError, debug: undefined } as unknown as LoggerAdapter;

      const resolved = resolveLoggerAdapter(userLogger);

      // 下游直接调用应当命中默认 logger 而不是崩
      expect(() => resolved.debug('d')).not.toThrow();
      expect(debugSpy).toHaveBeenCalledTimes(1);
    });

    test('userLogger 字段不是 function 时视为未实现（防御性兜底）', () => {
      const userLogger = { warn: 'not-a-function', error: 123, debug: null } as unknown as LoggerAdapter;

      const resolved = resolveLoggerAdapter(userLogger);

      expect(() => resolved.warn('w')).not.toThrow();
      expect(() => resolved.error('e')).not.toThrow();
      expect(() => resolved.debug('d')).not.toThrow();

      // 全部走默认 logger
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledTimes(1);
    });

    test('userLogger 只实现 debug 时 warn / error 走默认 logger', () => {
      const userDebug = vi.fn();
      const userLogger = { debug: userDebug } as unknown as LoggerAdapter;

      const resolved = resolveLoggerAdapter(userLogger);

      resolved.warn('w');
      resolved.error('e');
      resolved.debug('d');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(userDebug).toHaveBeenCalledTimes(1);
    });

    test('user 方法的 this 绑定指向用户对象（而非 resolved 产物）', () => {
      const receivedThis: unknown[] = [];
      const userLogger = {
        name: 'custom',
        warn(this: { name: string }, message: string): void {
          receivedThis.push(this.name);
          expect(message).toBe('w');
        },
        error(): void {},
      } as unknown as LoggerAdapter;

      const resolved = resolveLoggerAdapter(userLogger);
      resolved.warn('w');

      expect(receivedThis).toEqual(['custom']);
    });
  });
});
