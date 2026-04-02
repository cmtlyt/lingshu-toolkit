import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { allx } from '../index';

describe('allx - 边界情况测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('任务返回 Promise', async () => {
    const result = await allx({
      task: () => Promise.resolve(42),
    });

    expect(result).toEqual({ task: 42 });
  });

  test('任务返回已解决的 Promise', async () => {
    const resolvedPromise = Promise.resolve('resolved');
    const result = await allx({
      task: () => resolvedPromise,
    });

    expect(result).toEqual({ task: 'resolved' });
  });

  test('使用 Symbol 作为任务名', async () => {
    const taskSymbol = Symbol('task');
    const result = await allx({
      [taskSymbol]: async () => 'symbol task',
    });

    expect(result[taskSymbol]).toBe('symbol task');
  });

  test('任务名包含特殊字符', async () => {
    const result = await allx({
      'task-1': async () => 1,
      task_2: async () => 2,
      'task.3': async () => 3,
      task$4: async () => 4,
    });

    expect(result).toEqual({
      'task-1': 1,
      task_2: 2,
      'task.3': 3,
      task$4: 4,
    });
  });

  test('任务返回大对象', async () => {
    const largeObject = { data: new Array(1000).fill(0).map((_, i) => i) };
    const result = await allx({
      task: async () => largeObject,
    });

    expect(result.task).toEqual(largeObject);
  });

  test('任务中使用 this 上下文', async () => {
    const result = await allx({
      task1: async () => 'value1',
      task2: async function () {
        expect(this.$).toBeDefined();
        expect(typeof this.$.task1).toBe('object'); // Promise
        return 'value2';
      },
    });

    expect(result).toEqual({
      task1: 'value1',
      task2: 'value2',
    });
  });

  test('任务返回函数', async () => {
    const fn = () => 'inner function';
    const result = await allx({
      task: async () => fn,
    });

    expect(typeof result.task).toBe('function');
    expect(result.task()).toBe('inner function');
  });

  test('任务返回类实例', async () => {
    class TestClass {
      value = 42;
      getValue() {
        return this.value;
      }
    }

    const result = await allx({
      task: async () => new TestClass(),
    });

    expect(result.task).toBeInstanceOf(TestClass);
    expect(result.task.getValue()).toBe(42);
  });

  test('循环依赖检测（间接）', async () => {
    // 注意：当前实现可能不会检测循环依赖，这个测试验证行为
    const promise = allx({
      task1: async function () {
        await this.$.task2;
        return 1;
      },
      task2: async function () {
        await this.$.task1;
        return 2;
      },
    });

    // 循环依赖会导致死锁，使用 timeout 来检测
    const timeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Timeout: possible circular dependency'));
      }, 100);
    });

    // 推进时间超过 timeout 时间
    vi.advanceTimersByTime(100);

    await expect(Promise.race([promise, timeout])).rejects.toThrow();
  });
});
