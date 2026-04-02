import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { allx } from '../index';

describe('allx - 执行顺序和并行性测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('独立任务应该并行执行', async () => {
    const executionOrder: number[] = [];

    const promise = allx({
      task1: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        executionOrder.push(1);
        return 1;
      },
      task2: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        executionOrder.push(2);
        return 2;
      },
      task3: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        executionOrder.push(3);
        return 3;
      },
    });

    // 推进时间到 10ms，task2 应该完成
    vi.advanceTimersByTime(10);

    // 推进时间到 20ms，task3 应该完成
    vi.advanceTimersByTime(10);

    // 推进时间到 30ms，task1 应该完成
    vi.advanceTimersByTime(10);

    const result = await promise;

    // 由于并行执行，task2 应该最先完成
    expect(executionOrder[0]).toBe(2);
    expect(result).toEqual({ task1: 1, task2: 2, task3: 3 });
  });

  test('有依赖的任务应该等待依赖完成', async () => {
    const executionOrder: string[] = [];

    const result = await allx({
      task1: async () => {
        executionOrder.push('task1-start');
        await vi.advanceTimersByTimeAsync(20);
        executionOrder.push('task1-end');
        return 1;
      },
      task2: async function () {
        executionOrder.push('task2-start');
        const value = await this.$.task1;
        executionOrder.push('task2-end');
        return value + 1;
      },
    });

    expect(executionOrder).toEqual(['task1-start', 'task2-start', 'task1-end', 'task2-end']);
    expect(result).toEqual({ task1: 1, task2: 2 });
  });

  test('多个任务同时等待同一个依赖', async () => {
    let baseExecutionCount = 0;

    const result = await allx({
      base: async () => {
        baseExecutionCount++;
        await vi.advanceTimersByTimeAsync(20);
        return 10;
      },
      dependent1: async function () {
        const value = await this.$.base;
        return value + 1;
      },
      dependent2: async function () {
        const value = await this.$.base;
        return value + 2;
      },
      dependent3: async function () {
        const value = await this.$.base;
        return value + 3;
      },
    });

    // base 任务应该只执行一次
    expect(baseExecutionCount).toBe(1);
    expect(result).toEqual({
      base: 10,
      dependent1: 11,
      dependent2: 12,
      dependent3: 13,
    });
  });
});
