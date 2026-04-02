import { describe, expect, test } from 'vitest';
import { allx } from '../index';

describe('allx - 基础功能测试', () => {
  test('导出测试', () => {
    expect(allx).toBeTypeOf('function');
  });

  test('执行简单的并行任务', async () => {
    const result = await allx({
      task1: async () => 1,
      task2: async () => 2,
      task3: async () => 3,
    });

    expect(result).toEqual({
      task1: 1,
      task2: 2,
      task3: 3,
    });
  });

  test('执行同步任务', async () => {
    const result = await allx({
      task1: () => 'hello',
      task2: () => 'world',
    });

    expect(result).toEqual({
      task1: 'hello',
      task2: 'world',
    });
  });

  test('混合同步和异步任务', async () => {
    const result = await allx({
      sync: () => 'sync',
      async: async () => 'async',
    });

    expect(result).toEqual({
      sync: 'sync',
      async: 'async',
    });
  });

  test('返回不同类型的值', async () => {
    const result = await allx({
      number: () => 42,
      string: () => 'test',
      boolean: () => true,
      null: () => null,
      undefined: () => {},
      object: () => {
        return { key: 'value' };
      },
      array: () => [1, 2, 3],
    });

    expect(result).toEqual({
      number: 42,
      string: 'test',
      boolean: true,
      null: null,
      undefined: undefined,
      object: { key: 'value' },
      array: [1, 2, 3],
    });
  });

  test('空任务对象', async () => {
    const result = await allx({});
    expect(result).toEqual({});
  });
});
