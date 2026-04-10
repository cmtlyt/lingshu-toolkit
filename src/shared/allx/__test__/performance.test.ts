import { describe, expect, test } from 'vitest';
import { allx } from '../index';

describe('allx - 性能和压力测试', () => {
  test('处理大量独立任务', async () => {
    const tasks: Record<string, () => Promise<number>> = {};
    const taskCount = 100;

    for (let i = 0; i < taskCount; i++) {
      tasks[`task${i}`] = async () => i;
    }

    const result = await allx(tasks);

    expect(Object.keys(result).length).toBe(taskCount);
    for (let i = 0; i < taskCount; i++) {
      expect(result[`task${i}`]).toBe(i);
    }
  });

  test('处理深层依赖链', async () => {
    const depth = 20;
    const tasks: Record<string, any> = {
      task0: async () => 0,
    };

    for (let i = 1; i < depth; i++) {
      tasks[`task${i}`] = async function () {
        const value = await this.$[`task${i - 1}`];
        return value + 1;
      };
    }

    const result = await allx(tasks);

    expect(result[`task${depth - 1}`]).toBe(depth - 1);
  });

  test('混合独立和依赖任务', async () => {
    const result = await allx({
      independent1: async () => 1,
      independent2: async () => 2,
      independent3: async () => 3,
      async dependent1() {
        const value = await this.$.independent1;
        return value * 10;
      },
      async dependent2() {
        const [v1, v2] = await Promise.all([this.$.independent2, this.$.independent3]);
        return v1 + v2;
      },
      async final() {
        const [d1, d2] = await Promise.all([this.$.dependent1, this.$.dependent2]);
        return d1 + d2;
      },
    });

    expect(result).toEqual({
      independent1: 1,
      independent2: 2,
      independent3: 3,
      dependent1: 10,
      dependent2: 5,
      final: 15,
    });
  });
});
