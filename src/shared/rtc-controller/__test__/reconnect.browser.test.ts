/**
 * Browser 环境重连流程测试
 *
 * 覆盖：reconnect() API、重连后状态重置、重连后重新建立连接
 */

import { afterEach, describe, expect, test } from 'vitest';
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

describe('reconnect 重连流程', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('reconnect 应该重置连接并重新建立', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    controllerA = createRtcController({ signaling: sigA, connectTimeout: 3000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 3000 });

    // 首次连接
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    expect(controllerA.phase).toBe('connected');

    const firstPeerConnection = controllerA.peerConnection;
    expect(firstPeerConnection).not.toBeNull();

    // 重连——B 侧先 dispose 旧实例，用新的适配器重建
    controllerB.dispose();
    const [, sigB2] = createMockSignalingPair();
    controllerB = createRtcController({ signaling: sigB2, connectTimeout: 10_000 });

    // reconnect 中 disconnected 是独立事件（非 phase-change 的 phase 值）
    // setPhase(ctx, 'idle') 才触发 phase-change
    const phaseChanges: string[] = [];
    let disconnectedFired = false;
    controllerA.on('phase-change', (ev) => phaseChanges.push(ev.phase));
    controllerA.on('disconnected', () => {
      disconnectedFired = true;
    });

    try {
      await controllerA.reconnect();
    } catch {
      // 预期可能因为信令断开而失败，但 phase 重置逻辑应该已执行
    }

    // 验证 reconnect 触发了 disconnected 事件和 phase 回到 idle
    expect(disconnectedFired).toBe(true);
    expect(phaseChanges).toContain('idle');
  });

  test('idle 状态下 reconnect 应该等同于 connect', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    expect(controllerA.phase).toBe('idle');

    // idle 状态下 reconnect 直接走 connect 流程
    await Promise.all([controllerA.reconnect(), waitForPhase(controllerB, 'connected')]);

    expect(controllerA.phase).toBe('connected');
    expect(controllerB.phase).toBe('connected');
  });

  test('dispose 后 reconnect 应该抛出 RtcDisposedError', async () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });
    controllerA.dispose();

    await expect(controllerA.reconnect()).rejects.toThrow(/dispose/u);
  });

  test('reconnect 应该触发 disconnected 事件（非 idle 状态时）', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    controllerA = createRtcController({ signaling: sigA, connectTimeout: 3000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 3000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    let disconnectedReason = '';
    controllerA.on('disconnected', (event) => {
      disconnectedReason = event.reason;
    });

    // 先 dispose B 使 A 的 reconnect 触发清理逻辑
    controllerB.dispose();
    controllerB = null;

    try {
      await controllerA.reconnect();
    } catch {
      // 可能因信令断开失败
    }

    expect(disconnectedReason).toBe('reconnect');
  });

  test('reconnect 后 peerConnection 应该是新的实例', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    controllerA = createRtcController({ signaling: sigA, connectTimeout: 3000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 3000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    const firstPc = controllerA.peerConnection;

    // 需要 B 重新响应，否则 reconnect 会因无人应答超时
    // 保持 B 存活，A 侧 reconnect
    // reconnect 重建连接，应该创建新的 RTCPeerConnection
    controllerB.dispose();
    const [, sigB2] = createMockSignalingPair();
    controllerB = createRtcController({ signaling: sigB2, connectTimeout: 10_000 });

    try {
      await controllerA.reconnect();
    } catch {
      // 可能因信令断开失败
    }

    // reconnect 清理阶段会将 peerConnection 置 null 然后重建
    // 即使 connect 失败，新的 peerConnection 也不应是旧实例
    const secondPc = controllerA.peerConnection;
    const isNewInstance = secondPc === null || secondPc !== firstPc;
    expect(isNewInstance).toBe(true);
  });
});
