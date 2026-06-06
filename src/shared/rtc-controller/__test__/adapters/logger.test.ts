import { describe, expect, test, vi } from 'vitest';
import { createDefaultLogger, resolveLoggerAdapter } from '../../adapters/logger';

describe('logger adapter', () => {
  describe('createDefaultLogger', () => {
    test('返回三方法齐全的 logger', () => {
      const logger = createDefaultLogger();
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    test('调用不抛错', () => {
      const logger = createDefaultLogger();
      expect(() => logger.warn('test')).not.toThrow();
      expect(() => logger.error('test')).not.toThrow();
      expect(() => logger.debug('test')).not.toThrow();
    });
  });

  describe('resolveLoggerAdapter', () => {
    test('不传 userLogger 时返回默认 logger', () => {
      const logger = resolveLoggerAdapter();
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    test('传入 undefined 时返回默认 logger', () => {
      const logger = resolveLoggerAdapter(undefined);
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    test('用户 logger 全量覆盖时使用用户版本', () => {
      const userWarn = vi.fn();
      const userError = vi.fn();
      const userDebug = vi.fn();
      const logger = resolveLoggerAdapter({
        warn: userWarn,
        error: userError,
        debug: userDebug,
      });

      logger.warn('w');
      logger.error('e');
      logger.debug('d');

      expect(userWarn).toHaveBeenCalledOnce();
      expect(userError).toHaveBeenCalledOnce();
      expect(userDebug).toHaveBeenCalledOnce();
    });

    test('用户 logger 只实现 warn/error 时 debug 走默认', () => {
      const userWarn = vi.fn();
      const userError = vi.fn();
      const logger = resolveLoggerAdapter({ warn: userWarn, error: userError });

      logger.warn('w');
      logger.error('e');
      expect(() => logger.debug('d')).not.toThrow();

      expect(userWarn).toHaveBeenCalledOnce();
      expect(userError).toHaveBeenCalledOnce();
    });

    test('用户 logger 显式传 debug: undefined 时走默认', () => {
      const userWarn = vi.fn();
      const userError = vi.fn();
      const logger = resolveLoggerAdapter({
        warn: userWarn,
        error: userError,
        debug: undefined,
      });

      expect(() => logger.debug('d')).not.toThrow();
    });

    test('用户方法的 this 绑定正确', () => {
      const userLogger = {
        prefix: '[user]',
        warn(message: string) {
          return `${this.prefix} ${message}`;
        },
        error(message: string) {
          return `${this.prefix} ${message}`;
        },
      };
      const warnSpy = vi.spyOn(userLogger, 'warn');
      const logger = resolveLoggerAdapter(userLogger);

      logger.warn('test');
      expect(warnSpy).toHaveBeenCalledWith('test');
    });

    test('extras 参数正确透传', () => {
      const userWarn = vi.fn();
      const userError = vi.fn();
      const logger = resolveLoggerAdapter({ warn: userWarn, error: userError });

      logger.warn('msg', 'extra1', 42);
      expect(userWarn).toHaveBeenCalledWith('msg', 'extra1', 42);
    });
  });
});
