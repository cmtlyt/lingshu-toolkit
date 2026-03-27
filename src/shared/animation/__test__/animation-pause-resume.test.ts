import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { animation } from '../index';

describe('animation - 暂停和启动', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('多次暂停和启动应该保持时间准确性', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 100, { onUpdate });

    // 第一次运行 20ms
    vi.advanceTimersByTime(20);
    await vi.runAllTimersAsync();
    result.stop();

    // 暂停 10ms
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();

    // 重新启动运行 20ms
    result.start();
    vi.advanceTimersByTime(20);
    await vi.runAllTimersAsync();
    result.stop();

    // 暂停 10ms
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();

    // 重新启动运行 20ms
    result.start();
    vi.advanceTimersByTime(30);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值应该是 100
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe(100);

    // 验证动画确实运行了足够的时间（总共运行了 60ms）
    expect(onUpdate.mock.calls.length).toBeGreaterThan(5);
  });

  test('暂停后重新启动的值应该连续', async () => {
    const updateValues: number[] = [];
    const onUpdate = vi.fn((value: number) => {
      updateValues.push(value);
    });

    const result = animation(0, 100, 50, { onUpdate });

    // 运行一段时间
    vi.advanceTimersByTime(20);
    await vi.runAllTimersAsync();

    result.stop();

    // 等待 stop 后的多余 update 完成
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();

    // 记录停止后的值数量
    const valuesAfterStopCount = updateValues.length;

    // 重新启动
    result.start();
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证重新启动后有新的值产生
    expect(updateValues.length).toBeGreaterThan(valuesAfterStopCount);

    // 验证最终值
    const finalValue = updateValues[updateValues.length - 1];
    expect(finalValue).toBe(100);

    // 验证所有值都在合理范围内
    updateValues.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });
  });

  test('在动画早期暂停和启动', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 50, { onUpdate });

    // 在早期（10ms）暂停
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();
    result.stop();

    // 等待一段时间后重新启动
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();
    result.start();

    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe(100);
  });

  test('在动画中期暂停和启动', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 50, { onUpdate });

    // 在中期（25ms）暂停
    vi.advanceTimersByTime(25);
    await vi.runAllTimersAsync();
    result.stop();

    // 等待一段时间后重新启动
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();
    result.start();

    vi.advanceTimersByTime(35);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe(100);
  });

  test('在动画晚期暂停和启动', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 50, { onUpdate });

    // 在晚期（40ms）暂停
    vi.advanceTimersByTime(40);
    await vi.runAllTimersAsync();
    result.stop();

    // 等待一段时间后重新启动
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();
    result.start();

    vi.advanceTimersByTime(20);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe(100);
  });

  test('暂停后立即启动（最小间隔）', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 50, { onUpdate });

    // 运行一段时间
    vi.advanceTimersByTime(25);
    await vi.runAllTimersAsync();

    // 停止后立即启动
    result.stop();
    result.start();

    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe(100);
  });

  test('长时间暂停后启动', async () => {
    const onUpdate = vi.fn();
    const result = animation(0, 100, 50, { onUpdate });

    // 运行一段时间
    vi.advanceTimersByTime(15);
    await vi.runAllTimersAsync();

    // 停止
    result.stop();

    // 长时间暂停（50ms）
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();

    // 重新启动
    result.start();
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    await result.promise;

    // 验证最终值
    const finalValue = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
    expect(finalValue).toBe(100);
  });

  test('暂停期间启动另一个动画应该互不影响', async () => {
    const onUpdate1 = vi.fn();
    const onUpdate2 = vi.fn();

    // 启动动画A
    const anim1 = animation(0, 100, 50, { onUpdate: onUpdate1 });

    // 运行一段时间
    vi.advanceTimersByTime(15);
    await vi.runAllTimersAsync();

    // 停止动画A
    anim1.stop();

    // 启动动画B
    const anim2 = animation(200, 300, 25, { onUpdate: onUpdate2 });
    vi.advanceTimersByTime(30);
    await vi.runAllTimersAsync();
    await anim2.promise;

    // 验证动画B完成
    const finalValue2 = onUpdate2.mock.calls[onUpdate2.mock.calls.length - 1][0];
    expect(finalValue2).toBe(300);

    // 重新启动动画A
    anim1.start();
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    await anim1.promise;

    // 验证动画A完成
    const finalValue1 = onUpdate1.mock.calls[onUpdate1.mock.calls.length - 1][0];
    expect(finalValue1).toBe(100);

    // 验证动画A的所有值都在0-100之间
    onUpdate1.mock.calls.forEach((call) => {
      const value = call[0];
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });

    // 验证动画B的所有值都在200-300之间
    onUpdate2.mock.calls.forEach((call) => {
      const value = call[0];
      expect(value).toBeGreaterThanOrEqual(200);
      expect(value).toBeLessThanOrEqual(300);
    });
  });
});

describe('onStart 中同步调用 stop() 的 startTime 累加边界情况', () => {
  test('onStart 中同步调用 stop() 时不应调度任何 tick', async () => {
    vi.useRealTimers();
    const onUpdate = vi.fn();

    let startCallCount = 0;
    const result = animation(0, 100, 50, {
      autoStart: false,
      onUpdate,
      onStart: () => {
        startCallCount++;
        if (startCallCount === 1) {
          // 第一次启动时在 onStart 内同步调用 stop()
          result.stop();
        }
      },
    });

    result.start();

    // 等待足够时间，确认没有 tick 被调度（因为立即被 stop）
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onUpdate).not.toHaveBeenCalled();

    result.clear();
    vi.useFakeTimers();
  });

  test('onStart 中同步调用 stop() 后再次 start()，easing 接收的进度值不应为负数', async () => {
    vi.useRealTimers();
    const progressValues: number[] = [];
    // 通过拦截 easing 参数来捕获原始进度值
    const easing = (t: number) => {
      progressValues.push(t);
      return t;
    };

    let startCallCount = 0;
    const result = animation(0, 100, 100, {
      autoStart: false,
      easing,
      onStart: () => {
        startCallCount++;
        if (startCallCount === 1) {
          // 第一次 start 时在 onStart 内立即 stop()
          // 此时 startTime 已被累加，若修复缺失，二次 start 后 elapsed 会是负数
          result.stop();
        }
      },
    });

    result.start(); // 第一次：onStart 中立即 stop()，startTime 已累加约 performance.now()
    await new Promise((resolve) => setTimeout(resolve, 5));

    result.start(); // 第二次：startTime 再次累加，若未修复则 startTime ≈ 2 * performance.now()
    await new Promise((resolve) => setTimeout(resolve, 40));

    // 若存在 bug，easing 会收到负数进度值（elapsed 为负）
    expect(progressValues.length).toBeGreaterThan(0);
    progressValues.forEach((t) => {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    });

    result.clear();
    vi.useFakeTimers();
  });

  test('onStart 中同步调用 stop() 后再次 start()，onUpdate 收到的值不应超出 [from, to] 范围', async () => {
    vi.useRealTimers();
    const updateValues: number[] = [];
    const onUpdate = vi.fn((value: number) => updateValues.push(value));

    let startCallCount = 0;
    const result = animation(0, 100, 80, {
      autoStart: false,
      onUpdate,
      onStart: () => {
        startCallCount++;
        if (startCallCount === 1) {
          result.stop();
        }
      },
    });

    result.start(); // 第一次：onStart 中立即 stop()
    await new Promise((resolve) => setTimeout(resolve, 5));

    result.start(); // 第二次正常启动
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(updateValues.length).toBeGreaterThan(0);
    // 若存在 startTime 双重累加 bug，会导致 elapsed 为负值，进而 value < 0
    updateValues.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });

    result.clear();
    vi.useFakeTimers();
  });

  test('多次在 onStart 中调用 stop() 后最终正常 start()，动画应正确完成并收敛到目标值', async () => {
    vi.useRealTimers();
    const onComplete = vi.fn();
    const updateValues: number[] = [];
    const onUpdate = vi.fn((value: number) => updateValues.push(value));

    let startCallCount = 0;
    const result = animation(0, 100, 50, {
      autoStart: false,
      onUpdate,
      onComplete,
      onStart: () => {
        startCallCount++;
        // 前两次 start 都在 onStart 中立即 stop()，模拟多次累加场景
        if (startCallCount <= 2) {
          result.stop();
        }
      },
    });

    result.start(); // 第1次，立即停止，startTime 累加一次
    await new Promise((resolve) => setTimeout(resolve, 5));
    result.start(); // 第2次，立即停止，startTime 再次累加
    await new Promise((resolve) => setTimeout(resolve, 5));
    result.start(); // 第3次，正常运行
    await result.promise;

    expect(onComplete).toHaveBeenCalledTimes(1);
    // 动画应该正常完成并到达目标值
    const finalValue = updateValues[updateValues.length - 1];
    expect(finalValue).toBe(100);
    // 所有中间值也应在合法范围内
    updateValues.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });
    vi.useFakeTimers();
  });
});
