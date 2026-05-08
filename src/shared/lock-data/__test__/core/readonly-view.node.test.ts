/**
 * core/readonly-view 单元测试（wrapper Proxy 方案）
 *
 * 设计契约：
 * 1. createReadonlyView 接受 dataRef: { current: T }，wrapper Proxy 永远代理 dataRef
 *    自身（target 稳定），所有 trap 转发到 dataRef.current —— 用户对 view 的属性读取
 *    始终命中"最新版本"的 current
 * 2. JSON-only 契约：仅支持 plain object / array / 原始值；不再特殊处理 Set / Map / Date
 *    （这些类型在入口 assertJsonSafe 已被 fail-fast 拦截）
 * 3. 深只读：嵌套对象首次访问时被包裹为子 Proxy；同一嵌套对象多次访问返回同一子 Proxy（缓存）
 * 4. 写入 / 删除 / defineProperty 全部抛 ReadonlyMutationError
 */

import { describe, expect, test } from 'vitest';
import { createReadonlyView, type DataRef } from '@/shared/lock-data/core/readonly-view';
import { ReadonlyMutationError } from '@/shared/lock-data/errors';

function makeRef<T extends object>(current: T): DataRef<T> {
  return { current };
}

describe('createReadonlyView / 读取契约', () => {
  test('读取浅层属性与 dataRef.current 一致', () => {
    const view = createReadonlyView(makeRef({ name: 'cmt', age: 18 }));
    expect(view.name).toBe('cmt');
    expect(view.age).toBe(18);
  });

  test('dataRef.current 整体替换后，view 读到新值（wrapper 永不失效）', () => {
    const dataRef = makeRef({ count: 0 });
    const view = createReadonlyView(dataRef);
    expect(view.count).toBe(0);
    dataRef.current = { count: 42 };
    expect(view.count).toBe(42);
  });

  test('原地修改 dataRef.current 内部字段后，view 读到最新值', () => {
    const dataRef = makeRef({ count: 0 });
    const view = createReadonlyView(dataRef);
    expect(view.count).toBe(0);
    dataRef.current.count = 99;
    expect(view.count).toBe(99);
  });
});

describe('createReadonlyView / 深只读', () => {
  test('写入根层属性抛 ReadonlyMutationError', () => {
    const view = createReadonlyView(makeRef({ name: 'cmt' }));
    expect(() => {
      view.name = 'x';
    }).toThrow(ReadonlyMutationError);
  });

  test('写入嵌套层属性同样抛错', () => {
    const view = createReadonlyView(makeRef({ profile: { age: 18 } }));
    expect(() => {
      view.profile.age = 19;
    }).toThrow(ReadonlyMutationError);
  });

  test('删除属性抛错', () => {
    const view = createReadonlyView(makeRef<{ name?: string }>({ name: 'cmt' }));
    expect(() => {
      // biome-ignore lint/performance/noDelete: 测试 readonly-view 的 deleteProperty trap 必须用 delete 操作符
      delete view.name;
    }).toThrow(ReadonlyMutationError);
  });

  test('defineProperty 被拦截', () => {
    const view = createReadonlyView(makeRef<Record<string, number>>({}));
    expect(() => Object.defineProperty(view, 'x', { value: 1 })).toThrow(ReadonlyMutationError);
  });

  test('数组元素的深只读', () => {
    const view = createReadonlyView(makeRef({ list: [{ id: 1 }] }));
    expect(() => {
      view.list[0].id = 2;
    }).toThrow(ReadonlyMutationError);
    expect(() => {
      view.list.push({ id: 2 });
    }).toThrow(ReadonlyMutationError);
  });

  test('错误消息前缀包含 lockData 命名空间', () => {
    const view = createReadonlyView(makeRef({ a: 1 }));
    expect(() => {
      view.a = 2;
    }).toThrow(/\[@cmtlyt\/lingshu-toolkit#lockData\]: cannot mutate readonly view/u);
  });
});

describe('createReadonlyView / 嵌套代理缓存', () => {
  test('同一嵌套对象多次访问返回同一子代理（引用稳定）', () => {
    const view = createReadonlyView(makeRef({ nested: { value: 1 } }));
    expect(view.nested).toBe(view.nested);
  });

  test('非对象属性直接返回原值（不被包裹）', () => {
    const view = createReadonlyView(makeRef({ value: 1, flag: true, name: 'cmt' }));
    expect(view.value).toBe(1);
    expect(view.flag).toBe(true);
    expect(view.name).toBe('cmt');
  });
});
