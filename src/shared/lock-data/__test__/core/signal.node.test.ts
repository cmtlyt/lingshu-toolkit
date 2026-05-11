import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { anySignal, signalWithTimeout } from '@/shared/lock-data/core/signal';

describe('anySignal', () => {
  test('任一输入 abort 会传播到派生 signal', () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const { signal } = anySignal([controller1.signal, controller2.signal]);

    expect(signal.aborted).toBe(false);
    controller2.abort(new Error('boom'));
    expect(signal.aborted).toBe(true);
  });

  test('构造时已有 aborted signal 则派生 signal 立即 aborted', () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    const { signal } = anySignal([controller.signal]);

    expect(signal.aborted).toBe(true);
  });

  test('空输入或全为 null 返回未 abort 的 signal', () => {
    const { signal: a } = anySignal([]);
    const { signal: b } = anySignal([null, undefined]);

    expect(a.aborted).toBe(false);
    expect(b.aborted).toBe(false);
  });

  test('abort reason 传播到派生 signal', () => {
    const controller = new AbortController();
    const reason = new Error('specific reason');

    const { signal } = anySignal([controller.signal]);
    controller.abort(reason);

    expect(signal.reason).toBe(reason);
  });

  test('dispose 可以提前解绑监听器', () => {
    const controller = new AbortController();
    const { signal, dispose } = anySignal([controller.signal]);

    dispose();
    controller.abort(new Error('late'));

    // 调用 dispose 后即便源 signal abort，也不会再向派生 signal 传播
    // （当走 polyfill 路径时成立；走原生 AbortSignal.any 时无监听可解，signal 会 aborted）
    // 因此这里不断言 signal.aborted，仅验证 dispose 不抛错
    expect(typeof signal).toBe('object');
  });

  test('混入 null / undefined 不影响合并行为', () => {
    const controller = new AbortController();
    const { signal } = anySignal([null, controller.signal, undefined]);

    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe('signalWithTimeout', () => {
  // 使用 vitest 的虚拟时钟替代真实 setTimeout 等待，
  // 避免每个超时用例阻塞 30ms 真实时间；仅在本 describe 内启用，
  // 防止影响其它依赖真实 microtask / Promise.resolve() 的 describe
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('超时后派生 signal 被 abort', () => {
    const { signal } = signalWithTimeout(undefined, 10);

    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(10);
    expect(signal.aborted).toBe(true);
  });

  test('base signal 提前 abort 会传播', () => {
    const controller = new AbortController();
    const { signal, dispose } = signalWithTimeout(controller.signal, 1000);

    controller.abort(new Error('user cancel'));
    expect(signal.aborted).toBe(true);
    dispose();
  });

  test('dispose 能清理未触发的超时定时器', () => {
    const { signal, dispose } = signalWithTimeout(undefined, 10);

    dispose();
    // 推进到远超 timeout 的时间：dispose 已 clearTimeout，不应触发 abort
    vi.advanceTimersByTime(100);
    expect(signal.aborted).toBe(false);
  });

  test('base signal 提前 abort 后自动清掉 timeout 定时器', () => {
    const controller = new AbortController();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    signalWithTimeout(controller.signal, 5000);

    // base signal abort → 应自动触发 dispose，清掉 timeout
    controller.abort(new Error('early cancel'));
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });

  test('构造时 base signal 已 aborted 则立即清掉 timeout', () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { signal } = signalWithTimeout(controller.signal, 5000);

    expect(signal.aborted).toBe(true);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    const callsBeforeAdvance = clearTimeoutSpy.mock.calls.length;

    // 推进时间确认定时器确实已被清理
    vi.advanceTimersByTime(10_000);
    // 若定时器已被清掉，则不应再有新的 clearTimeout 调用，且 signal 状态不变
    expect(clearTimeoutSpy.mock.calls.length).toBe(callsBeforeAdvance);

    clearTimeoutSpy.mockRestore();
  });

  test('外部 dispose 后 abort 监听不残留', () => {
    const removeListenerSpy = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

    const { dispose } = signalWithTimeout(undefined, 1000);

    dispose();
    // dispose 应调用 removeEventListener 清掉 onAbort 监听
    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    removeListenerSpy.mockRestore();
  });
});

/**
 * AbortSignal.any 缺失时的 polyfill 路径覆盖
 *
 * Node 20+ / 现代浏览器原生提供 AbortSignal.any，所以 anySignal 默认走快路径直接 return，
 * polyfill 内部的 alreadyAborted / addEventListener / dispose 等分支无法被触达。
 *
 * 这里通过临时 stub `AbortSignal.any = undefined` 把 anySignal 的执行流强制切到 polyfill 分支，
 * 用以覆盖 signal.ts L30-53 的全部分支
 */
describe('anySignal / polyfill 路径（AbortSignal.any 缺失环境）', () => {
  let originalAny: ((signals: AbortSignal[]) => AbortSignal) | undefined;

  beforeEach(() => {
    originalAny = AbortSignal.any as unknown as (signals: AbortSignal[]) => AbortSignal;
    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(AbortSignal, 'any', {
      value: originalAny,
      configurable: true,
      writable: true,
    });
  });

  test('polyfill 路径下任一输入 abort 会传播到派生 signal（命中 addEventListener 注册分支）', () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const { signal, dispose } = anySignal([controller1.signal, controller2.signal]);

    expect(signal.aborted).toBe(false);
    controller2.abort(new Error('boom'));
    expect(signal.aborted).toBe(true);

    dispose();
  });

  test('polyfill 路径下构造时已 aborted → 立即透传 reason 并返回 noop dispose', () => {
    const controller = new AbortController();
    const reason = new Error('pre-aborted');
    controller.abort(reason);

    const { signal, dispose } = anySignal([controller.signal]);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);

    // 早路径返回 noop dispose，调用不应抛错
    expect(() => dispose()).not.toThrow();
  });

  test('polyfill 路径下 dispose 后再 abort 源 signal 不会再传播（监听已解绑）', () => {
    const controller = new AbortController();
    const { signal, dispose } = anySignal([controller.signal]);

    dispose();
    controller.abort();

    // 监听已解绑，派生 signal 维持未 abort 状态
    expect(signal.aborted).toBe(false);
  });

  test('polyfill 路径下混入 null / undefined 不影响合并行为', () => {
    const controller = new AbortController();
    const { signal, dispose } = anySignal([null, controller.signal, undefined]);

    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);

    dispose();
  });

  test('polyfill 路径下 abort reason 透传到派生 signal', () => {
    const controller = new AbortController();
    const reason = new Error('specific reason');

    const { signal, dispose } = anySignal([controller.signal]);
    controller.abort(reason);

    expect(signal.reason).toBe(reason);
    dispose();
  });

  test('polyfill 路径下首次 abort 后自动解绑剩余 source 的监听', () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const controller3 = new AbortController();

    const removeSpy2 = vi.spyOn(controller2.signal, 'removeEventListener');
    const removeSpy3 = vi.spyOn(controller3.signal, 'removeEventListener');

    anySignal([controller1.signal, controller2.signal, controller3.signal]);

    // controller1 abort → 应自动解绑 controller2、controller3 上的监听
    controller1.abort(new Error('first'));

    expect(removeSpy2).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(removeSpy3).toHaveBeenCalledWith('abort', expect.any(Function));

    removeSpy2.mockRestore();
    removeSpy3.mockRestore();
  });
});
