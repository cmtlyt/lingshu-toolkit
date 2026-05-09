/**
 * utils/json-safe.ts `describeNonJsonValue` 内部分支专项覆盖
 *
 * 通过 `assertJsonSafe` / `assertJsonSafeInput` 公共入口调用 `describeNonJsonValue` 时：
 *   - undefined：assertJsonSafe 入口已对 undefined 早抛 TypeError，进不到本函数
 *   - null：assertJsonSafe 入口已对 null 早返回，进不到本函数
 *   - 匿名 ctor 对象：极端组合（toString tag === 'Object' 且 ctor.name 为空字符串）
 *
 * 三处分支因此在公共路径下不可达。但 `describeNonJsonValue` 作为独立工具函数应当
 * 自洽地处理这些值。测试通过直接 import（仅文件内 named export，未在 lock-data/index.ts
 * 暴露）调用，并核对返回值字符串。
 */

import { describe, expect, test } from 'vitest';
import { describeNonJsonValue } from '@/shared/lock-data/utils/json-safe';

describe('describeNonJsonValue / 公共路径下不可达的兜底分支', () => {
  test('undefined → "undefined"（assertJsonSafe 入口已早抛，本兜底保证函数自洽）', () => {
    expect(describeNonJsonValue(undefined)).toBe('undefined');
  });

  test('null → "null"（assertJsonSafe 入口已早返回，本兜底保证函数自洽）', () => {
    expect(describeNonJsonValue(null)).toBe('null');
  });

  test('toString tag=Object 且匿名 ctor → "non-plain object"', () => {
    // 构造极端组合：
    //   1) tag === 'Object'：默认对象 [[Prototype]] 为 Object.prototype 即可满足
    //   2) ctor 存在且 !== Object 且 typeof ctor.name === 'string' 但 length === 0
    // 这要求把 constructor 改写为一个具名为 '' 的函数对象
    const anonymousCtor = (() => {}) as unknown as { name: string };
    Object.defineProperty(anonymousCtor, 'name', { value: '', configurable: true });

    const value = {};
    Object.defineProperty(value, 'constructor', { value: anonymousCtor, configurable: true });

    // 双重确认：tag 仍为 Object（未通过 Symbol.toStringTag 改写）
    expect(Object.prototype.toString.call(value).slice(8, -1)).toBe('Object');
    // 命中最后一行兜底
    expect(describeNonJsonValue(value)).toBe('non-plain object');
  });
});

// ---------------------------------------------------------------------------
// 透传断言：保证已覆盖的常规分支仍按既有契约工作（防回归）
// ---------------------------------------------------------------------------

describe('describeNonJsonValue / 常规分支回归（防止改动误伤）', () => {
  test('NaN / Infinity / -Infinity 命中数字异常分支', () => {
    expect(describeNonJsonValue(Number.NaN)).toBe('NaN');
    expect(describeNonJsonValue(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(describeNonJsonValue(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  test('有限数字命中 isFinite=true 的 false 分支 → 走 primitive type 兜底返回 "number"', () => {
    // 公共路径下 assertJsonSafe 不会把合法有限数字传到 describeNonJsonValue（命中前已 early return）；
    // 此处仅测试 describeNonJsonValue 自洽性：当输入是有限数字时，应跳过 isFinite=false 分支
    // 走到 primitive type 兜底，返回 typeof value 即 "number"
    expect(describeNonJsonValue(42)).toBe('number');
    expect(describeNonJsonValue(0)).toBe('number');
    expect(describeNonJsonValue(-3.14)).toBe('number');
  });

  test('bigint / symbol / function 命中 primitive type 分支', () => {
    expect(describeNonJsonValue(1n)).toBe('bigint');
    expect(describeNonJsonValue(Symbol('x'))).toBe('symbol');
    expect(describeNonJsonValue(() => {})).toBe('function');
  });

  test('Map / Set / Date 命中 toString tag !== Object 分支', () => {
    expect(describeNonJsonValue(new Map())).toBe('Map');
    expect(describeNonJsonValue(new Set())).toBe('Set');
    expect(describeNonJsonValue(new Date())).toBe('Date');
  });

  test('class 实例命中具名 ctor 分支', () => {
    class Foo {}
    expect(describeNonJsonValue(new Foo())).toBe('class instance (Foo)');
  });
});
