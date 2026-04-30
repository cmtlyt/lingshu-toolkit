import { describe, expect, expectTypeOf, test } from 'vitest';
import type { LockDataActions, LockDataTuple, ReadonlyView } from '../../index';
import { lockData } from '../../index';

/**
 * lockData 三重载集成契约测试（RFC L112-155）
 *
 * 三条初始化路径：
 * - 分支 A：同步初始化（无 getValue 且 syncMode 为 'none' / undefined）→ `LockDataTuple<T>`
 * - 分支 B：异步初始化（getValue 返回 Promise）→ `Promise<LockDataTuple<T>>`
 * - 分支 C：异步初始化（syncMode='storage-authority' 且 id 存在，首次拉本地权威副本）
 *   → `Promise<LockDataTuple<T>>`
 *
 * Node 环境下：syncMode='storage-authority' 在没有 localStorage 时会自动 fallback
 * 到内存权威（见 entry.ts L209 的 warn log），异步入口契约保持不变
 */

interface Counter {
  readonly count: number;
}

describe('lockData 三重载 / 分支 A（同步初始化）', () => {
  test('无 options：返回值非 Promise，元组结构正确', async () => {
    const result = lockData<Counter>({ count: 0 });
    // 分支 A 契约：同步返回，不应是 Promise
    expect(result).not.toBeInstanceOf(Promise);

    const [view, actions] = result;
    expect(view.count).toBe(0);
    expect(actions.update).toBeTypeOf('function');

    await actions.dispose();
  });

  test("显式 syncMode='none'：仍走同步路径", async () => {
    const result = lockData<Counter>({ count: 10 }, { syncMode: 'none' });
    expect(result).not.toBeInstanceOf(Promise);

    const [view, actions] = result;
    expect(view.count).toBe(10);

    await actions.dispose();
  });

  test('类型层：推断为 LockDataTuple<T>（非 Promise）', () => {
    const result = lockData<Counter>({ count: 0 });
    expectTypeOf(result).toEqualTypeOf<LockDataTuple<Counter>>();
    expectTypeOf(result).not.toMatchTypeOf<Promise<unknown>>();

    // 元组第二项必须是 LockDataActions<Counter>
    const [, actions] = result;
    expectTypeOf(actions).toEqualTypeOf<LockDataActions<Counter>>();

    // 清理：编译期契约不需要运行时 dispose，但避免 entry 泄漏
    void actions.dispose();
  });
});

describe('lockData 三重载 / 分支 B（异步 getValue）', () => {
  test('getValue 返回 Promise：入口返回 Promise，resolve 后 view 为 fetched 值', async () => {
    const result = lockData<Counter>(undefined, {
      getValue: () => Promise.resolve({ count: 42 }),
    });
    // 分支 B 契约：必须是 Promise
    expect(result).toBeInstanceOf(Promise);

    const [view, actions] = await result;
    expect(view.count).toBe(42);

    await actions.dispose();
  });

  test('data 作为占位：getValue 异步 resolve 前 view 可访问 initial', async () => {
    // RFC 补充语义：当同时提供 data 和 getValue 时，data 作为占位；getValue resolve 后覆盖
    const result = lockData<Counter>(
      { count: 0 },
      {
        getValue: () => Promise.resolve({ count: 99 }),
      },
    );
    expect(result).toBeInstanceOf(Promise);

    const [view, actions] = await result;
    expect(view.count).toBe(99);

    await actions.dispose();
  });

  test('类型层：推断为 Promise<LockDataTuple<T>>', () => {
    const result = lockData<Counter>(undefined, {
      getValue: () => Promise.resolve({ count: 0 }),
    });
    expectTypeOf(result).toEqualTypeOf<Promise<LockDataTuple<Counter>>>();

    // 清理
    void result.then(([, actions]) => actions.dispose());
  });
});

describe('lockData 三重载 / 分支 C（异步 syncMode storage-authority）', () => {
  test("syncMode='storage-authority' + id：入口返回 Promise（Node 环境 fallback 到内存权威）", async () => {
    // 用唯一 id 避免进程单例污染
    const uniqueId = `integration-c-${Date.now()}-${Math.random()}`;
    const result = lockData<Counter>({ count: 7 }, { id: uniqueId, syncMode: 'storage-authority' });
    // 分支 C 契约：必须是 Promise
    expect(result).toBeInstanceOf(Promise);

    const [view, actions] = await result;
    expect(view.count).toBe(7);

    await actions.dispose();
  });

  test('类型层：推断为 Promise<LockDataTuple<T>>', () => {
    const result = lockData<Counter>({ count: 0 }, { id: 'integration-c-type', syncMode: 'storage-authority' });
    expectTypeOf(result).toEqualTypeOf<Promise<LockDataTuple<Counter>>>();

    // 清理
    void result.then(([, actions]) => actions.dispose());
  });
});

describe('lockData 三重载 / 深只读视图类型契约（ReadonlyView<T>）', () => {
  test('类型层：view 的属性被标记为 readonly', () => {
    // ReadonlyView<T> 对 T 的所有属性加 readonly 修饰
    expectTypeOf<ReadonlyView<Counter>>().toEqualTypeOf<{ readonly count: number }>();

    // 嵌套对象同样递归 readonly
    interface Nested {
      readonly outer: { readonly inner: number };
    }
    expectTypeOf<ReadonlyView<{ outer: { inner: number } }>>().toEqualTypeOf<Nested>();
  });

  test('类型层：函数类型透传不递归加 readonly', () => {
    // RFC 约定：ReadonlyView 对函数类型透传（否则会破坏可调用性）
    type FnType = (x: number) => string;
    expectTypeOf<ReadonlyView<FnType>>().toEqualTypeOf<FnType>();
  });
});
