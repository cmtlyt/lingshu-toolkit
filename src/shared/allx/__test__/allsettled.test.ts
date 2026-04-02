import { describe, expect, test } from 'vitest';
import { allx } from '../index';

describe('allx - allSettled 测试', () => {
  test('allSettled 基础测试', async () => {
    const result = await allx(
      {
        task1: async () => {
          throw new Error('error1');
        },
        task2: async () => 'value2',
        task3: 0,
        // 依赖正常任务
        async task4() {
          return (await this.$.task2) + (await this.$.task3);
        },
        // 依赖报错任务
        async task5() {
          return (await this.$.task1) + (await this.$.task2);
        },
      },
      { allSettled: true },
    );

    expect(result).toEqual({
      task1: { status: 'rejected', reason: new Error('error1') },
      task2: { status: 'fulfilled', value: 'value2' },
      task3: { status: 'fulfilled', value: 0 },
      task4: { status: 'fulfilled', value: 'value20' },
      task5: { status: 'rejected', reason: new Error('error1') },
    });
  });

  test('allSettled 模式下，访问已拒绝的缓存任务应该 reject（覆盖第 34 行分支）', async () => {
    // 这个测试专门覆盖第 34 行：return Promise.reject(cached.reason);
    // 场景：在 allSettled 模式下，一个任务依赖另一个已完成的拒绝任务
    const result = await allx(
      {
        // 先创建一个会失败的任务
        failedTask: async () => {
          throw new Error('Task failed');
        },
        // 然后创建一个依赖失败任务的任务
        // 当这个任务访问 this.$.failedTask 时，failedTask 已经完成并被缓存
        // 由于是 allSettled 模式且 cached.status === 'rejected'，会走到第 34 行的分支
        dependentTask: async function () {
          try {
            await this.$.failedTask;
            return 'should not reach here';
          } catch (error) {
            return `caught: ${(error as Error).message}`;
          }
        },
      },
      { allSettled: true },
    );

    // 验证 failedTask 被标记为 rejected
    expect(result.failedTask.status).toBe('rejected');
    expect((result.failedTask as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((result.failedTask as PromiseRejectedResult).reason.message).toBe('Task failed');

    // 验证 dependentTask 成功捕获了错误
    expect(result.dependentTask.status).toBe('fulfilled');
    expect((result.dependentTask as PromiseFulfilledResult<string>).value).toBe('caught: Task failed');
  });

  test('allSettled 模式下，多个任务同时访问同一个已拒绝的缓存任务', async () => {
    const result = await allx(
      {
        failedTask: async () => {
          throw new Error('Base task failed');
        },
        dep1: async function () {
          try {
            await this.$.failedTask;
            return 'dep1 success';
          } catch (error) {
            return `dep1 caught: ${(error as Error).message}`;
          }
        },
        dep2: async function () {
          try {
            await this.$.failedTask;
            return 'dep2 success';
          } catch (error) {
            return `dep2 caught: ${(error as Error).message}`;
          }
        },
        dep3: async function () {
          try {
            await this.$.failedTask;
            return 'dep3 success';
          } catch (error) {
            return `dep3 caught: ${(error as Error).message}`;
          }
        },
      },
      { allSettled: true },
    );

    // 验证所有依赖任务都正确处理了失败的任务
    expect(result.failedTask.status).toBe('rejected');
    expect(result.dep1.status).toBe('fulfilled');
    expect((result.dep1 as PromiseFulfilledResult<string>).value).toBe('dep1 caught: Base task failed');
    expect(result.dep2.status).toBe('fulfilled');
    expect((result.dep2 as PromiseFulfilledResult<string>).value).toBe('dep2 caught: Base task failed');
    expect(result.dep3.status).toBe('fulfilled');
    expect((result.dep3 as PromiseFulfilledResult<string>).value).toBe('dep3 caught: Base task failed');
  });

  test('allSettled 模式下，混合依赖已拒绝和已完成的任务', async () => {
    const result = await allx(
      {
        failedTask: async () => {
          throw new Error('Failed');
        },
        successTask: async () => 'Success',
        mixedDep: async function () {
          const results: string[] = [];
          try {
            const value = await this.$.successTask;
            results.push(`success: ${value}`);
          } catch {
            results.push('success error');
          }
          try {
            await this.$.failedTask;
            results.push('failed ok');
          } catch (error) {
            results.push(`failed error: ${(error as Error).message}`);
          }
          return results.join(', ');
        },
      },
      { allSettled: true },
    );

    expect(result.failedTask.status).toBe('rejected');
    expect(result.successTask.status).toBe('fulfilled');
    expect(result.mixedDep.status).toBe('fulfilled');
    expect((result.mixedDep as PromiseFulfilledResult<string>).value).toBe('success: Success, failed error: Failed');
  });
});
