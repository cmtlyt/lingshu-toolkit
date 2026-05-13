/**
 * drivers/local.ts 残余分支覆盖测试（node 环境）
 *
 * 集中覆盖 local.ts 内部公共路径不可触达的防御性分支：
 *   1. pumpNextWaiter：`shift()` 返回 undefined 时早退（前置 `length===0` 已拦截）
 *   2. removeWaiter：target 不在队列中时 for 循环 `===` false 分支（settled 双重保护下不可达）
 *   3. enqueueWaiter：waiter resolve / reject / abort 三处 `if (settled) return` 早退
 *
 * 实现策略：直接 import 内部函数（已在 local.ts 末尾追加 export，**不通过 lock-data/index.ts 暴露**），
 * 手工构造 `LocalDriverState` + 触发重入路径。
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import {
  enqueueWaiter,
  type LocalDriverState,
  type LocalWaiter,
  pumpNextWaiter,
  removeWaiter,
} from '@/shared/lock-data/drivers/local';
import { LockAbortedError } from '@/shared/lock-data/errors';
import type { LockDriverContext } from '@/shared/lock-data/types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function buildState(): LocalDriverState {
  return {
    name: `${LOCK_PREFIX}:__local__`,
    logger: resolveLoggerAdapter({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    waiters: [],
    holder: null,
    destroyed: false,
  };
}

function buildContext(overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const controller = new AbortController();
  return {
    name: overrides.name || `${LOCK_PREFIX}:__local__`,
    token: overrides.token || `tok_${Math.random().toString(36).slice(2, 8)}`,
    signal: overrides.signal || controller.signal,
    acquireTimeout: overrides.acquireTimeout === undefined ? NEVER_TIMEOUT : overrides.acquireTimeout,
    holdTimeout: overrides.holdTimeout === undefined ? NEVER_TIMEOUT : overrides.holdTimeout,
    force: overrides.force === true,
  };
}

/** 构造一个最小可用的 LocalWaiter stub（仅供 removeWaiter 测试用） */
function buildStubWaiter(token: string): LocalWaiter {
  return {
    token,
    resolve: vi.fn(),
    reject: vi.fn(),
    abort: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 1. pumpNextWaiter：`if (!next) return` 防御早退
// ---------------------------------------------------------------------------

describe('pumpNextWaiter / shift 返回 undefined 防御早退', () => {
  test('在 waiters 中插入 undefined 后调用 pumpNextWaiter → shift 返回 undefined 命中早退', () => {
    // 公共路径下 waiters 只 push 非空 LocalWaiter，shift 必返非 undefined；
    // 这里用直接 push undefined 模拟未来重构出现的"队列被外部污染"场景，命中防御 if
    const state = buildState();
    // 故意污染 waiters 队列以命中防御分支
    (state.waiters as any[]).push(undefined);

    expect(() => pumpNextWaiter(state)).not.toThrow();
    // 即便走早退，state.holder 仍保持 null（说明早退分支被命中，没继续执行 buildLocalHandle）
    expect(state.holder).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. removeWaiter：target 不在队列时 `===` false 分支
// ---------------------------------------------------------------------------

describe('removeWaiter / target 不在队列中', () => {
  test('队列里有其他 waiter 但没有 target → for 循环 `===` false 分支被遍历，最后函数自然返回', () => {
    const otherWaiter = buildStubWaiter('other');
    const targetWaiter = buildStubWaiter('target');
    const waiters: LocalWaiter[] = [otherWaiter];

    expect(() => removeWaiter(waiters, targetWaiter)).not.toThrow();
    // 队列保持原状（target 不在里面，没东西可移除）
    expect(waiters).toEqual([otherWaiter]);
  });

  test('队列为空 → for 循环不进入，函数直接返回', () => {
    const targetWaiter = buildStubWaiter('target');
    const waiters: LocalWaiter[] = [];

    expect(() => removeWaiter(waiters, targetWaiter)).not.toThrow();
    expect(waiters).toEqual([]);
  });

  test('target 在队列中 → 命中 `===` true 分支正常移除', () => {
    const otherWaiter = buildStubWaiter('other');
    const targetWaiter = buildStubWaiter('target');
    const waiters: LocalWaiter[] = [otherWaiter, targetWaiter];

    removeWaiter(waiters, targetWaiter);
    expect(waiters).toEqual([otherWaiter]);
  });
});

// ---------------------------------------------------------------------------
// 3. enqueueWaiter：resolve / reject / abort 的 settled=true 早退
// ---------------------------------------------------------------------------

describe('enqueueWaiter / waiter 内部 settled=true 重入早退', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('signal abort 触发 reject（settled=true），后续 timeout cb 进入 abort → 命中 abort 的 settled 早退', async () => {
    const state = buildState();
    const controller = new AbortController();
    const ctx = buildContext({ token: 'reentrant-abort', signal: controller.signal, acquireTimeout: 100 });

    const promise = enqueueWaiter(state, ctx);
    // waiter 已入队
    expect(state.waiters).toHaveLength(1);

    // 先 abort signal → onSignalAbort 调 waiter.abort → removeWaiter + reject(settled=true)
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(LockAbortedError);
    // waiter 已从队列移除
    expect(state.waiters).toHaveLength(0);

    // 此时再让 timer 跨过 acquireTimeout：timeout cb 调 waiter.abort，但 settled=true 早退
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    // 队列仍为空（abort 早退后没二次 removeWaiter）
    expect(state.waiters).toHaveLength(0);
  });

  test('成功 resolve 后再触发 signal abort → onSignalAbort 调 waiter.abort，但 settled=true 早退', async () => {
    const state = buildState();
    const controller = new AbortController();
    const ctx = buildContext({ token: 'reentrant-resolve', signal: controller.signal });

    const promise = enqueueWaiter(state, ctx);
    expect(state.waiters).toHaveLength(1);

    // 直接拿队首 waiter resolve（模拟 pumpNextWaiter 出队 + grant）
    const waiter = state.waiters[0] as LocalWaiter;
    state.waiters.shift();
    const stubHandle = { release: vi.fn() };
    // @ts-expect-error test
    waiter.resolve(stubHandle);
    await expect(promise).resolves.toBe(stubHandle);

    // 此时 settled=true，再 abort signal → onSignalAbort 调 waiter.abort 命中 settled 早退
    expect(() => controller.abort()).not.toThrow();
  });

  test('对同一 waiter 连续两次 resolve → 第二次命中 resolve 的 settled=true 早退', async () => {
    const state = buildState();
    const controller = new AbortController();
    const ctx = buildContext({ token: 'double-resolve', signal: controller.signal });

    const promise = enqueueWaiter(state, ctx);
    const waiter = state.waiters[0] as LocalWaiter;
    state.waiters.shift();

    const firstHandle = { release: vi.fn() };
    const secondHandle = { release: vi.fn() };
    // @ts-expect-error test
    waiter.resolve(firstHandle);
    // 第二次 resolve：命中 settled=true 早退，不会改变 promise 已 resolve 的值
    // @ts-expect-error test
    expect(() => waiter.resolve(secondHandle)).not.toThrow();

    await expect(promise).resolves.toBe(firstHandle);
  });

  test('对同一 waiter 连续两次 reject → 第二次命中 reject 的 settled=true 早退', async () => {
    const state = buildState();
    const controller = new AbortController();
    const ctx = buildContext({ token: 'double-reject', signal: controller.signal });

    const promise = enqueueWaiter(state, ctx);
    const waiter = state.waiters[0] as LocalWaiter;

    const firstError = new LockAbortedError('first');
    const secondError = new LockAbortedError('second');
    waiter.reject(firstError);
    // 第二次 reject：命中 settled=true 早退
    expect(() => waiter.reject(secondError)).not.toThrow();

    await expect(promise).rejects.toBe(firstError);
  });

  test('对同一 waiter 连续两次 abort → 第二次命中 abort 的 settled=true 早退', async () => {
    // 公共路径下 signal/timeout/destroy 三路径竞争触发 abort 时，第一次 abort 走完
    // removeWaiter + waiter.reject(settled=true) 后已成 settled；第二次 abort 应命中
    // 入口的 if (settled) return 早退。直接调用导出的 enqueueWaiter 拿到 waiter 后
    // 连续调 abort 即可命中，无需依赖真实 timer 时序
    const state = buildState();
    const controller = new AbortController();
    const ctx = buildContext({ token: 'double-abort', signal: controller.signal });

    const promise = enqueueWaiter(state, ctx);
    const waiter = state.waiters[0] as LocalWaiter;

    const firstError = new LockAbortedError('first abort');
    const secondError = new LockAbortedError('second abort');

    // 第一次 abort：removeWaiter + waiter.reject(firstError)，settled 切到 true
    waiter.abort(firstError);
    // 队列已被 removeWaiter 清空
    expect(state.waiters).toHaveLength(0);

    // 第二次 abort：命中 abort 入口 if (settled) return 早退
    expect(() => waiter.abort(secondError)).not.toThrow();

    // 第二次 abort 没改变 promise 的 rejection 值（仍是首次 error）
    await expect(promise).rejects.toBe(firstError);
  });
});
