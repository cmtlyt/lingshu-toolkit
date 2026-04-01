import { describe, expect, test } from 'vitest';
import {
  isArray,
  isBoolean,
  isEmptyArray,
  isEmptyString,
  isFalse,
  isFalsy,
  isFunction,
  isNaN,
  isNull,
  isNullOrUndef,
  isNumber,
  isObject,
  isPlainNumber,
  isPlainObject,
  isPlainSymbol,
  isPromise,
  isPropertyKey,
  isString,
  isSymbol,
  isTrue,
  isTruthy,
  isUndef,
} from '../verify';

describe('utils-verify', () => {
  test('导出检查', () => {
    expect(isPromise).toBeTypeOf('function');
    expect(isObject).toBeTypeOf('function');
    expect(isArray).toBeTypeOf('function');
    expect(isEmptyArray).toBeTypeOf('function');
    expect(isSymbol).toBeTypeOf('function');
    expect(isPlainObject).toBeTypeOf('function');
    expect(isPropertyKey).toBeTypeOf('function');
    expect(isNaN).toBeTypeOf('function');
    expect(isNull).toBeTypeOf('function');
    expect(isNullOrUndef).toBeTypeOf('function');
    expect(isNumber).toBeTypeOf('function');
    expect(isPlainNumber).toBeTypeOf('function');
    expect(isPlainSymbol).toBeTypeOf('function');
    expect(isString).toBeTypeOf('function');
    expect(isEmptyString).toBeTypeOf('function');
    expect(isUndef).toBeTypeOf('function');
    expect(isTrue).toBeTypeOf('function');
    expect(isFalse).toBeTypeOf('function');
    expect(isBoolean).toBeTypeOf('function');
    expect(isFalsy).toBeTypeOf('function');
    expect(isTruthy).toBeTypeOf('function');
    expect(isFunction).toBeTypeOf('function');
  });

  test('isPromise', () => {
    expect(isPromise(Promise.resolve())).toBe(true);
    expect(isPromise(1)).toBe(false);
    expect(isPromise(Promise.reject().catch(() => {}))).toBe(true);
    expect(isPromise('1')).toBe(false);
    expect(isPromise(Symbol('test'))).toBe(false);
    expect(isPromise({})).toBe(false);
    expect(isPromise([])).toBe(false);
    expect(isPromise(new Promise(() => {}))).toBe(true);
    // biome-ignore lint/suspicious/noThenProperty: test
    expect(isPromise({ then: () => {} })).toBe(true);
  });

  test('isFunction', () => {
    expect(isFunction(() => {})).toBe(true);
    expect(isFunction(1)).toBe(false);
    expect(isFunction('1')).toBe(false);
    expect(isFunction(Symbol('test'))).toBe(false);
    expect(isFunction({})).toBe(false);
    expect(isFunction([])).toBe(false);
  });

  test('isTruthy', () => {
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy(false)).toBe(false);
    expect(isTruthy('true')).toBe(true);
    expect(isTruthy('True')).toBe(true);
    expect(isTruthy('tRuE')).toBe(true);
    expect(isTruthy('false')).toBe(true);
    expect(isTruthy('False')).toBe(true);
    expect(isTruthy('fAlSE')).toBe(true);
    expect(isTruthy('')).toBe(false);
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy(1)).toBe(true);
    expect(isTruthy(null)).toBe(false);
    expect(isTruthy(undefined)).toBe(false);
    expect(isTruthy(Symbol('test'))).toBe(true);
    expect(isTruthy({})).toBe(true);
    expect(isTruthy([])).toBe(true);
  });

  test('isTrue', () => {
    expect(isTrue(true)).toBe(true);
    expect(isTrue(false)).toBe(false);
    expect(isTrue('true')).toBe(true);
    expect(isTrue('True')).toBe(true);
    expect(isTrue('tRuE')).toBe(true);
    expect(isTrue('false')).toBe(false);
    expect(isTrue('False')).toBe(false);
    expect(isTrue('fAlSE')).toBe(false);
    expect(isTrue('')).toBe(false);
    expect(isTrue(0)).toBe(false);
    expect(isTrue(1)).toBe(false);
    expect(isTrue(null)).toBe(false);
    expect(isTrue(undefined)).toBe(false);
    expect(isTrue(Symbol('test'))).toBe(false);
    expect(isTrue({})).toBe(false);
    expect(isTrue([])).toBe(false);
  });

  test('isFalse', () => {
    expect(isFalse(true)).toBe(false);
    expect(isFalse(false)).toBe(true);
    expect(isFalse('true')).toBe(false);
    expect(isFalse('True')).toBe(false);
    expect(isFalse('tRuE')).toBe(false);
    expect(isFalse('false')).toBe(true);
    expect(isFalse('False')).toBe(true);
    expect(isFalse('fAlSE')).toBe(true);
    expect(isFalse('')).toBe(false);
    expect(isFalse(0)).toBe(false);
    expect(isFalse(1)).toBe(false);
    expect(isFalse(null)).toBe(false);
    expect(isFalse(undefined)).toBe(false);
    expect(isFalse(Symbol('test'))).toBe(false);
    expect(isFalse({})).toBe(false);
    expect(isFalse([])).toBe(false);
  });

  test('isBoolean', () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean('true')).toBe(false);
    expect(isBoolean('True')).toBe(false);
    expect(isBoolean('tRuE')).toBe(false);
    expect(isBoolean('false')).toBe(false);
    expect(isBoolean('False')).toBe(false);
    expect(isBoolean('fAlSE')).toBe(false);
    expect(isBoolean('')).toBe(false);
    expect(isBoolean(0)).toBe(false);
    expect(isBoolean(1)).toBe(false);
    expect(isBoolean(null)).toBe(false);
    expect(isBoolean(undefined)).toBe(false);
    expect(isBoolean(Symbol('test'))).toBe(false);
    expect(isBoolean({})).toBe(false);
    expect(isBoolean([])).toBe(false);
  });

  test('isFalsy', () => {
    expect(isFalsy(true)).toBe(false);
    expect(isFalsy(false)).toBe(true);
    expect(isFalsy('true')).toBe(false);
    expect(isFalsy('True')).toBe(false);
    expect(isFalsy('tRuE')).toBe(false);
    expect(isFalsy('false')).toBe(false);
    expect(isFalsy('False')).toBe(false);
    expect(isFalsy('fAlSE')).toBe(false);
    expect(isFalsy('')).toBe(true);
    expect(isFalsy(0)).toBe(true);
    expect(isFalsy(1)).toBe(false);
    expect(isFalsy(null)).toBe(true);
    expect(isFalsy(undefined)).toBe(true);
    expect(isFalsy(Symbol('test'))).toBe(false);
    expect(isFalsy({})).toBe(false);
    expect(isFalsy([])).toBe(false);
  });

  describe('基本使用', () => {
    test('isUndef', () => {
      expect(isUndef(undefined)).toBe(true);
      expect(isUndef(null)).toBe(false);
      expect(isUndef(1)).toBe(false);
      expect(isUndef('1')).toBe(false);
      expect(isUndef(Symbol('test'))).toBe(false);
      expect(isUndef({})).toBe(false);
      expect(isUndef([])).toBe(false);
    });

    test('isNull', () => {
      expect(isNull(null)).toBe(true);
      expect(isNull(undefined)).toBe(false);
      expect(isNull(1)).toBe(false);
      expect(isNull('1')).toBe(false);
      expect(isNull(Symbol('test'))).toBe(false);
      expect(isNull({})).toBe(false);
      expect(isNull([])).toBe(false);
    });

    test('isNullOrUndef', () => {
      expect(isNullOrUndef(undefined)).toBe(true);
      expect(isNullOrUndef(null)).toBe(true);
      expect(isNullOrUndef(1)).toBe(false);
      expect(isNullOrUndef('1')).toBe(false);
      expect(isNullOrUndef(Symbol('test'))).toBe(false);
      expect(isNullOrUndef({})).toBe(false);
      expect(isNullOrUndef([])).toBe(false);
    });

    test('isNumber', () => {
      expect(isNumber(1)).toBe(true);
      expect(isNumber(Number.NaN)).toBe(true);
      expect(isNumber('1')).toBe(false);
      expect(isNumber(Symbol('test'))).toBe(false);
      expect(isNumber({})).toBe(false);
      expect(isNumber([])).toBe(false);
      expect(isNumber(null)).toBe(false);
      expect(isNumber(undefined)).toBe(false);
    });

    test('isPlainNumber', () => {
      expect(isPlainNumber(1)).toBe(true);
      expect(isPlainNumber(Number.NaN)).toBe(false);
      expect(isPlainNumber('1')).toBe(false);
      expect(isPlainNumber(Symbol('test'))).toBe(false);
      expect(isPlainNumber({})).toBe(false);
      expect(isPlainNumber([])).toBe(false);
      expect(isPlainNumber(null)).toBe(false);
      expect(isPlainNumber(undefined)).toBe(false);
    });

    test('isNaN', () => {
      expect(isNaN(1)).toBe(false);
      expect(isNaN(Number.NaN)).toBe(true);
      expect(isNaN('1')).toBe(false);
      expect(isNaN(Symbol('test'))).toBe(false);
      expect(isNaN({})).toBe(false);
      expect(isNaN([])).toBe(false);
      expect(isNaN(null)).toBe(false);
      expect(isNaN(undefined)).toBe(false);
    });

    test('isString', () => {
      expect(isString('1')).toBe(true);
      expect(isString(1)).toBe(false);
      expect(isString(Symbol('test'))).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString([])).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
    });

    test('isEmptyString', () => {
      expect(isEmptyString('')).toBe(true);
      expect(isEmptyString('not empty')).toBe(false);
      expect(isEmptyString(1)).toBe(false);
      expect(isEmptyString(Symbol('test'))).toBe(false);
      expect(isEmptyString({})).toBe(false);
      expect(isEmptyString([])).toBe(false);
      expect(isEmptyString(null)).toBe(false);
      expect(isEmptyString(undefined)).toBe(false);
    });

    test('isPlainSymbol', () => {
      expect(isPlainSymbol(Symbol('test'))).toBe(true);
      expect(isPlainSymbol(Symbol.for('test'))).toBe(false);
      expect(isPlainSymbol({})).toBe(false);
      expect(isPlainSymbol([])).toBe(false);
      expect(isPlainSymbol(1)).toBe(false);
      expect(isPlainSymbol('1')).toBe(false);
      expect(isPlainSymbol(null)).toBe(false);
      expect(isPlainSymbol(undefined)).toBe(false);
    });

    test('isObject', () => {
      expect(isObject(Symbol('test'))).toBe(false);
      expect(isObject(Symbol.for('test'))).toBe(false);
      expect(isObject({})).toBe(true);
      expect(isObject([])).toBe(true);
      expect(isObject(1)).toBe(false);
      expect(isObject('1')).toBe(false);
      expect(isObject(null)).toBe(false);
      expect(isObject(undefined)).toBe(false);
    });

    test('isPlainObject', () => {
      expect(isPlainObject(Symbol('test'))).toBe(false);
      expect(isPlainObject(Symbol.for('test'))).toBe(false);
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(1)).toBe(false);
      expect(isPlainObject('1')).toBe(false);
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
    });

    test('isArray', () => {
      expect(isArray(Symbol('test'))).toBe(false);
      expect(isArray(Symbol.for('test'))).toBe(false);
      expect(isArray({})).toBe(false);
      expect(isArray([])).toBe(true);
      expect(isArray(1)).toBe(false);
      expect(isArray('1')).toBe(false);
      expect(isArray(null)).toBe(false);
      expect(isArray(undefined)).toBe(false);
    });

    test('isEmptyArray', () => {
      expect(isEmptyArray([])).toBe(true);
      expect(isEmptyArray([1])).toBe(false);
      expect(isEmptyArray(['a', 'b', 'c'])).toBe(false);
      expect(isEmptyArray(null)).toBe(false);
      expect(isEmptyArray(undefined)).toBe(false);
      expect(isEmptyArray('not array')).toBe(false);
      expect(isEmptyArray(123)).toBe(false);
      expect(isEmptyArray({ length: 1 })).toBe(false);
      expect(isEmptyArray({})).toBe(false);
    });

    test('isSymbol', () => {
      expect(isSymbol(Symbol('test'))).toBe(true);
      expect(isSymbol(Symbol.for('test'))).toBe(true);
      expect(isSymbol({})).toBe(false);
      expect(isSymbol([])).toBe(false);
      expect(isSymbol(1)).toBe(false);
      expect(isSymbol('1')).toBe(false);
      expect(isSymbol(null)).toBe(false);
      expect(isSymbol(undefined)).toBe(false);
    });

    test('isPropertyKey', () => {
      expect(isPropertyKey(Symbol('test'))).toBe(true);
      expect(isPropertyKey(Symbol.for('test'))).toBe(true);
      expect(isPropertyKey({})).toBe(false);
      expect(isPropertyKey([])).toBe(false);
      expect(isPropertyKey(1)).toBe(true);
      expect(isPropertyKey('1')).toBe(true);
      expect(isPropertyKey(null)).toBe(false);
      expect(isPropertyKey(undefined)).toBe(false);
    });
  });
});
