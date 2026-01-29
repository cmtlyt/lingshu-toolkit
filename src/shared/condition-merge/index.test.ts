import { describe, expect, test } from 'vitest';
import { conditionMerge } from './index';

describe('conditionMerge', () => {
  test('导出测试', () => {
    expect(conditionMerge).toBeTypeOf('function');
  });

  test('基本使用', () => {
    expect(
      conditionMerge([
        { condition: true, value: { num: 1 } },
        { condition: false, value: { num: 3 }, fullback: { num: 4 } },
      ]),
    ).toEqual({ num: 4 });

    expect(
      conditionMerge([
        { condition: true, value: { num: 1 } },
        { condition: false, value: { num: 3 } },
      ]),
    ).toEqual({ num: 1 });

    expect(
      conditionMerge([
        { condition: true, value: { num: 1 } },
        { condition: false, value: { num: 3 }, fullback: { str: '1' } },
      ]),
    ).toEqual({ num: 1, str: '1' });
  });

  test('数组方式传递参数', () => {
    expect(
      conditionMerge([
        [true, { num: 1 }],
        [false, { num: 3 }, { num: 4 }],
      ]),
    ).toEqual({ num: 4 });

    expect(
      conditionMerge([
        [true, { num: 1 }],
        [false, { num: 3 }],
      ]),
    ).toEqual({ num: 1 });

    expect(
      conditionMerge([
        [true, { num: 1 }],
        [false, { num: 3 }, { str: '1' }],
      ]),
    ).toEqual({ num: 1, str: '1' });
  });

  test('合并数组', () => {
    expect(
      conditionMerge([
        [true, [1, 2]],
        [false, [], [3, 4]],
        [true, [5, 6]],
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('混合使用对象和数组', () => {
    expect(
      conditionMerge([[true, { num: 1 }], [false, { num: 3 }, { str: '1' }], { condition: true, value: { num: 2 } }]),
    ).toEqual({ num: 2, str: '1' });
    expect(conditionMerge([[true, { num: 1 }], [false, { num: 3 }], { condition: true, value: { num: 2 } }])).toEqual({
      num: 2,
    });
  });

  test('使用扩展参数传递', () => {
    expect(
      conditionMerge(
        //
        [true, { num: 1 }],
        [false, { num: 3 }, { str: '1' }],
        { condition: true, value: { num: 2 }, fullback: { str: '2' } },
      ),
    ).toEqual({
      num: 2,
      str: '1',
    });
  });

  test('传入的参数不是数组和对象', () => {
    // @ts-expect-error test
    expect(() => conditionMerge(1)).toThrowError(TypeError);

    // @ts-expect-error test
    expect(() => conditionMerge([1])).toThrowError(TypeError);

    // @ts-expect-error test
    expect(() => conditionMerge([[true, 1]])).toThrowError(TypeError);

    // @ts-expect-error test
    expect(() => conditionMerge([{ condition: true, value: 1 }])).toThrowError(TypeError);

    // @ts-expect-error test
    expect(() => conditionMerge([{ condition: true, value: [], fullback: '13' }])).toThrowError(TypeError);
  });

  test('传入 null 或 undefined', () => {
    // @ts-expect-error test
    expect(conditionMerge([[true, null]])).toEqual({});
    // @ts-expect-error test
    expect(() => conditionMerge([[true, undefined]])).toThrowError(TypeError);
  });
});
