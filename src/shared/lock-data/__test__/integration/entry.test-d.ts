import { describe, expectTypeOf, test } from 'vitest';
import type { LockDataTuple, ReadonlyView } from '../../index';
import { lockData } from '../../index';

/**
 * lockData 集成层类型契约（仅做编译期类型断言，与 runtime 行为对应的测试在 entry.node.test.ts）
 *
 * 单签名 + 条件类型 LockDataReturn<T, O> 自动推断（决策 #33 §A），覆盖 entry.ts 三条初始化路径：
 * - 路径 A：同步 getValue → 精确 `LockDataTuple<T>`（不含 Promise 分支）
 * - 路径 B：异步 getValue → 精确 `Promise<LockDataTuple<T>>`（不含同步元组分支）
 * - 路径 C：`syncMode='storage-authority' + id` → 精确 `Promise<LockDataTuple<T>>`（即使 getValue 同步也强制走异步）
 *
 * 同时覆盖 ReadonlyView<T> 的深递归 readonly 与函数类型透传契约（RFC §readonly view）
 */

interface Counter {
  readonly count: number;
}

describe('lockData / 同步 getValue 路径（条件类型推断）', () => {
  test('同步 getValue：返回值精确为 LockDataTuple<Counter>，不含 Promise 分支', () => {
    const result = lockData({
      getValue: (): Counter => {
        return { count: 0 };
      },
    });
    expectTypeOf(result).toEqualTypeOf<LockDataTuple<Counter>>();
  });
});

describe('lockData / 异步 getValue 路径（条件类型推断）', () => {
  test('异步 getValue：返回值精确为 Promise<LockDataTuple<Counter>>，不含同步元组分支', () => {
    const result = lockData({
      getValue: (): Promise<Counter> => Promise.resolve({ count: 0 }),
    });
    expectTypeOf(result).toEqualTypeOf<Promise<LockDataTuple<Counter>>>();
  });
});

describe("lockData / syncMode='storage-authority' 异步路径", () => {
  test("syncMode='storage-authority' + id：返回值精确为 Promise<LockDataTuple<Counter>>（即使 getValue 同步也强制走异步）", () => {
    const result = lockData({
      getValue: (): Counter => {
        return { count: 7 };
      },
      id: 'integration-c',
      syncMode: 'storage-authority',
    });
    expectTypeOf(result).toEqualTypeOf<Promise<LockDataTuple<Counter>>>();
  });
});

describe('ReadonlyView<T> 深递归 readonly 契约', () => {
  test('view 的属性被标记为 readonly', () => {
    expectTypeOf<ReadonlyView<Counter>>().toEqualTypeOf<{ readonly count: number }>();
  });

  test('嵌套对象同样递归 readonly', () => {
    interface Nested {
      readonly outer: { readonly inner: number };
    }
    expectTypeOf<ReadonlyView<{ outer: { inner: number } }>>().toEqualTypeOf<Nested>();
  });

  test('函数类型透传不递归加 readonly', () => {
    type FnType = (x: number) => string;
    expectTypeOf<ReadonlyView<FnType>>().toEqualTypeOf<FnType>();
  });
});
