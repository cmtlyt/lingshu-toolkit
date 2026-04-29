/**
 * adapters/clone.ts 单元测试
 *
 * 覆盖点：
 * 1. structuredClone 可用路径：普通对象 / Map / Set / Date / 循环引用
 * 2. structuredClone 不可用时工厂构造阶段 warn 一次，后续走 JSON fallback
 * 3. structuredClone 对单个 value 失败（function / Symbol）时 warn 并走 JSON fallback
 * 4. JSON 也失败（循环引用场景下无 structuredClone）时 error 并返回原引用
 * 5. 显式注入 logger 时走注入实例；未注入时走默认 logger
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createSafeCloneFn } from '@/shared/lock-data/adapters/clone';
import type { LoggerAdapter } from '@/shared/lock-data/types';

function createLoggerSpy(): LoggerAdapter & {
  warnMock: ReturnType<typeof vi.fn>;
  errorMock: ReturnType<typeof vi.fn>;
  debugMock: ReturnType<typeof vi.fn>;
} {
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  const debugMock = vi.fn();
  return {
    warn: warnMock,
    error: errorMock,
    debug: debugMock,
    warnMock,
    errorMock,
    debugMock,
  };
}

describe('adapters/clone', () => {
  // 保存原始 structuredClone，便于按用例替换
  const originalStructuredClone = (globalThis as { structuredClone?: unknown }).structuredClone;

  beforeEach(() => {
    // 每个用例开始前恢复真实实现
    (globalThis as { structuredClone?: unknown }).structuredClone = originalStructuredClone;
  });

  afterEach(() => {
    (globalThis as { structuredClone?: unknown }).structuredClone = originalStructuredClone;
  });

  describe('structuredClone 可用路径', () => {
    test('深克隆普通对象：新引用 + 值相等', () => {
      const clone = createSafeCloneFn(createLoggerSpy());
      const source = { a: 1, nested: { b: [1, 2, 3] } };
      const cloned = clone(source);

      expect(cloned).not.toBe(source);
      expect(cloned.nested).not.toBe(source.nested);
      expect(cloned.nested.b).not.toBe(source.nested.b);
      expect(cloned).toEqual(source);
    });

    test('保留 Map / Set / Date 的特殊类型', () => {
      const clone = createSafeCloneFn(createLoggerSpy());
      const source = {
        map: new Map<string, number>([['a', 1]]),
        set: new Set<number>([1, 2, 3]),
        date: new Date('2024-01-01T00:00:00Z'),
      };
      const cloned = clone(source);

      expect(cloned.map).toBeInstanceOf(Map);
      expect(cloned.map.get('a')).toBe(1);
      expect(cloned.set).toBeInstanceOf(Set);
      expect(cloned.set.has(2)).toBe(true);
      expect(cloned.date).toBeInstanceOf(Date);
      expect(cloned.date.getTime()).toBe(source.date.getTime());
    });

    test('支持循环引用', () => {
      const clone = createSafeCloneFn(createLoggerSpy());
      const source: { self?: unknown; value: number } = { value: 1 };
      source.self = source;

      const cloned = clone(source);
      expect(cloned).not.toBe(source);
      expect(cloned.self).toBe(cloned);
    });
  });

  describe('structuredClone 对单个 value 失败', () => {
    test('遇到 function 时 warn + 走 JSON fallback', () => {
      const loggerSpy = createLoggerSpy();
      const clone = createSafeCloneFn(loggerSpy);

      // function 会让 structuredClone 抛 DataCloneError
      const source = {
        value: 42,
        handler: () => void 0,
      };

      const cloned = clone(source);

      expect(loggerSpy.warnMock).toHaveBeenCalledTimes(1);
      expect(loggerSpy.warnMock.mock.calls[0][0]).toMatch(/structuredClone failed/u);
      // JSON fallback：function 会被丢弃
      expect(cloned).toEqual({ value: 42 });
      expect((cloned as { handler?: unknown }).handler).toBeUndefined();
    });
  });

  describe('structuredClone 不可用时的降级', () => {
    test('工厂构造阶段 warn 一次，后续调用走 JSON fallback', () => {
      (globalThis as { structuredClone?: unknown }).structuredClone = undefined;

      const loggerSpy = createLoggerSpy();
      const clone = createSafeCloneFn(loggerSpy);

      expect(loggerSpy.warnMock).toHaveBeenCalledTimes(1);
      expect(loggerSpy.warnMock.mock.calls[0][0]).toMatch(/structuredClone is not available/u);

      const source = { a: 1, b: { c: [1, 2] } };
      const cloned = clone(source);

      expect(cloned).not.toBe(source);
      expect(cloned).toEqual(source);
      // 单次 clone 调用本身不再 warn
      expect(loggerSpy.warnMock).toHaveBeenCalledTimes(1);
    });

    test('JSON 也失败（循环引用）时 error 并返回原引用', () => {
      (globalThis as { structuredClone?: unknown }).structuredClone = undefined;

      const loggerSpy = createLoggerSpy();
      const clone = createSafeCloneFn(loggerSpy);

      const source: { self?: unknown } = {};
      source.self = source;

      const cloned = clone(source);

      expect(cloned).toBe(source);
      expect(loggerSpy.errorMock).toHaveBeenCalledTimes(1);
      expect(loggerSpy.errorMock.mock.calls[0][0]).toMatch(/Both structuredClone and JSON clone failed/u);
    });

    test('structuredClone 存在但探测抛错时视为不可用', () => {
      const thrownProbe = vi.fn(() => {
        throw new Error('probe-blocked');
      });
      (globalThis as { structuredClone?: unknown }).structuredClone = thrownProbe;

      const loggerSpy = createLoggerSpy();
      const clone = createSafeCloneFn(loggerSpy);

      // 构造时应该走了不可用分支
      expect(loggerSpy.warnMock.mock.calls[0][0]).toMatch(/structuredClone is not available/u);

      const source = { a: 1 };
      const cloned = clone(source);
      expect(cloned).not.toBe(source);
      expect(cloned).toEqual(source);
    });
  });

  describe('logger 注入', () => {
    test('未注入 logger 时使用默认 logger，不抛错', () => {
      // 本用例只验证 "不抛错"，具体日志内容由 logger 单元测试覆盖
      (globalThis as { structuredClone?: unknown }).structuredClone = undefined;

      expect(() => {
        const clone = createSafeCloneFn();
        clone({ a: 1 });
      }).not.toThrow();
    });
  });
});
