import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { animation } from '../index';

describe('animation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('应该返回一个包含 promise 和控制方法的对象', () => {
    const result = animation(0, 100, 100);
    expect(result).toHaveProperty('promise');
    expect(result).toHaveProperty('start');
    expect(result).toHaveProperty('stop');
    expect(result).toHaveProperty('clear');
  });

  test('应该在 autoStart 为 true 时自动开始动画', async () => {
    const onUpdate = vi.fn();
    animation(0, 100, 100, { onUpdate });
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    expect(onUpdate).toHaveBeenCalled();
  });

  test('应该在 autoStart 为 false 时不自动开始动画', async () => {
    const onUpdate = vi.fn();
    animation(0, 100, 100, { autoStart: false, onUpdate });
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  test('应该调用 start 方法开始动画', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, { autoStart: false, onUpdate });
    result.start();
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    expect(onUpdate).toHaveBeenCalled();
  });

  test('应该调用 stop 方法停止动画', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, { onUpdate });
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    result.stop();
    // stop 之后还会多一次 update 调用，因为无法立即中断上一帧
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    // 动画应该停止，不再有新的 update 调用
    const callCountAfterStop = onUpdate.mock.calls.length;
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    expect(onUpdate.mock.calls.length).toBe(callCountAfterStop);
  });

  test('应该调用 clear 方法清除动画并 resolve', async () => {
    vi.useRealTimers();
    const onUpdate = vi.fn();
    const onComplete = vi.fn();
    const result = animation(0, 100, 100, { onUpdate, onComplete });
    result.clear();
    await result.promise;
    expect(onComplete).not.toHaveBeenCalled();
    vi.useFakeTimers();
  });

  test('应该调用 onUpdate 回调', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, { onUpdate });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    expect(onUpdate).toHaveBeenCalled();
  });

  test('应该调用 onComplete 回调', async () => {
    const onComplete = vi.fn();
    const result = animation(0, 100, 100, { onComplete });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    expect(onComplete).toHaveBeenCalled();
  });

  test('应该调用 onStart 回调', () => {
    const onStart = vi.fn();
    const result = animation(0, 100, 100, { autoStart: false, onStart });
    result.start();
    expect(onStart).toHaveBeenCalled();
  });

  test('应该调用 onStop 回调', async () => {
    const onStop = vi.fn();
    const result = animation(0, 100, 100, { onStop });
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    result.stop();
    expect(onStop).toHaveBeenCalled();
  });

  test('应该调用 onClear 回调', () => {
    const onClear = vi.fn();
    const result = animation(0, 100, 100, { onClear });
    result.clear();
    expect(onClear).toHaveBeenCalled();
  });

  test('应该在 duration 不是正整数时抛出错误', () => {
    expect(() => animation(0, 100, 0)).toThrow('duration must be a positive integer');
    expect(() => animation(0, 100, -1)).toThrow('duration must be a positive integer');
    expect(() => animation(0, 100, 1.5)).toThrow('duration must be a positive integer');
  });

  test('应该正确使用 easing 函数', async () => {
    const onUpdate = vi.fn();
    const easing = (t: number) => t * t;
    const result = animation(0, 100, 100, { onUpdate, easing });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    const lastCallValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastCallValue).toBe(100);
  });

  test('应该使用 parser 解析值', async () => {
    const onUpdate = vi.fn();
    const parser = (value: any) => Number.parseInt(value, 10);
    const result = animation('0', '100', 100, { onUpdate, parser });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    const lastCallValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastCallValue).toBe(100);
  });

  test('应该使用 formatter 格式化值', async () => {
    const onUpdate = vi.fn();
    const formatter = (value: number) => Math.round(value);
    const result = animation(0, 100, 100, { onUpdate, formatterValue: formatter });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    expect(onUpdate).toHaveBeenCalled();
  });

  test('应该处理数组类型', async () => {
    const onUpdate = vi.fn();
    const result = animation([0, 0], [100, 200], 100, { onUpdate });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    const lastCallValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastCallValue).toEqual([100, 200]);
  });

  test('应该处理对象类型', async () => {
    const onUpdate = vi.fn();
    const result = animation({ x: 0, y: 0 }, { x: 100, y: 200 }, 100, { onUpdate });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    const lastCallValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastCallValue).toEqual({ x: 100, y: 200 });
  });

  test('promise 应该在动画完成时 resolve 为 false', async () => {
    const result = animation(0, 100, 100);
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    const value = await result.promise;
    expect(value).toBe(false);
  });

  test('promise 应该在 clear 时 resolve 为 true', async () => {
    vi.useRealTimers();
    const result = animation(0, 100, 100);
    await new Promise((resolve) => setTimeout(resolve, 50));
    result.clear();
    const value = await result.promise;
    expect(value).toBe(true);
    vi.useFakeTimers();
  });

  test('应该支持重新启动已停止的动画', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, { onUpdate });
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    result.stop();
    const callCountBeforeRestart = onUpdate.mock.calls.length;
    result.start();
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    expect(onUpdate.mock.calls.length).toBeGreaterThan(callCountBeforeRestart);
  });

  test('暂停后重新开始应该保持连贯，不重复 update', async () => {
    vi.useRealTimers();
    const updateValues: number[] = [];
    const onUpdate = vi.fn((value: number) => {
      updateValues.push(value);
    });

    const result = animation(0, 100, 100, { onUpdate });

    // 等待动画运行一段时间
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 停止动画
    result.stop();
    const valueAtStop = updateValues[updateValues.length - 1];
    const callCountAtStop = onUpdate.mock.calls.length;

    // 等待 stop 后的多余 update 调用完成
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callCountAfterStop = onUpdate.mock.calls.length;

    // 重新开始
    result.start();
    await result.promise;

    // 验证：
    // 1. stop 后只多了一次 update 调用（无法立即中断上一帧）
    expect(callCountAfterStop).toBe(callCountAtStop + 1);

    // 2. 重新开始后，update 值应该继续增加，不应该重复
    const lastValue = updateValues[updateValues.length - 1];
    expect(lastValue).toBeGreaterThan(valueAtStop);

    // 3. 没有重复的 update 值（除了可能的边界情况）
    const hasDuplicates = updateValues.some((val, idx) => idx > 0 && Math.abs(val - updateValues[idx - 1]) < 0.01);
    expect(hasDuplicates).toBe(false);
    vi.useFakeTimers();
  });

  test('应该在类型不匹配时抛出错误', () => {
    // @ts-expect-error
    expect(() => animation(0, '100', 100)).toThrow('from and to must be the same type');
  });

  test('应该在数组长度不匹配时抛出错误', () => {
    expect(() => animation([0, 0], [100], 100)).toThrow('from and to must be the same length');
  });

  test('应该在对象缺少 key 时抛出错误', () => {
    expect(() => animation({ x: 0 }, { x: 100, y: 200 }, 100)).toThrow('from does not have this key: y');
  });

  test('应该正确处理嵌套数组', async () => {
    const onUpdate = vi.fn();
    const result = animation(
      [
        [0, 0],
        [10, 10],
      ],
      [
        [100, 200],
        [110, 210],
      ],
      100,
      { onUpdate },
    );
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    const lastCallValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastCallValue).toEqual([
      [100, 200],
      [110, 210],
    ]);
  });

  test('应该正确处理嵌套对象', async () => {
    const onUpdate = vi.fn();
    const result = animation({ pos: { x: 0, y: 0 } }, { pos: { x: 100, y: 200 } }, 100, { onUpdate });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;
    const lastCallValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(lastCallValue).toEqual({ pos: { x: 100, y: 200 } });
  });

  test('应该在动画过程中持续调用 onUpdate', async () => {
    const onUpdate = vi.fn();
    animation(0, 100, 100, { onUpdate });
    const callCountAfter50ms = onUpdate.mock.calls.length;
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    expect(onUpdate.mock.calls.length).toBeGreaterThan(callCountAfter50ms);
  });

  test('多个动画并行执行应该互不影响', async () => {
    const onUpdate1 = vi.fn();
    const onUpdate2 = vi.fn();
    const onUpdate3 = vi.fn();

    // 创建三个不同的动画
    const anim1 = animation(0, 100, 100, { onUpdate: onUpdate1 });
    const anim2 = animation(200, 300, 100, { onUpdate: onUpdate2 });
    const anim3 = animation(0, 1000, 100, { onUpdate: onUpdate3, formatterValue: (v) => Math.round(v) });

    // 等待所有动画完成
    vi.advanceTimersByTime(150);
    await vi.runAllTimersAsync();
    await Promise.all([anim1.promise, anim2.promise, anim3.promise]);

    // 验证最终值
    const finalValue1 = onUpdate1.mock.calls[onUpdate1.mock.calls.length - 1][0];
    const finalValue2 = onUpdate2.mock.calls[onUpdate2.mock.calls.length - 1][0];
    const finalValue3 = onUpdate3.mock.calls[onUpdate3.mock.calls.length - 1][0];

    expect(finalValue1).toBe(100);
    expect(finalValue2).toBe(300);
    expect(finalValue3).toBe(1000);

    // 验证每个动画都调用了多次 onUpdate（说明动画确实在运行）
    expect(onUpdate1.mock.calls.length).toBeGreaterThan(1);
    expect(onUpdate2.mock.calls.length).toBeGreaterThan(1);
    expect(onUpdate3.mock.calls.length).toBeGreaterThan(1);

    // 验证动画1的所有值都在0-100之间
    onUpdate1.mock.calls.forEach((call) => {
      const value = call[0];
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });

    // 验证动画2的所有值都在200-300之间
    onUpdate2.mock.calls.forEach((call) => {
      const value = call[0];
      expect(value).toBeGreaterThanOrEqual(200);
      expect(value).toBeLessThanOrEqual(300);
    });

    // 验证动画3的所有值都在0-1000之间
    onUpdate3.mock.calls.forEach((call) => {
      const value = call[0];
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1000);
    });
  });

  test('多个动画并行执行使用不同的formatter应该互不影响', async () => {
    const onUpdate1 = vi.fn();
    const onUpdate2 = vi.fn();

    // 创建两个使用不同formatter的动画
    const anim1 = animation(0, 100, 100, {
      onUpdate: onUpdate1,
      formatterValue: (v) => Math.floor(v / 10) * 10, // 向下取整到10的倍数
    });
    const anim2 = animation(0, 100, 100, {
      onUpdate: onUpdate2,
      formatterValue: (v) => Math.ceil(v / 10) * 10, // 向上取整到10的倍数
    });

    // 等待所有动画完成
    vi.advanceTimersByTime(150);
    await vi.runAllTimersAsync();
    await Promise.all([anim1.promise, anim2.promise]);

    // 验证最终值
    const finalValue1 = onUpdate1.mock.calls[onUpdate1.mock.calls.length - 1][0];
    const finalValue2 = onUpdate2.mock.calls[onUpdate2.mock.calls.length - 1][0];

    expect(finalValue1).toBe(100);
    expect(finalValue2).toBe(100);

    // 验证每个动画都调用了多次 onUpdate（说明动画确实在运行）
    expect(onUpdate1.mock.calls.length).toBeGreaterThan(1);
    expect(onUpdate2.mock.calls.length).toBeGreaterThan(1);

    // 验证动画1的所有值都是10的倍数
    onUpdate1.mock.calls.forEach((call) => {
      const value = call[0];
      expect(value % 10).toBe(0);
    });

    // 验证动画2的所有值都是10的倍数
    onUpdate2.mock.calls.forEach((call) => {
      const value = call[0];
      expect(value % 10).toBe(0);
    });
  });

  test('应该同时使用 formatterValue 和 formatter 进行两次格式化', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, {
      // formatterValue: 先对数值进行格式化
      formatterValue: (v) => Math.floor(v / 10) * 10,
      // formatter: 再对格式化后的值进行二次格式化
      formatter: (v) => `${v}px`,
      onUpdate,
    });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe('100px');

    // 验证所有值都是字符串且以 'px' 结尾
    onUpdate.mock.calls.forEach((call) => {
      const value = call[0];
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d+px$/);
    });

    // 验证数值部分都是10的倍数
    onUpdate.mock.calls.forEach((call) => {
      const value = call[0];
      const numValue = Number.parseInt(value.replace('px', ''), 10);
      expect(numValue % 10).toBe(0);
    });
  });

  test('formatterValue 应该在 formatter 之前执行', async () => {
    const formatterValueCalls: number[] = [];
    const formatterCalls: number[] = [];
    const onUpdate = vi.fn();

    const result = animation(0, 100, 100, {
      formatterValue: (v) => {
        formatterValueCalls.push(v);
        return Math.floor(v / 10) * 10;
      },
      formatter: (v) => {
        formatterCalls.push(v);
        return `${v}px`;
      },
      onUpdate,
    });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证 formatterValue 和 formatter 的调用次数相同
    expect(formatterValueCalls.length).toBe(formatterCalls.length);

    // 验证 formatterValue 的输入是原始数值
    formatterValueCalls.forEach((v) => {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    });

    // 验证 formatter 的输入是 formatterValue 处理后的值（10的倍数）
    formatterCalls.forEach((v) => {
      expect(typeof v).toBe('number');
      expect(v % 10).toBe(0);
    });

    // 验证 formatterValue 的输出和 formatter 的输入一一对应
    for (let i = 0; i < formatterValueCalls.length; i++) {
      const output = Math.floor(formatterValueCalls[i] / 10) * 10;
      expect(formatterCalls[i]).toBe(output);
    }
  });

  test('应该支持只使用 formatterValue 而不使用 formatter', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, {
      formatterValue: (v) => Math.round(v),
      onUpdate,
    });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证所有值都是整数
    onUpdate.mock.calls.forEach((call) => {
      const value = call[0];
      expect(Number.isInteger(value)).toBe(true);
    });
  });

  test('应该支持只使用 formatter 而不使用 formatterValue', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, {
      formatter: (v) => `${Math.round(v)}px`,
      onUpdate,
    });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证所有值都是字符串
    onUpdate.mock.calls.forEach((call) => {
      const value = call[0];
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d+px$/);
    });
  });

  test('formatterValue 和 formatter 都不使用时应该返回原始数值', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, { onUpdate });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证所有值都是数值类型
    onUpdate.mock.calls.forEach((call) => {
      const value = call[0];
      expect(typeof value).toBe('number');
    });

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe(100);
  });

  test('formatterValue 和 formatter 在数组类型上的应用', async () => {
    const onUpdate = vi.fn();
    const result = animation([0, 0], [100, 200], 100, {
      formatterValue: (v) => Math.floor(v / 10) * 10,
      formatter: (v) => v.map((num) => `${num}px`),
      onUpdate,
    });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toEqual(['100px', '200px']);

    // 验证所有值都是数组且元素都是字符串
    onUpdate.mock.calls.forEach((call) => {
      const value = call[0];
      expect(Array.isArray(value)).toBe(true);
      value.forEach((item: any) => {
        expect(typeof item).toBe('string');
        expect(item).toMatch(/^\d+px$/);
      });
    });
  });

  test('formatterValue 和 formatter 在对象类型上的应用', async () => {
    const onUpdate = vi.fn();
    const result = animation({ x: 0, y: 0 }, { x: 100, y: 200 }, 100, {
      formatterValue: (v) => Math.floor(v / 10) * 10,
      formatter: (v) => {
        return { x: `${v.x}px`, y: `${v.y}px` };
      },
      onUpdate,
    });
    vi.advanceTimersByTime(100);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toEqual({ x: '100px', y: '200px' });

    // 验证所有值都是对象且属性都是字符串
    onUpdate.mock.calls.forEach((call) => {
      const value = call[0];
      expect(typeof value).toBe('object');
      expect(typeof value.x).toBe('string');
      expect(typeof value.y).toBe('string');
      expect(value.x).toMatch(/^\d+px$/);
      expect(value.y).toMatch(/^\d+px$/);
    });
  });
});
