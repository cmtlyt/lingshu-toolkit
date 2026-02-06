import { describe, expect, test } from 'vitest';
import { $dt, $t, dataHandler } from './index';

describe('data-handler', () => {
  test('handler 为对象', () => {
    const { result, errors } = dataHandler({ num: 1 }, { num: (value) => typeof value === 'number' });
    expect(result).toEqual({ num: 1 });
    expect(errors.length).toBe(0);
  });

  test('handler 为函数', () => {
    const { result, errors } = dataHandler({ num: 1 }, (value) => typeof value === 'number');
    expect(result).toEqual({ num: 1 });
    expect(errors.length).toBe(0);
  });

  test('未传递 handler', () => {
    // @ts-expect-error test
    expect(() => dataHandler({ num: 1 })).toThrowError(TypeError);
  });

  test('类型不匹配', () => {
    const { result, errors } = dataHandler({ num: 1 }, { num: (value) => typeof value === 'string' });
    expect(result).toEqual({ num: undefined });
    expect(errors.length).toBe(1);
  });

  test('使用 action 断言类型', () => {
    const { result, errors } = dataHandler(
      { num: 1 },
      { num: (value, action) => action.assert(typeof value === 'string') },
    );
    expect(result).toEqual({ num: undefined });
    expect(errors.length).toBe(1);

    const { result: result2, errors: errors2 } = dataHandler(
      { num: 1 },
      { num: (value, action) => action.assert(typeof value === 'number') },
    );
    expect(result2).toEqual({ num: 1 });
    expect(errors2.length).toBe(0);
  });

  test('使用 action 转换数据', () => {
    const { result, errors } = dataHandler({ num: 1 }, { num: (value, action) => action.transform(value + 1) });
    expect(result).toEqual({ num: 2 });
    expect(errors.length).toBe(0);
  });

  test('assert 和 transform 混合使用', () => {
    const { result, errors } = dataHandler({ num: 1, str: '1' }, (value, _, action) => {
      action.assert(typeof value === 'number');
      action.transform((value as any) + 1);
    });
    expect(result).toEqual({ num: 2, str: undefined });
    expect(errors.length).toBe(1);
  });

  test('严格校验模式(断言通过)', () => {
    const { result, errors } = dataHandler({ num: 1 }, { num: (value) => typeof value === 'number' }, { strict: true });
    expect(result).toEqual({ num: 1 });
    expect(errors.length).toBe(0);
  });

  test('严格校验模式(断言失败)', () => {
    expect(() => dataHandler({ num: 1 }, { num: (value) => typeof value === 'string' }, { strict: true })).toThrowError(
      TypeError,
    );
  });

  test('自定义错误处理(非严格模式)', () => {
    const { result } = dataHandler(
      { num: 1 },
      { num: (value) => typeof value === 'string' },
      { errorHandler: (errors) => expect(errors.length).toBe(1) },
    );
    expect(result).toEqual({ num: undefined });
  });

  test('自定义错误处理(严格模式)', () => {
    const { result } = dataHandler(
      { num: 1 },
      { num: (value) => typeof value === 'string' },
      { strict: true, errorHandler: (errors) => expect(errors.length).toBe(1) },
    );
    expect(result).toEqual({ num: undefined });
  });

  test('传递默认值(断言通过)', () => {
    const { result, errors } = dataHandler(
      { str: '1' },
      { str: (value) => typeof value === 'string' },
      { defaultValue: { num: 1, str: '1', boolean: true } },
    );
    expect(result).toEqual({ num: 1, str: '1', boolean: true });
    expect(errors.length).toBe(0);
  });

  test('传递默认值(断言错误)', () => {
    const { result, errors } = dataHandler<{ num: number; str: string; boolean: boolean }>(
      // @ts-expect-error test
      { num: 1, str: 1 },
      { str: (value) => typeof value === 'string' },
      { defaultValue: { num: 1, str: '1', boolean: true } },
    );
    expect(result).toEqual({ num: 1, str: '1', boolean: true });
    expect(errors.length).toBe(1);
  });
});

describe('data-handler-tools', () => {
  test('基本使用', () => {
    expect(
      dataHandler({ str: '1', num: 1, bool: true }, $dt({ str: 'string', num: 'number', bool: $t.boolean })),
    ).toEqual({ result: { str: '1', num: 1, bool: true }, errors: [] });
  });

  test('类型错误', () => {
    const result = dataHandler({ str: 1, num: 1, bool: true }, $dt({ str: 'string', num: 'number', bool: $t.boolean }));
    expect(result.errors.length).toBe(1);
    expect(result.result).toEqual({ str: undefined, num: 1, bool: true });
  });

  test('传入不存在的校验类型时跳过该字段的校验', () => {
    expect(
      // @ts-expect-error test
      dataHandler({ str: 1, num: 1, bool: true }, $dt({ str: 'string1', num: 'number', bool: $t.boolean() })).result,
    ).toEqual({ str: 1, num: 1, bool: true });
  });

  test('类型错误时使用默认值', () => {
    expect(
      dataHandler({ str: 1, num: 1, bool: true }, $dt({ str: $t.string('default'), num: 'number', bool: 'boolean' })),
    ).toEqual({ result: { str: 'default', num: 1, bool: true }, errors: [] });
  });

  test('使用函数生成默认值', () => {
    expect(
      dataHandler(
        { str: 1, num: 1, bool: true },
        $dt({ str: $t.string((_v: any) => `default:${_v}`), num: 'number', bool: 'boolean' }),
      ),
    ).toEqual({ result: { str: 'default:1', num: 1, bool: true }, errors: [] });
  });

  test('使用自定义类型校验器', () => {
    expect(
      dataHandler(
        { str: 1, num: 1, bool: true },
        $dt({
          str: $t.string((_v: any) => `default:${_v}`),
          num: (_v: any, actions) => {
            if (typeof _v === 'number' && _v >= 10) {
              return true;
            }
            actions.transform(10);
          },
          bool: 'boolean',
        }),
      ),
    ).toEqual({ result: { str: 'default:1', num: 10, bool: true }, errors: [] });
  });

  test('validNumber', () => {
    expect(dataHandler({ num: 1 }, $dt({ num: $t.validNumber((_v: any) => 10) }))).toEqual({
      result: { num: 1 },
      errors: [],
    });
    expect(dataHandler({ num: '1' }, $dt({ num: $t.validNumber((_v: any) => 10) }))).toEqual({
      result: { num: 10 },
      errors: [],
    });
    expect(dataHandler({ num: Number.NaN }, $dt({ num: $t.validNumber(10) }))).toEqual({
      result: { num: 10 },
      errors: [],
    });
    const result = dataHandler({ num: Number.NaN }, $dt({ num: 'validNumber' }));
    expect(result.errors.length).toBe(1);
    expect(result.result).toEqual({ num: undefined });
  });

  test('validString', () => {
    expect(dataHandler({ str: 1 }, $dt({ str: $t.validString((_v: any) => '1') }))).toEqual({
      result: { str: '1' },
      errors: [],
    });
    expect(dataHandler({ str: '1' }, $dt({ str: $t.validString((_v: any) => '2') }))).toEqual({
      result: { str: '1' },
      errors: [],
    });
    expect(dataHandler({ str: 1 }, $dt({ str: $t.validString('2') }))).toEqual({
      result: { str: '2' },
      errors: [],
    });
    const result = dataHandler({ str: 1 }, $dt({ str: 'validString' }));
    expect(result.errors.length).toBe(1);
    expect(result.result).toEqual({ str: undefined });
  });

  test('notNullable', () => {
    expect(dataHandler({ str: 1 }, $dt({ str: 'notNullable' }))).toEqual({
      result: { str: 1 },
      errors: [],
    });
    const result = dataHandler({ str: null }, $dt({ str: 'notNullable' }));
    expect(result.errors.length).toBe(1);
    expect(result.result).toEqual({ str: undefined });
    const result2 = dataHandler({ str: undefined }, $dt({ str: 'notNullable' }));
    expect(result2.errors.length).toBe(1);
    expect(result2.result).toEqual({ str: undefined });
    expect(dataHandler({ str: '' }, $dt({ str: 'notNullable' }))).toEqual({
      result: { str: '' },
      errors: [],
    });
    const result3 = dataHandler({ str: null }, $dt({ str: $t.notNullable(0) }));
    expect(result3.result).toEqual({ str: 0 });
    expect(result3.errors.length).toBe(0);
  });

  test('enum', () => {
    expect(dataHandler({ str: '1' }, $dt({ str: $t.enum(['1', '2']) }))).toEqual({
      result: { str: '1' },
      errors: [],
    });
    const result = dataHandler({ str: '3' }, $dt({ str: $t.enum(['1', '2']) }));
    expect(result.errors.length).toBe(1);
    expect(result.result).toEqual({ str: undefined });
    const result2 = dataHandler({ str: '3' }, $dt({ str: $t.enum(['1', '2'], '1') }));
    expect(result2.result).toEqual({ str: '1' });
    expect(result2.errors.length).toBe(0);
    // @ts-expect-error test
    expect(() => dataHandler({}, $dt({ str: $t.enum(null, '1') }))).toThrowError(TypeError);
  });
});
