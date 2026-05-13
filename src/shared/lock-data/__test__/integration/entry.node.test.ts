import { describe, expect, test } from 'vitest';
import { lockData } from '../../index';

/**
 * lockData 单签名集成契约 runtime 测试（wrapper 方案 + 单参数 + getValue 必传）
 *
 * 两条初始化路径（运行时行为）：
 * - 路径 A：同步 getValue（返回非 Promise）→ 入口直接得到元组，无需 await
 * - 路径 B：异步 getValue（返回 Promise）或 `syncMode='storage-authority'+id` →
 *   入口返回 Promise 实例，必须 await
 *
 * Node 环境下：syncMode='storage-authority' 在没有 localStorage 时会自动 fallback
 * 到内存权威（见 entry.ts 的 warn log），异步入口契约保持不变
 *
 * 类型层精确推断契约见 entry.test-d.ts（单签名 + 条件类型 LockDataReturn<T, O>）
 */

interface Counter {
  readonly count: number;
}

describe('lockData / 同步 getValue 路径', () => {
  test('同步 getValue：返回值类型层即为元组，可直接解构（无需 as 断言）', async () => {
    const [view, actions] = lockData({
      getValue: (): Counter => {
        return { count: 0 };
      },
    });
    expect(view.count).toBe(0);
    expect(actions.update).toBeTypeOf('function');

    await actions.dispose();
  });

  test("显式 syncMode='none'：仍走同步路径", async () => {
    const [view, actions] = lockData({
      getValue: (): Counter => {
        return { count: 10 };
      },
      syncMode: 'none',
    });
    expect(view.count).toBe(10);

    await actions.dispose();
  });

  test('运行时：同步 getValue 路径返回值不是 Promise（直接得到元组）', async () => {
    const result = lockData({
      getValue: (): Counter => {
        return { count: 0 };
      },
    });
    expect(result).not.toBeInstanceOf(Promise);

    await result[1].dispose();
  });
});

describe('lockData / 异步 getValue 路径', () => {
  test('getValue 返回 Promise：入口返回 Promise，resolve 后 view 为 fetched 值', async () => {
    const result = lockData({
      getValue: (): Promise<Counter> => Promise.resolve({ count: 42 }),
    });
    expect(result).toBeInstanceOf(Promise);

    const [view, actions] = await result;
    expect(view.count).toBe(42);

    await actions.dispose();
  });
});

describe("lockData / syncMode='storage-authority' 异步路径", () => {
  test("syncMode='storage-authority' + id：入口返回 Promise（Node 环境 fallback 到内存权威）", async () => {
    // 用唯一 id 避免进程单例污染
    const uniqueId = `integration-c-${Date.now()}-${Math.random()}`;
    const result = lockData({
      getValue: (): Counter => {
        return { count: 7 };
      },
      id: uniqueId,
      syncMode: 'storage-authority',
    });
    expect(result).toBeInstanceOf(Promise);

    const [view, actions] = await result;
    expect(view.count).toBe(7);

    await actions.dispose();
  });
});
