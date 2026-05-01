import { describe, expect, test } from 'vitest';
import { createError, throwError, throwType } from '.';

describe('throw-error', () => {
  const prefix = '[@cmtlyt/lingshu-toolkit#test]: ';

  test('默认类型', () => {
    expect(() => throwError('test', 'test')).toThrowErrorMatchingInlineSnapshot(`[Error: ${prefix}test]`);
  });

  test('类型错误', () => {
    expect(() => throwType('test', 'test')).toThrowErrorMatchingInlineSnapshot(`[TypeError: ${prefix}test]`);
    expect(() => throwError('test', 'test', TypeError)).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: ${prefix}test]`,
    );
  });

  test('其他错误', () => {
    expect(() => throwError('test', 'test', SyntaxError)).toThrowErrorMatchingInlineSnapshot(
      `[SyntaxError: ${prefix}test]`,
    );
    expect(() => throwError('test', 'test', EvalError)).toThrowErrorMatchingInlineSnapshot(
      `[EvalError: ${prefix}test]`,
    );
    expect(() => throwError('test', 'test', RangeError)).toThrowErrorMatchingInlineSnapshot(
      `[RangeError: ${prefix}test]`,
    );
    expect(() => throwError('test', 'test', ReferenceError)).toThrowErrorMatchingInlineSnapshot(
      `[ReferenceError: ${prefix}test]`,
    );
    expect(() => throwError('test', 'test', URIError)).toThrowErrorMatchingInlineSnapshot(`[URIError: ${prefix}test]`);
  });

  test('获取错误对象', () => {
    expect(createError('test', 'test')).toBeInstanceOf(Error);
    expect(createError('test', 'test', TypeError)).toBeInstanceOf(TypeError);
  });

  test('cause 支持 - createError 携带原始错误', () => {
    const originalError = new Error('原始错误');
    const error = createError('test', 'test', { cause: originalError });
    expect(error).toBeInstanceOf(Error);
    expect(error.cause).toBe(originalError);
  });

  test('cause 支持 - createError 携带原始错误 + 自定义类型', () => {
    const originalError = new TypeError('原始类型错误');
    const error = createError('test', 'test', TypeError, { cause: originalError });
    expect(error).toBeInstanceOf(TypeError);
    expect(error.cause).toBe(originalError);
  });

  test('cause 支持 - throwError 携带原始错误', () => {
    const originalError = new Error('原始错误');
    const fn = () => throwError('test', 'test', { cause: originalError });
    expect(fn).toThrow(Error);
    expect(fn).toThrow(expect.objectContaining({ cause: originalError }));
  });

  test('cause 支持 - throwError 携带原始错误 + 自定义类型', () => {
    const originalError = new Error('原始错误');
    const fn = () => throwError('test', 'test', RangeError, { cause: originalError });
    expect(fn).toThrow(RangeError);
    expect(fn).toThrow(expect.objectContaining({ cause: originalError }));
  });

  test('cause 支持 - throwType 携带原始错误', () => {
    const originalError = new Error('原始错误');
    const fn = () => throwType('test', 'test', { cause: originalError });
    expect(fn).toThrow(TypeError);
    expect(fn).toThrow(expect.objectContaining({ cause: originalError }));
  });

  test('cause 支持 - 非 Error 类型的 cause', () => {
    const error = createError('test', 'test', { cause: 'string reason' });
    expect(error.cause).toBe('string reason');

    const error2 = createError('test', 'test', { cause: { code: 500, msg: 'internal' } });
    expect(error2.cause).toEqual({ code: 500, msg: 'internal' });
  });

  test('cause 支持 - 未传 cause 时 error.cause 为 undefined', () => {
    const error = createError('test', 'test');
    expect(error.cause).toBeUndefined();
  });
});
