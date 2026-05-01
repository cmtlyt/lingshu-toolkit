/**
 * adapter 合规性测试套件 —— 基于 `createMemoryAdapters` 参考实现
 *
 * 作用：
 * - 把 helper 里的 memory adapters 当作"用户自定义实现"来测试
 * - 覆盖 RFC.md「接口定义」中 AuthorityAdapter / ChannelAdapter / SessionStoreAdapter
 *   的全部公开契约语义（读写 / 订阅 / 关闭 / 错误隔离 / 跨 Tab 语义）
 * - 用户实现自定义 adapter 时可以参照本套件，作为"自测验收清单"
 *
 * 与其他合规测试的分工：
 * - `adapters/authority-memory.node.test.ts`：测 **默认** AuthorityAdapter（基于 localStorage）
 *   在 mock 浏览器环境下的 read/write/subscribe 行为（含 QuotaExceededError 等浏览器边界）
 * - 本套件：测 **参考内存实现** 的跨 Tab 语义（多 Tab 共享 env 的订阅广播行为），
 *   覆盖默认实现在 node 环境下跑不通的"多 Tab 交互"契约
 *
 * 测试分组：
 * 1. AuthorityAdapter 契约
 *    1.1 read / write / remove 基础读写
 *    1.2 subscribe：跨 Tab 通知（本 Tab write 不触发自己的 subscribe）
 *    1.3 subscribe：解绑后不再触发
 *    1.4 subscribe：回调异常走 logger.error 隔离，不污染其他订阅者
 *    1.5 subscribe：按 key 分桶（不同 id 的 adapter 互不串扰）
 * 2. ChannelAdapter 契约
 *    2.1 postMessage：跨 Tab 广播（发送方不回收自己消息）
 *    2.2 subscribe：解绑 + close 后不再触发
 *    2.3 postMessage / subscribe：回调异常隔离
 *    2.4 按 name 分桶（session vs custom 互不串扰）
 *    2.5 close 幂等
 * 3. SessionStoreAdapter 契约
 *    3.1 read / write 基础语义
 *    3.2 Tab 独立性（每个 Tab 一份 sessionScope）
 */

import { describe, expect, test, vi } from 'vitest';
import type { LoggerAdapter } from '../../types';
import { createMemoryAdapters, createSharedMemoryEnv } from '../_helpers/memory-adapters';

function createLoggerSpy(): LoggerAdapter & {
  readonly warnMock: ReturnType<typeof vi.fn>;
  readonly errorMock: ReturnType<typeof vi.fn>;
} {
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  return {
    warn: warnMock,
    error: errorMock,
    warnMock,
    errorMock,
  };
}

// ===========================================================================
// 1. AuthorityAdapter
// ===========================================================================

describe('memory-adapters / AuthorityAdapter 合规性', () => {
  test('1.1 read / write / remove 基础读写', () => {
    const env = createSharedMemoryEnv();
    const tab = createMemoryAdapters(env);
    const authority = tab.getAuthority({ id: 'k1' });

    expect(authority.read()).toBeNull();

    authority.write('{"rev":1}');
    expect(authority.read()).toBe('{"rev":1}');

    authority.write('{"rev":2}');
    expect(authority.read()).toBe('{"rev":2}');

    authority.remove();
    expect(authority.read()).toBeNull();
  });

  test('1.2 subscribe：跨 Tab 通知 —— 本 Tab write 不触发自己的 subscribe', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const authorityA = tabA.getAuthority({ id: 'shared' });
    const authorityB = tabB.getAuthority({ id: 'shared' });

    const onAUpdate = vi.fn();
    const onBUpdate = vi.fn();

    authorityA.subscribe(onAUpdate);
    authorityB.subscribe(onBUpdate);

    // TabA write：仅 TabB 收到通知；TabA 自己不收（对齐原生 storage 事件语义）
    authorityA.write('{"rev":1}');

    expect(onAUpdate).not.toHaveBeenCalled();
    expect(onBUpdate).toHaveBeenCalledTimes(1);
    expect(onBUpdate).toHaveBeenCalledWith('{"rev":1}');

    // TabB write：仅 TabA 收到通知
    authorityB.write('{"rev":2}');
    expect(onAUpdate).toHaveBeenCalledTimes(1);
    expect(onAUpdate).toHaveBeenCalledWith('{"rev":2}');
    expect(onBUpdate).toHaveBeenCalledTimes(1);
  });

  test('1.3 subscribe：remove 也会触发 —— newValue 为 null', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const authorityA = tabA.getAuthority({ id: 'k' });
    const authorityB = tabB.getAuthority({ id: 'k' });

    const onBUpdate = vi.fn();
    authorityB.subscribe(onBUpdate);

    authorityA.write('payload');
    authorityA.remove();

    expect(onBUpdate).toHaveBeenCalledTimes(2);
    expect(onBUpdate.mock.calls[0][0]).toBe('payload');
    expect(onBUpdate.mock.calls[1][0]).toBeNull();
  });

  test('1.4 subscribe：解绑后不再触发', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const authorityA = tabA.getAuthority({ id: 'k' });
    const authorityB = tabB.getAuthority({ id: 'k' });

    const onBUpdate = vi.fn();
    const unsubscribe = authorityB.subscribe(onBUpdate);

    authorityA.write('first');
    expect(onBUpdate).toHaveBeenCalledTimes(1);

    unsubscribe();
    authorityA.write('second');
    expect(onBUpdate).toHaveBeenCalledTimes(1);
  });

  test('1.5 subscribe：回调异常走 logger.error 隔离，其他订阅者正常触发', () => {
    const env = createSharedMemoryEnv();
    const logger = createLoggerSpy();

    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env, { logger });
    const tabC = createMemoryAdapters(env, { logger });

    const authorityA = tabA.getAuthority({ id: 'k' });
    const authorityB = tabB.getAuthority({ id: 'k' });
    const authorityC = tabC.getAuthority({ id: 'k' });

    const throwing = vi.fn(() => {
      throw new Error('subscriber-boom');
    });
    const normal = vi.fn();
    authorityB.subscribe(throwing);
    authorityC.subscribe(normal);

    // 关键：writer 是 TabA；TabB 的 throwing 抛错时，TabC 的 normal 仍应被调用
    expect(() => authorityA.write('payload')).not.toThrow();

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(normal).toHaveBeenCalledTimes(1);
    expect(normal).toHaveBeenCalledWith('payload');
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    expect(logger.errorMock.mock.calls[0][0]).toMatch(/authority subscriber threw/u);
  });

  test('1.6 按 id 分桶：不同 id 的 subscribe 互不串扰', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const authorityA = tabA.getAuthority({ id: 'alpha' });
    const authorityBForBeta = tabB.getAuthority({ id: 'beta' });

    const onBetaUpdate = vi.fn();
    authorityBForBeta.subscribe(onBetaUpdate);

    // 写入 alpha，beta 订阅不应触发
    authorityA.write('alpha-value');
    expect(onBetaUpdate).not.toHaveBeenCalled();
  });

  test('1.7 subscribe 内部解绑：迭代快照保证剩余订阅者正常触发', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const authorityA = tabA.getAuthority({ id: 'k' });
    const authorityB = tabB.getAuthority({ id: 'k' });

    const laterSubscriber = vi.fn();
    // 第一个订阅者在回调内解绑自己，不应影响后续订阅者
    // 用 holder 间接引用避免 TS TDZ（箭头函数体在 subscribe 返回值赋值之后才执行，
    // 但直接引用 const 变量名会触发 TS "used before assignment" 告警）
    const selfUnsubscribe: { fn: (() => void) | null } = { fn: null };
    selfUnsubscribe.fn = authorityB.subscribe(() => {
      selfUnsubscribe.fn?.();
    });
    authorityB.subscribe(laterSubscriber);

    authorityA.write('v');
    expect(laterSubscriber).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2. ChannelAdapter
// ===========================================================================

describe('memory-adapters / ChannelAdapter 合规性', () => {
  test('2.1 postMessage：跨 Tab 广播 —— 发送方不回收自己消息', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const channelA = tabA.getChannel({ id: 'id1', channel: 'custom' });
    const channelB = tabB.getChannel({ id: 'id1', channel: 'custom' });

    const onAMessage = vi.fn();
    const onBMessage = vi.fn();
    channelA.subscribe(onAMessage);
    channelB.subscribe(onBMessage);

    channelA.postMessage({ type: 'hello', value: 42 });

    expect(onAMessage).not.toHaveBeenCalled();
    expect(onBMessage).toHaveBeenCalledTimes(1);
    expect(onBMessage).toHaveBeenCalledWith({ type: 'hello', value: 42 });
  });

  test('2.2 subscribe 解绑后不再触发', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const channelA = tabA.getChannel({ id: 'id1', channel: 'custom' });
    const channelB = tabB.getChannel({ id: 'id1', channel: 'custom' });

    const onBMessage = vi.fn();
    const unsubscribe = channelB.subscribe(onBMessage);

    channelA.postMessage('m1');
    expect(onBMessage).toHaveBeenCalledTimes(1);

    unsubscribe();
    channelA.postMessage('m2');
    expect(onBMessage).toHaveBeenCalledTimes(1);
  });

  test('2.3 close 后 postMessage / subscribe 均为 no-op', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const channelA = tabA.getChannel({ id: 'id1', channel: 'custom' });
    const channelB = tabB.getChannel({ id: 'id1', channel: 'custom' });

    const onBMessage = vi.fn();
    channelB.subscribe(onBMessage);

    channelA.close();
    channelA.postMessage('after-close');

    expect(onBMessage).not.toHaveBeenCalled();

    // close 后 subscribe 返回 noop 解绑函数，不抛错
    const afterCloseUnsub = channelA.subscribe(vi.fn());
    expect(typeof afterCloseUnsub).toBe('function');
    expect(() => afterCloseUnsub()).not.toThrow();
  });

  test('2.4 close 幂等：重复 close 不抛错', () => {
    const env = createSharedMemoryEnv();
    const tab = createMemoryAdapters(env);
    const channel = tab.getChannel({ id: 'id1', channel: 'session' });

    expect(() => {
      channel.close();
      channel.close();
      channel.close();
    }).not.toThrow();
  });

  test('2.5 subscribe 回调异常走 logger.error，不污染发送方，不影响其他订阅者', () => {
    const env = createSharedMemoryEnv();
    const logger = createLoggerSpy();

    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env, { logger });
    const tabC = createMemoryAdapters(env, { logger });

    const channelA = tabA.getChannel({ id: 'id1', channel: 'custom' });
    const channelB = tabB.getChannel({ id: 'id1', channel: 'custom' });
    const channelC = tabC.getChannel({ id: 'id1', channel: 'custom' });

    const throwing = vi.fn(() => {
      throw new Error('listener-boom');
    });
    const normal = vi.fn();
    channelB.subscribe(throwing);
    channelC.subscribe(normal);

    expect(() => channelA.postMessage('payload')).not.toThrow();

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(normal).toHaveBeenCalledTimes(1);
    expect(normal).toHaveBeenCalledWith('payload');
    // 两个异常只会来自 throwing，logger.error 被调用一次
    expect(logger.errorMock).toHaveBeenCalledTimes(1);
    expect(logger.errorMock.mock.calls[0][0]).toMatch(/channel subscriber threw/u);
  });

  test('2.6 按 name 分桶：同 id 不同 channel（session vs custom）互不串扰', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const sessionChannelA = tabA.getChannel({ id: 'id1', channel: 'session' });
    const customChannelB = tabB.getChannel({ id: 'id1', channel: 'custom' });

    const onCustom = vi.fn();
    customChannelB.subscribe(onCustom);

    sessionChannelA.postMessage('session-payload');
    expect(onCustom).not.toHaveBeenCalled();
  });

  test('2.7 同 channel 不同 id：互不串扰', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const channelAlpha = tabA.getChannel({ id: 'alpha', channel: 'custom' });
    const channelBeta = tabB.getChannel({ id: 'beta', channel: 'custom' });

    const onBeta = vi.fn();
    channelBeta.subscribe(onBeta);

    channelAlpha.postMessage('alpha');
    expect(onBeta).not.toHaveBeenCalled();
  });

  test('2.8 postMessage 迭代期间新订阅者不应被当次 postMessage 通知', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);
    const tabC = createMemoryAdapters(env);

    const channelA = tabA.getChannel({ id: 'id1', channel: 'custom' });
    const channelB = tabB.getChannel({ id: 'id1', channel: 'custom' });
    const channelC = tabC.getChannel({ id: 'id1', channel: 'custom' });

    const lateSubscriber = vi.fn();
    channelB.subscribe(() => {
      // 在回调中订阅一个新订阅者 —— 由于快照迭代，该订阅者不应被本次 postMessage 触发
      channelC.subscribe(lateSubscriber);
    });

    channelA.postMessage('first');

    expect(lateSubscriber).not.toHaveBeenCalled();

    // 下一次 postMessage 才应触发 lateSubscriber
    channelA.postMessage('second');
    expect(lateSubscriber).toHaveBeenCalledTimes(1);
    expect(lateSubscriber).toHaveBeenCalledWith('second');
  });
});

// ===========================================================================
// 3. SessionStoreAdapter
// ===========================================================================

describe('memory-adapters / SessionStoreAdapter 合规性', () => {
  test('3.1 read / write 基础语义', () => {
    const env = createSharedMemoryEnv();
    const tab = createMemoryAdapters(env);
    const store = tab.getSessionStore({ id: 'k' });

    expect(store.read()).toBeNull();

    store.write('epoch-1');
    expect(store.read()).toBe('epoch-1');

    store.write('epoch-2');
    expect(store.read()).toBe('epoch-2');
  });

  test('3.2 Tab 独立性：两个 Tab 的 sessionScope 互不共享', () => {
    const env = createSharedMemoryEnv();
    const tabA = createMemoryAdapters(env);
    const tabB = createMemoryAdapters(env);

    const storeA = tabA.getSessionStore({ id: 'shared' });
    const storeB = tabB.getSessionStore({ id: 'shared' });

    storeA.write('tab-a-epoch');

    // TabB 不应读到 TabA 的值（对齐原生 sessionStorage 语义）
    expect(storeB.read()).toBeNull();

    storeB.write('tab-b-epoch');
    expect(storeA.read()).toBe('tab-a-epoch');
    expect(storeB.read()).toBe('tab-b-epoch');
  });

  test('3.3 按 id 分桶：同 Tab 不同 id 互不串扰', () => {
    const env = createSharedMemoryEnv();
    const tab = createMemoryAdapters(env);

    const storeAlpha = tab.getSessionStore({ id: 'alpha' });
    const storeBeta = tab.getSessionStore({ id: 'beta' });

    storeAlpha.write('alpha-value');
    expect(storeBeta.read()).toBeNull();

    storeBeta.write('beta-value');
    expect(storeAlpha.read()).toBe('alpha-value');
    expect(storeBeta.read()).toBe('beta-value');
  });
});
