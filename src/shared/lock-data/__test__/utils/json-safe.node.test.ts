/**
 * utils/json-safe.ts 单元测试
 *
 * 该模块导出 4 个工具：assertJsonSafe / assertJsonSafeInput / assertNotTopLevelArray / cloneByJson；
 * 在 lock-data 入口（getValue / actions.replace / draft）会被层层调用。
 *
 * 现有 draft-json-only.node.test.ts 覆盖了 assertJsonSafe 的「draft」语境，但 utils/json-safe 自身
 * 的 formatPath / describeNonJsonValue / 顶层数组判定 / cloneByJson 等独立路径需要直接覆盖。
 */

import { describe, expect, test } from 'vitest';
import { InvalidOptionsError } from '@/shared/lock-data/errors';
import {
  assertJsonSafe,
  assertJsonSafeInput,
  assertNotTopLevelArray,
  cloneByJson,
} from '@/shared/lock-data/utils/json-safe';

describe('utils/json-safe — assertNotTopLevelArray', () => {
  test('普通对象不抛错', () => {
    expect(() => assertNotTopLevelArray({ x: 1 }, 'getValue() result')).not.toThrow();
  });

  test('null / undefined / 原始值不抛错（assertNotTopLevelArray 仅判定数组）', () => {
    expect(() => assertNotTopLevelArray(null, 'subject')).not.toThrow();
    expect(() => assertNotTopLevelArray(undefined, 'subject')).not.toThrow();
    expect(() => assertNotTopLevelArray('str', 'subject')).not.toThrow();
    expect(() => assertNotTopLevelArray(42, 'subject')).not.toThrow();
  });

  test('顶层数组抛 InvalidOptionsError，错误信息包含 subject 与提示', () => {
    expect(() => assertNotTopLevelArray([1, 2, 3], 'getValue() result')).toThrow(InvalidOptionsError);
    expect(() => assertNotTopLevelArray([1, 2, 3], 'getValue() result')).toThrow(
      /getValue\(\) result must not return an array/u,
    );
    expect(() => assertNotTopLevelArray([], 'replace input')).toThrow(/replace input must not return an array/u);
  });
});

describe('utils/json-safe — assertJsonSafe', () => {
  test('合法值（plain object / array / 原始值）不抛错', () => {
    expect(() =>
      assertJsonSafe({ a: 1, b: 'str', c: true, d: null, e: [1, 2] }, [], new WeakSet(), 'subject'),
    ).not.toThrow();
  });

  test('Object.create(null) 视为合法 plain object', () => {
    const obj = Object.create(null);
    obj.x = 1;
    expect(() => assertJsonSafe(obj, [], new WeakSet(), 'subject')).not.toThrow();
  });

  test('undefined 抛错并提示 use null instead', () => {
    expect(() => assertJsonSafe({ x: undefined }, [], new WeakSet(), 'subject')).toThrow(
      /undefined.*at "x".*use "null" instead/u,
    );
  });

  test('NaN / Infinity / -Infinity 抛错并描述具体值', () => {
    expect(() => assertJsonSafe({ x: Number.NaN }, [], new WeakSet(), 'subject')).toThrow(/NaN.*at "x"/u);
    expect(() => assertJsonSafe({ x: Number.POSITIVE_INFINITY }, [], new WeakSet(), 'subject')).toThrow(
      /Infinity.*at "x"/u,
    );
    expect(() => assertJsonSafe({ x: Number.NEGATIVE_INFINITY }, [], new WeakSet(), 'subject')).toThrow(
      /-Infinity.*at "x"/u,
    );
  });

  test('bigint / symbol / function 抛错并描述类型', () => {
    expect(() => assertJsonSafe({ x: 10n }, [], new WeakSet(), 'subject')).toThrow(/bigint.*at "x"/u);
    expect(() => assertJsonSafe({ x: Symbol('s') }, [], new WeakSet(), 'subject')).toThrow(/symbol.*at "x"/u);
    expect(() => assertJsonSafe({ x: () => 1 }, [], new WeakSet(), 'subject')).toThrow(/function.*at "x"/u);
  });

  test('Set / Map / Date / RegExp 抛错并描述 toString tag', () => {
    expect(() => assertJsonSafe({ x: new Set() }, [], new WeakSet(), 'subject')).toThrow(/Set.*at "x"/u);
    expect(() => assertJsonSafe({ x: new Map() }, [], new WeakSet(), 'subject')).toThrow(/Map.*at "x"/u);
    expect(() => assertJsonSafe({ x: new Date() }, [], new WeakSet(), 'subject')).toThrow(/Date.*at "x"/u);
    expect(() => assertJsonSafe({ x: /foo/u }, [], new WeakSet(), 'subject')).toThrow(/RegExp.*at "x"/u);
  });

  test('class 实例抛错并描述 class 名', () => {
    class FooBar {
      v = 1;
    }
    expect(() => assertJsonSafe({ x: new FooBar() }, [], new WeakSet(), 'subject')).toThrow(
      /class instance \(FooBar\).*at "x"/u,
    );
  });

  test('subject 参数被嵌入到错误信息（用于区分 getValue / replace / draft）', () => {
    expect(() => assertJsonSafe({ x: undefined }, [], new WeakSet(), 'getValue() result')).toThrow(
      /getValue\(\) result only supports JSON-safe values/u,
    );
    expect(() => assertJsonSafe({ x: undefined }, [], new WeakSet(), 'actions.replace(next)')).toThrow(
      /actions\.replace\(next\) only supports JSON-safe values/u,
    );
  });

  test('顶层非法值的错误路径形式为 <root>', () => {
    expect(() => assertJsonSafe(undefined, [], new WeakSet(), 'subject')).toThrow(/at "<root>"/u);
    expect(() => assertJsonSafe(10n, [], new WeakSet(), 'subject')).toThrow(/at "<root>"/u);
  });

  test('数组路径 + 嵌套对象路径在错误信息中正确拼接', () => {
    expect(() => assertJsonSafe({ list: [1, { y: undefined }] }, [], new WeakSet(), 'subject')).toThrow(
      /at "list\[1\]\.y"/u,
    );
  });

  test('循环引用抛错并指明位置', () => {
    interface Cyclic {
      name: string;
      self?: Cyclic;
    }
    const obj: Cyclic = { name: 'x' };
    obj.self = obj;
    expect(() => assertJsonSafe(obj, [], new WeakSet(), 'subject')).toThrow(/cyclic reference at "self"/u);
  });

  test('数组自循环抛错', () => {
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => assertJsonSafe({ list: arr }, [], new WeakSet(), 'subject')).toThrow(/cyclic reference/u);
  });

  test('symbol 键对象抛错并指明位置', () => {
    const sym = Symbol('forbidden');
    const target = { user: { [sym]: 1 } };
    expect(() => assertJsonSafe(target, [], new WeakSet(), 'subject')).toThrow(/symbol-keyed property.*at "user"/u);
  });

  test('同一引用出现在两个兄弟节点不被误判为环', () => {
    const shared = { x: 1 };
    expect(() => assertJsonSafe({ a: shared, b: shared }, [], new WeakSet(), 'subject')).not.toThrow();
  });

  test('null 值的快路径早退（assertJsonSafe 入口 if value === null）', () => {
    expect(() => assertJsonSafe(null, [], new WeakSet(), 'subject')).not.toThrow();
  });
});

describe('utils/json-safe — assertJsonSafeInput（组合入口）', () => {
  test('合法对象通过', () => {
    expect(() => assertJsonSafeInput({ a: 1, b: [1, 2, { c: 'x' }] }, 'getValue() result')).not.toThrow();
  });

  test('顶层数组先被 assertNotTopLevelArray 拒绝（InvalidOptionsError）', () => {
    expect(() => assertJsonSafeInput([1, 2], 'getValue() result')).toThrow(InvalidOptionsError);
  });

  test('对象内含非 JSON-safe 值后续被 assertJsonSafe 拒绝（TypeError）', () => {
    expect(() => assertJsonSafeInput({ x: new Map() }, 'getValue() result')).toThrow(TypeError);
  });
});

describe('utils/json-safe — cloneByJson', () => {
  test('深拷贝得到新引用', () => {
    const src = { a: { b: { c: 1 } }, list: [1, 2, 3] };
    const cloned = cloneByJson(src);
    expect(cloned).toEqual(src);
    expect(cloned).not.toBe(src);
    expect(cloned.a).not.toBe(src.a);
    expect(cloned.list).not.toBe(src.list);
  });

  test('修改 cloned 不影响原值', () => {
    const src = { x: 1, list: [1] };
    const cloned = cloneByJson(src);
    cloned.x = 99;
    cloned.list.push(2);
    expect(src.x).toBe(1);
    expect(src.list).toEqual([1]);
  });

  test('原始值直接返回相等值', () => {
    expect(cloneByJson(42)).toBe(42);
    expect(cloneByJson('str')).toBe('str');
    expect(cloneByJson(null)).toBe(null);
    expect(cloneByJson(true)).toBe(true);
  });
});
