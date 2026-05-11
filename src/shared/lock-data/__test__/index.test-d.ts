import { describe, expectTypeOf, test } from 'vitest';
import { lockData } from '../index';
import type { LockDataTuple, ReadonlyView } from '../types';

/**
 * lockData 主入口类型契约（仅做编译期类型断言，与 runtime 行为对应的测试在 index.test.ts）
 *
 * 单签名 + 条件类型 LockDataReturn<T, O> 自动推断（决策 #33 §A）：
 * - 路径 A：同步 getValue 返回非 Promise → 精确 `LockDataTuple<T>`（不含 Promise 分支）
 * - 路径 B：异步 getValue 返回 Promise → 精确 `Promise<LockDataTuple<T>>`（不含同步元组分支）
 * - 路径 C：`syncMode='storage-authority' + id` → 精确 `Promise<LockDataTuple<T>>`（authority 协调强制异步）
 * - 路径 D：`syncMode='storage-authority'` 缺 id → `never`（编译期 fail-fast）
 */

interface Counter {
  count: number;
}

describe('lockData / 同步 getValue 路径（条件类型推断）', () => {
  test('同步 getValue：返回值精确为 LockDataTuple<T>，不含 Promise 分支', () => {
    const result = lockData({
      getValue: (): Counter => {
        return { count: 0 };
      },
    });
    expectTypeOf(result).toEqualTypeOf<LockDataTuple<Counter>>();
  });
});

describe('lockData / 异步 getValue 路径（条件类型推断）', () => {
  test('异步 getValue：返回值精确为 Promise<LockDataTuple<T>>，不含同步元组分支', () => {
    const result = lockData({
      getValue: (): Promise<Counter> => Promise.resolve({ count: 42 }),
    });
    expectTypeOf(result).toEqualTypeOf<Promise<LockDataTuple<Counter>>>();
  });
});

describe("lockData / syncMode='storage-authority' 类型层强制 id", () => {
  test("syncMode='storage-authority' + id：返回值精确为 Promise<LockDataTuple<T>>", () => {
    type ReturnWithId = ReturnType<
      typeof lockData<{
        id: 'fixed-id';
        syncMode: 'storage-authority';
        getValue: () => Counter;
      }>
    >;
    expectTypeOf<ReturnWithId>().toEqualTypeOf<Promise<LockDataTuple<Counter>>>();
  });

  test("syncMode='storage-authority' 缺 id：编译期推为 never（fail-fast）", () => {
    type ReturnWithoutId = ReturnType<
      typeof lockData<{
        syncMode: 'storage-authority';
        getValue: () => Counter;
      }>
    >;
    expectTypeOf<ReturnWithoutId>().toEqualTypeOf<never>();
  });
});

describe('ReadonlyView<T> 类型契约', () => {
  test('属性被标记为 readonly', () => {
    expectTypeOf<ReadonlyView<Counter>>().toEqualTypeOf<{ readonly count: number }>();
  });
});
