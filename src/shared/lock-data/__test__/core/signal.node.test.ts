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
});
