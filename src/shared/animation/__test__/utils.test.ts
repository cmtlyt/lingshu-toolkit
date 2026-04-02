import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { identity } from '@/shared/utils';
import type { FormatterValue } from '../types';
import { createNextTick, createRunningControllerSignal, getNextValueHandler, matchValid, tryRun } from '../utils';

describe('utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('getNextValueHandler', () => {
    test('应该处理数字类型', () => {
      const handler = getNextValueHandler(0, 100, identity as FormatterValue);
      expect(handler(0)).toBe(0);
      expect(handler(0.5)).toBe(50);
      expect(handler(1)).toBe(100);
    });

    test('应该处理数组类型', () => {
      const handler = getNextValueHandler([0, 0], [100, 200], identity as FormatterValue);
      expect(handler(0)).toEqual([0, 0]);
      expect(handler(0.5)).toEqual([50, 100]);
      expect(handler(1)).toEqual([100, 200]);
    });

    test('应该处理嵌套数组', () => {
      const handler = getNextValueHandler(
        [
          [0, 0],
          [10, 10],
        ],
        [
          [100, 200],
          [110, 210],
        ],
        identity as FormatterValue,
      );
      expect(handler(0)).toEqual([
        [0, 0],
        [10, 10],
      ]);
      expect(handler(0.5)).toEqual([
        [50, 100],
        [60, 110],
      ]);
      expect(handler(1)).toEqual([
        [100, 200],
        [110, 210],
      ]);
    });

    test('应该处理对象类型', () => {
      const handler = getNextValueHandler({ x: 0, y: 0 }, { x: 100, y: 200 }, identity as FormatterValue);
      expect(handler(0)).toEqual({ x: 0, y: 0 });
      expect(handler(0.5)).toEqual({ x: 50, y: 100 });
      expect(handler(1)).toEqual({ x: 100, y: 200 });
    });

    test('应该正确处理嵌套对象', () => {
      const handler = getNextValueHandler(
        { pos: { x: 0, y: 0 } },
        { pos: { x: 100, y: 200 } },
        identity as FormatterValue,
      );
      expect(handler(0)).toEqual({ pos: { x: 0, y: 0 } });
      expect(handler(0.5)).toEqual({ pos: { x: 50, y: 100 } });
      expect(handler(1)).toEqual({ pos: { x: 100, y: 200 } });
    });

    test('应该处理对象中包含数组的属性', () => {
      const handler = getNextValueHandler({ values: [0, 10] }, { values: [100, 110] }, identity as FormatterValue);
      expect(handler(0)).toEqual({ values: [0, 10] });
      expect(handler(0.5)).toEqual({ values: [50, 60] });
      expect(handler(1)).toEqual({ values: [100, 110] });
    });

    test('应该使用 formatter 格式化值', () => {
      const formatter = (value: number) => Math.round(value);
      const handler = getNextValueHandler(0, 100, formatter);
      expect(handler(0.33)).toBe(33);
      expect(handler(0.66)).toBe(66);
    });

    test('应该正确处理混合类型的数组，只更新数字', () => {
      const handler = getNextValueHandler(['solid', 1, '#000'], ['solid', 5, '#000'], identity as FormatterValue);
      expect(handler(0)).toEqual(['solid', 1, '#000']);
      expect(handler(0.5)).toEqual(['solid', 3, '#000']);
      expect(handler(1)).toEqual(['solid', 5, '#000']);
    });

    test('应该处理数组套对象的复杂情况', () => {
      const handler = getNextValueHandler(
        [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        [
          { x: 100, y: 200 },
          { x: 110, y: 210 },
        ],
        identity as FormatterValue,
      );
      expect(handler(0)).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]);
      expect(handler(0.5)).toEqual([
        { x: 50, y: 100 },
        { x: 60, y: 110 },
      ]);
      expect(handler(1)).toEqual([
        { x: 100, y: 200 },
        { x: 110, y: 210 },
      ]);
    });
  });

  describe('matchValid', () => {
    test('应该接受相同类型的数字', () => {
      expect(matchValid(0, 100, identity)).toEqual([0, 100]);
    });

    test('应该使用 parser 解析非数字类型', () => {
      const parser = (value: any) => Number.parseInt(value, 10);
      expect(matchValid('0', '100', parser)).toEqual([0, 100]);
    });

    test('应该验证数组类型', () => {
      expect(matchValid([0, 0], [100, 200], identity)).toEqual([
        [0, 0],
        [100, 200],
      ]);
    });

    test('应该验证嵌套数组', () => {
      expect(
        matchValid(
          [
            [0, 0],
            [10, 10],
          ],
          [
            [100, 200],
            [110, 210],
          ],
          identity,
        ),
      ).toEqual([
        [
          [0, 0],
          [10, 10],
        ],
        [
          [100, 200],
          [110, 210],
        ],
      ]);
    });

    test('应该验证对象类型', () => {
      expect(matchValid({ x: 0, y: 0 }, { x: 100, y: 200 }, identity)).toEqual([
        { x: 0, y: 0 },
        { x: 100, y: 200 },
      ]);
    });

    test('应该验证嵌套对象', () => {
      expect(matchValid({ pos: { x: 0 } }, { pos: { x: 100 } }, identity)).toEqual([
        { pos: { x: 0 } },
        { pos: { x: 100 } },
      ]);
    });

    test('应该在类型不匹配时抛出错误', () => {
      expect(() => matchValid(0, '100', identity)).toThrow('from and to must be the same type');
    });

    test('应该在数组长度不匹配时抛出错误', () => {
      expect(() => matchValid([0, 0], [100], identity)).toThrow('from and to must be the same length');
    });

    test('应该在对象缺少 key 时抛出错误', () => {
      expect(() => matchValid({ x: 0 }, { x: 100, y: 200 }, identity)).toThrow('from does not have this key: y');
    });
  });

  describe('tryRun', () => {
    test('应该执行同步回调', async () => {
      const callback = vi.fn(() => 'result');
      await tryRun(callback, {
        resolve: vi.fn(),
        reject: vi.fn(),
        promise: Promise.resolve(),
      });
      expect(callback).toHaveBeenCalled();
    });

    test('应该执行异步回调', async () => {
      const callback = vi.fn(() => Promise.resolve('result'));
      await tryRun(callback, {
        resolve: vi.fn(),
        reject: vi.fn(),
        promise: Promise.resolve(),
      });
      expect(callback).toHaveBeenCalled();
    });

    test('应该捕获错误并使用自定义处理器', async () => {
      const error = new Error('test error');
      const callback = vi.fn(() => {
        throw error;
      });
      const customErrorHandler = vi.fn();
      await tryRun(
        callback,
        {
          resolve: vi.fn(),
          reject: vi.fn(),
          promise: Promise.resolve(),
        },
        customErrorHandler,
      );
      expect(callback).toHaveBeenCalled();
      expect(customErrorHandler).toHaveBeenCalledWith(error);
    });

    test('应该捕获错误并使用默认处理器', async () => {
      const error = new Error('test error');
      const callback = vi.fn(() => {
        throw error;
      });
      const reject = vi.fn();
      await tryRun(callback, {
        resolve: vi.fn(),
        reject,
        promise: Promise.resolve(),
      });
      expect(callback).toHaveBeenCalled();
      expect(reject).toHaveBeenCalledWith(error);
    });
  });

  describe('createNextTick', () => {
    test('应该在 stopSignal 为 true 时返回 true', () => {
      const resolvers = {
        resolve: vi.fn(),
        reject: vi.fn(),
        promise: Promise.resolve(),
      };
      const rcSignal = {
        stopSignal: true,
        stop: vi.fn(),
        start: vi.fn(),
        clear: vi.fn(),
      };
      const nextTick = createNextTick(resolvers, rcSignal);
      const callback = vi.fn();
      const result = nextTick(callback);
      expect(result).toBe(true);
      expect(callback).not.toHaveBeenCalled();
    });

    test('应该在 stopSignal 为 false 时调用回调', async () => {
      const resolvers = {
        resolve: vi.fn(),
        reject: vi.fn(),
        promise: Promise.resolve(),
      };
      const rcSignal = {
        stopSignal: false,
        stop: vi.fn(),
        start: vi.fn(),
        clear: vi.fn(),
      };
      const nextTick = createNextTick(resolvers, rcSignal);
      const callback = vi.fn();
      nextTick(callback);
      vi.advanceTimersByTime(50);
      await vi.runAllTimersAsync();
      expect(callback).toHaveBeenCalled();
    });

    test('应该在回调出错时停止并 reject promise', async () => {
      const error = new Error('callback error');
      const reject = vi.fn();
      const resolvers = {
        resolve: vi.fn(),
        reject,
        promise: Promise.resolve(),
      };
      const rcSignal = {
        stopSignal: false,
        stop: vi.fn(),
        start: vi.fn(),
        clear: vi.fn(),
      };
      const nextTick = createNextTick(resolvers, rcSignal);
      const callback = vi.fn(() => {
        throw error;
      });
      nextTick(callback);
      vi.advanceTimersByTime(50);
      await vi.runAllTimersAsync();
      expect(reject).toHaveBeenCalledWith(error);
      expect(rcSignal.stop).toHaveBeenCalled();
    });
  });

  describe('createRunningControllerSignal', () => {
    test('应该创建控制器信号', () => {
      const startFn = vi.fn();
      const options = {
        autoStart: true,
        easing: identity,
        onStart: vi.fn(),
        onStop: vi.fn(),
        onClear: vi.fn(),
        onUpdate: vi.fn(),
        onComplete: vi.fn(),
        formatter: identity,
        formatterValue: identity,
        parser: identity,
      };
      const ctrl = createRunningControllerSignal(startFn, options);
      expect(ctrl).toHaveProperty('stop');
      expect(ctrl).toHaveProperty('start');
      expect(ctrl).toHaveProperty('clear');
      expect(ctrl).toHaveProperty('stopSignal');
      expect(ctrl).toHaveProperty('resolvers');
      expect(ctrl.stopSignal).toBe(true);
    });

    test('stop 方法应该设置 stopSignal 并调用 onStop', () => {
      const startFn = vi.fn();
      const options = {
        autoStart: true,
        easing: identity,
        onStart: vi.fn(),
        onStop: vi.fn(),
        onClear: vi.fn(),
        onUpdate: vi.fn(),
        onComplete: vi.fn(),
        formatter: identity,
        formatterValue: identity,
        parser: identity,
      };
      const ctrl = createRunningControllerSignal(startFn, options);
      ctrl.stop();
      expect(ctrl.stopSignal).toBe(true);
      expect(options.onStop).toHaveBeenCalled();
    });

    test('start 方法应该清除 stopSignal、调用 onStart 并调用 startFn', () => {
      const startFn = vi.fn();
      const options = {
        autoStart: true,
        easing: identity,
        onStart: vi.fn(),
        onStop: vi.fn(),
        onClear: vi.fn(),
        onUpdate: vi.fn(),
        onComplete: vi.fn(),
        formatter: identity,
        formatterValue: identity,
        parser: identity,
      };
      const ctrl = createRunningControllerSignal(startFn, options);
      ctrl.start();
      expect(ctrl.stopSignal).toBe(false);
      expect(options.onStart).toHaveBeenCalled();
      expect(startFn).toHaveBeenCalled();
    });

    test('clear 方法应该设置 stopSignal、调用 onClear 并 resolve promise', () => {
      const startFn = vi.fn();
      const resolveSpy = vi.fn();
      const options = {
        autoStart: true,
        easing: identity,
        onStart: vi.fn(),
        onStop: vi.fn(),
        onClear: vi.fn(),
        onUpdate: vi.fn(),
        onComplete: vi.fn(),
        formatter: identity,
        formatterValue: identity,
        parser: identity,
      };
      const ctrl = createRunningControllerSignal(startFn, options);
      ctrl.resolvers.resolve = resolveSpy;
      ctrl.clear();
      expect(ctrl.stopSignal).toBe(true);
      expect(options.onClear).toHaveBeenCalled();
      expect(resolveSpy).toHaveBeenCalledWith(true);
    });
  });
});
