import { describe, expect, test } from 'vitest';
import { allx } from '../index';

describe('allx - 环形依赖', () => {
  test('自依赖', async () => {
    await expect(() =>
      allx({
        a: async function (): Promise<number> {
          const v = await this.$.a;
          return v + 1;
        },
      }),
    ).rejects.toThrow(Error);
  });

  test('环形依赖', async () => {
    await expect(() =>
      allx({
        a: async function (): Promise<number> {
          const v = await this.$.b;
          return v + 1;
        },
        b: async function (): Promise<number> {
          const v = await this.$.a;
          return v + 1;
        },
      }),
    ).rejects.toThrow(Error);
  });

  test('菱形依赖（覆盖 utils.ts 第 14-16 行 visited.has(node) 逻辑）', async () => {
    // 这个测试专门覆盖 detectCycle 函数中的 visited.has(node) 分支
    // 场景：菱形依赖 A→B, A→C, B→D, C→D
    // 当从 A 检测是否能到达 D 时，D 会通过 B 和 C 两条路径被加入队列
    // visited.has(node) 确保只会处理一次，避免重复处理
    const result = await allx({
      a: async () => 'A',
      b: async function () {
        const v = await this.$.a;
        return `${v}-B`;
      },
      c: async function () {
        const v = await this.$.a;
        return `${v}-C`;
      },
      d: async function () {
        const [v1, v2] = await Promise.all([this.$.b, this.$.c]);
        return `${v1}+${v2}-D`;
      },
    });

    expect(result).toEqual({
      a: 'A',
      b: 'A-B',
      c: 'A-C',
      d: 'A-B+A-C-D',
    });
  });

  test('复杂依赖网（多个任务依赖同一个任务）', async () => {
    // 场景：多个任务同时依赖同一个任务，验证循环依赖检测不会误报
    const result = await allx({
      base: async () => 'base',
      dep1: async function () {
        const v = await this.$.base;
        return `${v}-dep1`;
      },
      dep2: async function () {
        const v = await this.$.base;
        return `${v}-dep2`;
      },
      dep3: async function () {
        const v = await this.$.base;
        return `${v}-dep3`;
      },
      final: async function () {
        const [d1, d2, d3] = await Promise.all([this.$.dep1, this.$.dep2, this.$.dep3]);
        return `${d1}|${d2}|${d3}`;
      },
    });

    expect(result).toEqual({
      base: 'base',
      dep1: 'base-dep1',
      dep2: 'base-dep2',
      dep3: 'base-dep3',
      final: 'base-dep1|base-dep2|base-dep3',
    });
  });

  test('多层菱形依赖', async () => {
    // 场景：更复杂的菱形依赖结构
    // A→B, A→C, B→D, C→D, D→E
    const result = await allx({
      a: async () => 1,
      b: async function () {
        const v = await this.$.a;
        return v + 10;
      },
      c: async function () {
        const v = await this.$.a;
        return v + 100;
      },
      d: async function () {
        const [v1, v2] = await Promise.all([this.$.b, this.$.c]);
        return v1 + v2;
      },
      e: async function () {
        const v = await this.$.d;
        return v * 2;
      },
    });

    expect(result).toEqual({
      a: 1,
      b: 11,
      c: 101,
      d: 112,
      e: 224,
    });
  });

  test('带循环的菱形依赖（应该检测到循环）', async () => {
    // 场景：菱形依赖中包含循环
    // A→B, A→C, B→D, C→D, D→B (循环：D→B→D)
    await expect(() =>
      allx({
        a: async () => 'A',
        b: async function (): Promise<string> {
          const v = await this.$.a;
          const d = await this.$.d; // 这里形成循环：B 依赖 D，D 又依赖 B
          return `${v}-B-${d}`;
        },
        c: async function () {
          const v = await this.$.a;
          return `${v}-C`;
        },
        d: async function () {
          const [v1, v2] = await Promise.all([this.$.b, this.$.c]);
          return `${v1}+${v2}-D`;
        },
      }),
    ).rejects.toThrow(Error);
  });
});
