/**
 * Browser 环境集成测试 — 完整 offer/answer 流程
 *
 * 使用真实的 RTCPeerConnection API（Chromium 提供）
 * 覆盖：创建控制器 → connect → 事件监听 → 数据通道收发 → dispose
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRtcController } from '../index';
import type { RtcController } from '../types';
import { createMockSignalingPair } from './helpers/mock-signaling';

/** 等待控制器进入指定 phase，超时 5s 防止挂死 */
function waitForPhase(controller: RtcController, phase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (controller.phase === phase) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for phase "${phase}"`)), 5000);
    const off = controller.on('phase-change', (event) => {
      if (event.phase === phase) {
        clearTimeout(timeout);
        off();
        resolve();
      }
    });
  });
}

describe('createRtcController 集成测试', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('初始 phase 应该是 idle', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });
    expect(controllerA.phase).toBe('idle');
  });

  test('初始 peerConnection 应该是 null', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });
    expect(controllerA.peerConnection).toBeNull();
  });

  test('完整的 P2P 连接流程（offerer + answerer）', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const phaseChangesA: string[] = [];
    controllerA.on('phase-change', (event) => phaseChangesA.push(event.phase));

    // A 发起连接（offerer），B 自动响应（answerer）
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    expect(controllerA.phase).toBe('connected');
    expect(controllerB.phase).toBe('connected');
    expect(controllerA.peerConnection).not.toBeNull();
    expect(controllerB.peerConnection).not.toBeNull();

    // 验证 phase 变化历程（至少包含 signaling → connecting → connected）
    expect(phaseChangesA).toContain('signaling');
    expect(phaseChangesA).toContain('connecting');
    expect(phaseChangesA).toContain('connected');
  });

  test('连接后可以通过 DataChannel 收发原始数据', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    // 等待 B 侧 data-channel-ready（事件驱动，无需 setTimeout）
    await new Promise<void>((resolve) => {
      const off = controllerB!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    const received = new Promise<unknown>((resolve) => {
      controllerB!.on('raw-message', (event) => resolve(event.data));
    });

    controllerA.send('hello from A');
    const data = await received;
    expect(data).toBe('hello from A');
  });

  test('连接后可以通过 emit 收发自定义事件', async () => {
    interface TestEvents {
      greeting: { message: string };
    }

    const [sigA, sigB] = createMockSignalingPair();

    const _controllerA = createRtcController<TestEvents>({ signaling: sigA, connectTimeout: 10_000 });
    controllerA = _controllerA;
    const _controllerB = createRtcController<TestEvents>({ signaling: sigB, connectTimeout: 10_000 });
    controllerB = _controllerB;

    await Promise.all([_controllerA.connect(), waitForPhase(_controllerB, 'connected')]);

    // 等待 B 侧 data-channel-ready（事件驱动，无需 setTimeout）
    await new Promise<void>((resolve) => {
      const off = _controllerB.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    const received = new Promise<{ message: string }>((resolve) => {
      _controllerB!.on('greeting', (greetingPayload) => resolve(greetingPayload));
    });

    _controllerA.emit('greeting', { message: 'hello from A' });
    const greetingResult = await received;
    expect(greetingResult).toEqual({ message: 'hello from A' });
  });

  test('dispose 后 phase 应该变为 closed', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    const closedPromise = new Promise<void>((resolve) => {
      controllerA!.on('closed', () => resolve());
    });

    controllerA.dispose();
    await closedPromise;

    expect(controllerA.phase).toBe('closed');
    expect(controllerA.peerConnection).toBeNull();
  });

  test('dispose 应该是幂等的（多次调用不报错）', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    controllerA.dispose();
    controllerA.dispose();
    controllerA.dispose();

    expect(controllerA.phase).toBe('closed');
  });

  test('dispose 后调用 connect 应该抛出 RtcDisposedError', async () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });
    controllerA.dispose();

    await expect(controllerA.connect()).rejects.toThrow(/dispose/u);
  });

  test('AbortSignal 已 aborted 时应该立即 dispose', () => {
    const [sigA] = createMockSignalingPair();
    const abortController = new AbortController();
    abortController.abort();

    controllerA = createRtcController({ signaling: sigA, signal: abortController.signal });
    expect(controllerA.phase).toBe('closed');
  });

  test('AbortSignal abort 后应该触发 dispose', async () => {
    const [sigA] = createMockSignalingPair();
    const abortController = new AbortController();

    controllerA = createRtcController({ signaling: sigA, signal: abortController.signal });
    expect(controllerA.phase).toBe('idle');

    const closedPromise = new Promise<void>((resolve) => {
      controllerA!.on('closed', () => resolve());
    });

    abortController.abort();
    await closedPromise;

    expect(controllerA.phase).toBe('closed');
  });

  test('on 应该返回取消订阅函数', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    const handler = vi.fn();
    const off = controllerA.on('closed', handler);

    expect(off).toBeTypeOf('function');
    off();

    controllerA.dispose();
    expect(handler).not.toHaveBeenCalled();
  });

  test('once 应该只触发一次', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const phaseHandler = vi.fn();
    controllerA.once('phase-change', phaseHandler);

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    // phase-change 会触发多次（signaling → connecting → connected），但 once 只会收到第一次
    expect(phaseHandler).toHaveBeenCalledTimes(1);
  });

  test('createDataChannel 应该创建新的数据通道', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    const channel = controllerA.createDataChannel('custom-channel');
    expect(channel).toBeInstanceOf(RTCDataChannel);
    expect(channel.label).toBe('custom-channel');
  });

  test('getStats 应该返回 RTCStatsReport', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    const stats = await controllerA.getStats();
    expect(stats).toBeInstanceOf(RTCStatsReport);
  });

  test('emit 内置事件名应该被忽略（不抛错）', async () => {
    interface BadEvents {
      connected: { fake: true };
    }

    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController<BadEvents>({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    // 等待 data channel 就绪（事件驱动）
    await new Promise<void>((resolve) => {
      const off = controllerA!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    // 不应该抛错，只是被忽略并 logger.warn
    // @ts-expect-error
    expect(() => controllerA!.emit('connected' as keyof BadEvents, { fake: true })).not.toThrow();
  });
});
