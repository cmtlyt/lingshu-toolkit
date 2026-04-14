import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { allx } from '../index';

describe('allx - 任务依赖测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('任务可以依赖其他任务的结果', async () => {
    const result = await allx({
      task1: async () => 10,
      async task2() {
        const value = await this.$.task1;
        return value * 2;
      },
    });

    expect(result).toEqual({
      task1: 10,
      task2: 20,
    });
  });

  test('多个任务依赖同一个任务', async () => {
    const result = await allx({
      base: async () => 5,
      async double() {
        const value = await this.$.base;
        return value * 2;
      },
      async triple() {
        const value = await this.$.base;
        return value * 3;
      },
    });

    expect(result).toEqual({
      base: 5,
      double: 10,
      triple: 15,
    });
  });

  test('链式依赖', async () => {
    const result = await allx({
      task1: async () => 1,
      async task2() {
        const value = await this.$.task1;
        return value + 1;
      },
      async task3() {
        const value = await this.$.task2;
        return value + 1;
      },
    });

    expect(result).toEqual({
      task1: 1,
      task2: 2,
      task3: 3,
    });
  });

  test('复杂的依赖关系', async () => {
    const result = await allx({
      a: async () => 1,
      b: async () => 2,
      async c() {
        const [aVal, bVal] = await Promise.all([this.$.a, this.$.b]);
        return aVal + bVal;
      },
      async d() {
        const cVal = await this.$.c;
        return cVal * 2;
      },
    });

    expect(result).toEqual({
      a: 1,
      b: 2,
      c: 3,
      d: 6,
    });
  });

  test('任务可以依赖多个其他任务', async () => {
    const result = await allx({
      task1: async () => 10,
      task2: async () => 20,
      task3: async () => 30,
      async sum() {
        const [v1, v2, v3] = await Promise.all([this.$.task1, this.$.task2, this.$.task3]);
        return v1 + v2 + v3;
      },
    });

    expect(result).toEqual({
      task1: 10,
      task2: 20,
      task3: 30,
      sum: 60,
    });
  });

  test('同步任务依赖异步任务', async () => {
    const result = await allx({
      async: async () => {
        await vi.advanceTimersByTimeAsync(10);
        return 'async result';
      },
      async sync() {
        const value = await this.$.async;
        return `got ${value}`;
      },
    });

    expect(result).toEqual({
      async: 'async result',
      sync: 'got async result',
    });
  });

  test('依赖已完成的任务', async () => {
    const result = await allx({
      task1: async () => 1,
      async task2() {
        await vi.advanceTimersByTimeAsync(10);
        const value = await this.$.task1;
        return value + 1;
      },
    });

    expect(result).toEqual({
      task1: 1,
      task2: 2,
    });
  });
});
