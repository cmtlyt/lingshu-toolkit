import { describe, expectTypeOf, test } from 'vitest';
import { conditionMerge } from '.';

describe('conditionMerge 类型测试', () => {
  test(': 混合布尔类型', () => {
    const t1 = conditionMerge([
      { condition: true, value: { num: 1 } },
      { condition: Math.random() > 0.5, value: { num: 3, str: '3' }, fullback: { str: '4' } },
    ]);
    expectTypeOf(t1).pick<'num'>().toEqualTypeOf<{ num: number }>();
    expectTypeOf(t1).pick<'str'>().toEqualTypeOf<{ str: string }>();

    expectTypeOf(
      conditionMerge(
        { condition: true, value: { num: 1 } },
        { condition: Math.random() > 0.5, value: { num: 3, str: '3' }, fullback: { str: '4' } },
      ),
    ).toEqualTypeOf(t1);

    const t3 = conditionMerge([
      { condition: true, value: { num: 1 } },
      { condition: false, value: { num: 1 }, fullback: { bool: true } },
      { condition: Math.random() > 0.5, value: { num: 3, str: '3' }, fullback: { str: '4' } },
    ]);
    expectTypeOf(t3).pick<'num'>().toEqualTypeOf<{ num: number }>();
    expectTypeOf(t3).pick<'str'>().toEqualTypeOf<{ str: string }>();
    expectTypeOf(t3).pick<'bool'>().toEqualTypeOf<{ bool: boolean }>();
  });

  test('类型测试: 纯 boolean 类型测试', () => {
    const t1 = conditionMerge([
      { condition: Math.random() > 0.1, value: { num: 1 } },
      { condition: Math.random() > 0.5, value: { num: 3, str: '3' }, fullback: { str: '4' } },
    ]);
    expectTypeOf(t1).pick<'str'>().toEqualTypeOf<{ str: string }>();
    expectTypeOf(t1).pick<'num'>().toEqualTypeOf<{ num: any }>();

    expectTypeOf(
      conditionMerge(
        { condition: Math.random() > 0.1, value: { num: 1 } },
        { condition: Math.random() > 0.5, value: { num: 3, str: '3' }, fullback: { str: '4' } },
      ),
    ).toEqualTypeOf(t1);
  });
});
