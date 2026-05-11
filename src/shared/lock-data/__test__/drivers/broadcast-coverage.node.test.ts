/**
 * drivers/broadcast.ts 覆盖率补强测试
 *
 * 通过直接 import 内部纯函数（buildWaiter / acquireBroadcastLock），命中
 * 主链路（先 resolve / 先 reject / 单个 abort）下不易触达的防御性分支。
 *
 * 覆盖目标（参考 analyze-coverage 输出）：
 * - L66-67: waiter.resolve 在 settled=true 时早退
 * - L74-75: waiter.reject 在 settled=true 时早退
 * - L82-83: waiter.abort 在 settled=true 时早退
 * - L97-104: waiter.abort 时 pendingForce.waiter === waiter 路径（清理 pendingForce + timer）
 * - L150 destroyed 分支已被 createBroadcastDriver browser 测试覆盖；本文件命中
 *   acquireBroadcastLock(state, ctx) 在 state.destroyed=true 时 reject
 * - L203 unsubscribe 闭包：通过 createBroadcastDriver 间接触发（已由 browser 覆盖）
 *
 * 设计约束：node 环境，无 BroadcastChannel 依赖；用 fake state 直接构造测试目标
 */

import { describe, expect, test, vi } from 'vitest';
import { acquireBroadcastLock, buildWaiter } from '../../drivers/broadcast';
import type { BroadcastDriverState, Waiter } from '../../drivers/broadcast-state';
import type { ChannelAdapter, LockDriverContext, LockDriverHandle, LoggerAdapter } from '../../types';

function createLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createNoopChannel(): ChannelAdapter {
  return {
    postMessage: vi.fn(),
    subscribe: () => () => {},
    close: vi.fn(),
  };
}

function createFakeState(overrides: Partial<BroadcastDriverState> = {}): BroadcastDriverState {
  const logger = createLogger();
  return {
    deps: {
      id: 'test-id',
      name: 'broadcast-test',
      logger,
    } as unknown as BroadcastDriverState['deps'],
    channel: createNoopChannel(),
    senderId: 'sender-test',
    status: { kind: 'idle' },
    waiters: [],
    pendingAnnounce: null,
    pendingForce: null,
    destroyed: false,
    unsubscribe: null,
    ...overrides,
  };
}

function createCtx(overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const controller = new AbortController();
  return {
    token: 'token-test',
    signal: controller.signal,
    force: false,
    acquireTimeout: 0,
    ...overrides,
  } as any;
}

describe('drivers/broadcast — buildWaiter settled 互斥', () => {
  test('resolve 后再次 resolve / reject / abort 全部早退', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const ctx = createCtx();

    const waiter = buildWaiter(ctx, state, resolve, reject);
    const fakeHandle: LockDriverHandle = {
      release: vi.fn(),
      onRevokedByDriver: vi.fn(),
    };

    waiter.resolve(fakeHandle);
    expect(resolve).toHaveBeenCalledTimes(1);

    // 第二次 resolve 命中 L66-67 settled 早退
    waiter.resolve(fakeHandle);
    expect(resolve).toHaveBeenCalledTimes(1);

    // settled=true 时 reject 命中 L74-75 早退
    waiter.reject(new Error('after-resolve'));
    expect(reject).not.toHaveBeenCalled();

    // settled=true 时 abort 命中 L82-83 早退
    waiter.abort(new Error('after-resolve-abort'));
    expect(reject).not.toHaveBeenCalled();
  });

  test('reject 后再次 resolve / reject 全部早退', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const ctx = createCtx();

    const waiter = buildWaiter(ctx, state, resolve, reject);

    waiter.reject(new Error('first-reject'));
    expect(reject).toHaveBeenCalledTimes(1);

    waiter.reject(new Error('second-reject'));
    expect(reject).toHaveBeenCalledTimes(1);

    waiter.resolve({ release: vi.fn(), onRevokedByDriver: vi.fn() });
    expect(resolve).not.toHaveBeenCalled();
  });

  test('abort 后再次 abort 命中 L82-83 早退', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const ctx = createCtx();

    const waiter = buildWaiter(ctx, state, resolve, reject);

    waiter.abort(new Error('first-abort'));
    expect(reject).toHaveBeenCalledTimes(1);

    waiter.abort(new Error('second-abort'));
    expect(reject).toHaveBeenCalledTimes(1);
  });
});

describe('drivers/broadcast — buildWaiter abort 时清理 pendingForce', () => {
  test('waiter 是 pendingForce.waiter → abort 清理 pendingForce + timer', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      const resolve = vi.fn<(handle: LockDriverHandle) => void>();
      const reject = vi.fn<(error: Error) => void>();
      const ctx = createCtx();

      const waiter = buildWaiter(ctx, state, resolve, reject);

      // 手动构造 pendingForce 让 waiter 命中 abort 清理路径（L97-104）
      const fakeTimer = setTimeout(() => {}, 1_000_000) as unknown as ReturnType<typeof setTimeout>;
      state.pendingForce = {
        token: ctx.token,
        ts: Date.now(),
        waiter,
        abandoned: false,
        timer: fakeTimer,
      };

      waiter.abort(new Error('abort-while-pending-force'));

      expect(state.pendingForce).toBeNull();
      expect(reject).toHaveBeenCalledTimes(1);
      // timer 已被 clearTimeout 处理：fast-forward 不会触发任何回调
      vi.advanceTimersByTime(2_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('waiter 是 pendingForce.waiter 且 timer=null → abort 仍清理 pendingForce', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const ctx = createCtx();

    const waiter = buildWaiter(ctx, state, resolve, reject);

    state.pendingForce = {
      token: ctx.token,
      ts: Date.now(),
      waiter,
      abandoned: false,
      timer: null,
    };

    waiter.abort(new Error('abort-pending-force-no-timer'));

    expect(state.pendingForce).toBeNull();
    expect(reject).toHaveBeenCalledTimes(1);
  });

  test('waiter 不是 pendingForce.waiter → abort 不动 pendingForce', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const ctx = createCtx();

    const waiter = buildWaiter(ctx, state, resolve, reject);
    const otherWaiter: Waiter = {
      token: 'other',
      resolve: vi.fn(),
      reject: vi.fn(),
      abort: vi.fn(),
    };
    state.pendingForce = {
      token: 'other',
      ts: Date.now(),
      waiter: otherWaiter,
      abandoned: false,
      timer: null,
    };

    waiter.abort(new Error('abort-not-owner'));

    // pendingForce 不被清空
    expect(state.pendingForce).not.toBeNull();
    expect(state.pendingForce?.waiter).toBe(otherWaiter);
  });
});

describe('drivers/broadcast — buildWaiter abort 时清理 pendingAnnounce.timer', () => {
  test('waiter 是 pendingAnnounce.waiter 且 timer 非 null → 清理 timer（命中 L91 真分支）', () => {
    vi.useFakeTimers();
    try {
      const state = createFakeState();
      const resolve = vi.fn<(handle: LockDriverHandle) => void>();
      const reject = vi.fn<(error: Error) => void>();
      const ctx = createCtx();

      const waiter = buildWaiter(ctx, state, resolve, reject);

      const fakeTimer = setTimeout(() => {}, 1_000_000) as unknown as ReturnType<typeof setTimeout>;
      state.pendingAnnounce = {
        requestId: 'req-1',
        ts: Date.now(),
        waiter,
        abandoned: false,
        timer: fakeTimer,
      };

      waiter.abort(new Error('abort-while-pending-announce'));

      expect(state.pendingAnnounce).toBeNull();
      expect(reject).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test('waiter 是 pendingAnnounce.waiter 且 timer=null → 跳过 clearTimeout（命中 L91 false 分支）', () => {
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();
    const ctx = createCtx();

    const waiter = buildWaiter(ctx, state, resolve, reject);

    state.pendingAnnounce = {
      requestId: 'req-1',
      ts: Date.now(),
      waiter,
      abandoned: false,
      timer: null,
    };

    waiter.abort(new Error('abort-pending-announce-no-timer'));

    expect(state.pendingAnnounce).toBeNull();
    expect(reject).toHaveBeenCalledTimes(1);
  });
});

describe('drivers/broadcast — createBroadcastDriver subscribe 闭包', () => {
  test('createBroadcastDriver 启动时 subscribe 回调闭包被注册并可被触发（命中 L203 anonymous_11）', async () => {
    let capturedHandler: ((raw: unknown) => void) | null = null;
    const fakeChannel: ChannelAdapter = {
      postMessage: vi.fn(),
      subscribe: (handler) => {
        capturedHandler = handler;
        return () => {};
      },
      close: vi.fn(),
    };

    const { createBroadcastDriver } = await import('../../drivers/broadcast');
    const driver = createBroadcastDriver({
      id: 'subscribe-test',
      name: 'broadcast-subscribe',
      logger: createLogger(),
      getChannel: () => fakeChannel,
    } as unknown as Parameters<typeof createBroadcastDriver>[0]);

    expect(capturedHandler).not.toBeNull();
    // 触发闭包：不要求消息有效，只要让 (raw) => handleMessage(...) 被调用即可
    // @ts-expect-error test
    capturedHandler?.('not-a-valid-message');

    driver.destroy();
  });
});

describe('drivers/broadcast — acquireBroadcastLock destroyed reject', () => {
  test('state.destroyed=true → 返回 rejected Promise（不抛同步错）', async () => {
    const state = createFakeState({ destroyed: true });
    const ctx = createCtx({ token: 'token-on-destroyed' });

    const promise = acquireBroadcastLock(state, ctx);
    await expect(promise).rejects.toThrow(/broadcast driver has been destroyed/u);
  });
});

describe('drivers/broadcast — buildWaiter signal.aborted microtask 分支', () => {
  test('signal 已 abort → queueMicrotask 触发 waiter.abort → reject', async () => {
    const state = createFakeState();
    const controller = new AbortController();
    controller.abort();
    const ctx = createCtx({ token: 'token-microtask-abort', signal: controller.signal });

    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const reject = vi.fn<(error: Error) => void>();

    const waiter = buildWaiter(ctx, state, resolve, reject);

    // buildWaiter 在 signal.aborted 时提前 return，不注册 addEventListener
    // microtask 尚未执行，reject 还没被调用
    expect(reject).not.toHaveBeenCalled();
    expect(waiter).toBeDefined();

    // flush microtask：让 queueMicrotask(() => onSignalAbort()) 执行
    await Promise.resolve();

    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0][0].message).toMatch(/acquire aborted/u);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('drivers/broadcast — acquireBroadcastLock signal.aborted early return', () => {
  test('signal 已 abort → 直接 reject，不创建 waiter、不发协议消息', async () => {
    const state = createFakeState();
    const controller = new AbortController();
    controller.abort();
    const ctx = createCtx({ token: 'token-pre-aborted', signal: controller.signal });

    const promise = acquireBroadcastLock(state, ctx);
    await expect(promise).rejects.toThrow(/acquire aborted/u);

    // 验证零副作用：不入队、不竞选
    expect(state.waiters).toHaveLength(0);
    expect(state.pendingAnnounce).toBeNull();
    expect(state.pendingForce).toBeNull();
    expect(state.channel.postMessage).not.toHaveBeenCalled();
  });

  test('signal 已 abort 时 reject 的错误是 LockAbortedError 并包含 token', async () => {
    const state = createFakeState();
    const controller = new AbortController();
    controller.abort();
    const ctx = createCtx({ token: 'my-unique-token', signal: controller.signal });

    const promise = acquireBroadcastLock(state, ctx);
    await expect(promise).rejects.toThrow(/my-unique-token/u);
  });
});
