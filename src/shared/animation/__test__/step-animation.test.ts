import { describe, expect, test } from 'vitest';
import { stepAnimation } from '../index';

describe('stepAnimation', () => {
  test('应该生成正确数量的步骤', () => {
    const generator = stepAnimation(0, 100, 10);
    const values = Array.from(generator);
    expect(values).toHaveLength(11);
  });

  test('应该从起始值开始', () => {
    const generator = stepAnimation(0, 100, 10);
    const values = Array.from(generator);
    expect(values[0]).toBe(0);
  });

  test('应该到达结束值', () => {
    const generator = stepAnimation(0, 100, 10);
    const values = Array.from(generator);
    expect(values[values.length - 1]).toBe(100);
  });

  test('应该正确处理递增值', () => {
    const generator = stepAnimation(0, 100, 4);
    const values = Array.from(generator);
    expect(values).toEqual([0, 25, 50, 75, 100]);
  });

  test('应该正确处理递减值', () => {
    const generator = stepAnimation(100, 0, 4);
    const values = Array.from(generator);
    expect(values).toEqual([100, 75, 50, 25, 0]);
  });

  test('应该正确处理单步', () => {
    const generator = stepAnimation(0, 100, 1);
    const values = Array.from(generator);
    expect(values).toEqual([0, 100]);
  });

  test('应该使用 parser 解析值', () => {
    const parser = (value: any) => Number.parseInt(value, 10);
    const generator = stepAnimation('0', '100', 4, { parser });
    const values = Array.from(generator);
    expect(values).toEqual([0, 25, 50, 75, 100]);
  });

  test('应该使用 formatter 格式化值', () => {
    const formatter = (value: number) => Math.round(value);
    const generator = stepAnimation(0, 100, 4, { formatterValue: formatter });
    const values = Array.from(generator);
    expect(values).toEqual([0, 25, 50, 75, 100]);
  });

  test('应该处理数组类型', () => {
    const generator = stepAnimation([0, 0], [100, 200], 4);
    const values = Array.from(generator);
    expect(values).toEqual([
      [0, 0],
      [25, 50],
      [50, 100],
      [75, 150],
      [100, 200],
    ]);
  });

  test('应该处理对象类型', () => {
    const generator = stepAnimation({ x: 0, y: 0 }, { x: 100, y: 200 }, 4);
    const values = Array.from(generator);
    expect(values).toEqual([
      { x: 0, y: 0 },
      { x: 25, y: 50 },
      { x: 50, y: 100 },
      { x: 75, y: 150 },
      { x: 100, y: 200 },
    ]);
  });

  test('应该在 step 不是正整数时抛出错误', () => {
    expect(() => Array.from(stepAnimation(0, 100, 0))).toThrow('step must be a positive integer');
    expect(() => Array.from(stepAnimation(0, 100, -1))).toThrow('step must be a positive integer');
    expect(() => Array.from(stepAnimation(0, 100, 1.5))).toThrow('step must be a positive integer');
  });

  test('应该在类型不匹配时抛出错误', () => {
    // @ts-expect-error
    expect(() => Array.from(stepAnimation(0, '100', 4))).toThrow('from and to must be the same type');
  });

  test('应该在数组长度不匹配时抛出错误', () => {
    expect(() => Array.from(stepAnimation([0, 0], [100], 4))).toThrow('from and to must be the same length');
  });

  test('应该在对象缺少 key 时抛出错误', () => {
    expect(() => Array.from(stepAnimation({ x: 0 }, { x: 100, y: 200 }, 4))).toThrow('from does not have this key: y');
  });

  test('应该支持部分迭代', () => {
    const generator = stepAnimation(0, 100, 10);
    const iterator = generator[Symbol.iterator]();
    expect(iterator.next().value).toBe(0);
    expect(iterator.next().value).toBe(10);
    expect(iterator.next().value).toBe(20);
  });

  test('应该正确处理嵌套数组', () => {
    const generator = stepAnimation(
      [
        [0, 0],
        [10, 10],
      ],
      [
        [100, 200],
        [110, 210],
      ],
      2,
    );
    const values = Array.from(generator);
    expect(values).toEqual([
      [
        [0, 0],
        [10, 10],
      ],
      [
        [50, 100],
        [60, 110],
      ],
      [
        [100, 200],
        [110, 210],
      ],
    ]);
  });

  test('应该正确处理嵌套对象', () => {
    const generator = stepAnimation({ pos: { x: 0, y: 0 } }, { pos: { x: 100, y: 200 } }, 2);
    const values = Array.from(generator);
    expect(values).toEqual([{ pos: { x: 0, y: 0 } }, { pos: { x: 50, y: 100 } }, { pos: { x: 100, y: 200 } }]);
  });
});
