import { describe, expect, test } from 'vitest';
import { allx } from '../index';

describe('allx - 错误处理测试', () => {
  test('任务抛出错误时应该被捕获', async () => {
    await expect(
      allx({
        task1: async () => {
          throw new Error('Task error');
        },
      }),
    ).rejects.toThrow('Task error');
  });

  test('依赖的任务失败时，依赖它的任务也应该失败', async () => {
    await expect(
      allx({
        task1: async () => {
          throw new Error('Task1 failed');
        },
        task2: async function () {
          await this.$.task1;
          return 'should not reach here';
        },
      }),
    ).rejects.toThrow('Task1 failed');
  });

  test('访问不存在的任务应该抛出错误', async () => {
    await expect(
      allx({
        task1: async function () {
          // @ts-expect-error - 测试访问不存在的任务
          await this.$.nonExistent;
          return 'should not reach here';
        },
      }),
    ).rejects.toThrow('Unknown task "nonExistent"');
  });

  test('非函数任务应该直接将值存进结果中', async () => {
    expect(
      await allx({
        task1: 'not a function',
      }),
    ).toEqual({ task1: 'not a function' });

    expect(
      await allx({
        promise: Promise.resolve('promise result'),
      }),
    ).toEqual({ promise: 'promise result' });

    expect(
      await allx({
        number: () => 42,
        number2: 10,
        promise: Promise.resolve('promise result'),
        async numSum() {
          return (await this.$.number) + (await this.$.number2);
        },
      }),
    ).toEqual({ number: 42, number2: 10, promise: 'promise result', numSum: 52 });
  });

  test('多个任务失败时应该抛出第一个错误', async () => {
    await expect(
      allx({
        task1: async () => {
          throw new Error('Error 1');
        },
        task2: async () => {
          throw new Error('Error 2');
        },
      }),
    ).rejects.toThrow(/Error [12]/);
  });

  test('部分任务失败不影响其他独立任务', async () => {
    const executedTasks: string[] = [];

    await expect(() =>
      allx({
        success: async () => {
          executedTasks.push('success');
          return 'ok';
        },
        fail: async () => {
          executedTasks.push('fail');
          throw new Error('Failed');
        },
      }),
    ).rejects.toThrow('Failed');

    expect(executedTasks).toContain('success');
    expect(executedTasks).toContain('fail');
  });
});
