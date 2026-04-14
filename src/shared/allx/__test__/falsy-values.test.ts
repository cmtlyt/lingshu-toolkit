import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { allx } from '../index';

describe('allx - 虚值依赖测试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test('依赖返回 0 的任务（非 allSettled 模式）', async () => {
    const result = await allx({
      zero: async () => 0,
      async dependent() {
        const value = await this.$.zero;
        return value + 1;
      },
    });

    expect(result).toEqual({ zero: 0, dependent: 1 });
  });

  test('依赖返回 false 的任务（非 allSettled 模式）', async () => {
    const result = await allx({
      flag: async () => false,
      async dependent() {
        const value = await this.$.flag;
        return !value;
      },
    });

    expect(result).toEqual({ flag: false, dependent: true });
  });

  test('依赖返回空字符串的任务（非 allSettled 模式）', async () => {
    const result = await allx({
      empty: async () => '',
      async dependent() {
        const value = await this.$.empty;
        return `prefix_${value}`;
      },
    });

    expect(result).toEqual({ empty: '', dependent: 'prefix_' });
  });

  test('依赖返回 null 的任务（非 allSettled 模式）', async () => {
    const result = await allx({
      nullable: async () => null,
      async dependent() {
        const value = await this.$.nullable;
        return value === null ? 'was null' : 'not null';
      },
    });

    expect(result).toEqual({ nullable: null, dependent: 'was null' });
  });

  test('依赖返回 NaN 的任务（非 allSettled 模式）', async () => {
    const result = await allx({
      nan: async () => Number.NaN,
      async dependent() {
        const value = await this.$.nan;
        return Number.isNaN(value) ? 'is nan' : 'not nan';
      },
    });

    expect(result).toEqual({ nan: Number.NaN, dependent: 'is nan' });
  });

  test('字面量 0（非函数任务）被其他任务依赖（非 allSettled 模式）', async () => {
    // 已有测试用 number2: 10（真值），此处验证虚值字面量任务作为依赖
    const result = await allx({
      zero: 0,
      async dependent() {
        const value = await this.$.zero;
        return value + 10;
      },
    });

    expect(result).toEqual({ zero: 0, dependent: 10 });
  });

  test('多个任务同时依赖同一个返回虚值的任务', async () => {
    const result = await allx({
      base: async () => 0,
      async dep1() {
        const v = await this.$.base;
        return v + 1;
      },
      async dep2() {
        const v = await this.$.base;
        return v + 2;
      },
    });

    expect(result).toEqual({ base: 0, dep1: 1, dep2: 2 });
  });

  test('依赖的虚值任务先于访问方完成（缓存路径）', async () => {
    // 通过 advanceTimers 保证 zero 先完成，触发 results[depName] 缓存路径
    const result = await allx({
      zero: async () => 0,
      async dependent() {
        await vi.advanceTimersByTimeAsync(10);
        const value = await this.$.zero; // zero 已完成，走缓存判断分支
        return value + 5;
      },
    });

    expect(result).toEqual({ zero: 0, dependent: 5 });
  });

  test('链式依赖中间节点返回虚值', async () => {
    const result = await allx({
      a: async () => 1,
      async b() {
        const v = await this.$.a;
        return v - 1; // 返回 0
      },
      async c() {
        const v = await this.$.b;
        return v + 100;
      },
    });

    expect(result).toEqual({ a: 1, b: 0, c: 100 });
  });
});
