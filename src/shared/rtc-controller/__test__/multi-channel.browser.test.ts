/**
 * 多 DataChannel 场景测试
 *
 * 覆盖 RFC-multi-channel.md 中新增的 API：
 * - createDataChannel 自动注册到 channels
 * - getChannel / getChannelLabels 查询
 * - send(label, data) 定向发送
 * - emitTo(label, event, payload) 定向事件
 * - 通道关闭后自动移除
 * - dispose 后 channels 清空
 */

import { afterEach, describe, expect, test } from 'vitest';
import { createRtcController } from '../index';
import type { RtcController } from '../types';
import { createMockSignalingPair } from './helpers/mock-signaling';

/** 默认通道 label，与 constants.ts 中 DEFAULT_DATA_CHANNEL_LABEL 保持一致 */
const DEFAULT_LABEL = 'lingshu-rtc';

/** 等待控制器进入指定 phase，超时 5s */
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

/** 等待指定 label 的通道就绪（先检查已注册，再监听事件） */
function waitForChannel(controller: RtcController, label: string): Promise<void> {
  // 通道可能在 connect 过程中已 open，先检查
  if (controller.getChannel(label)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for channel "${label}"`)), 5000);
    const off = controller.on('data-channel-ready', (event) => {
      if (event.label === label) {
        clearTimeout(timeout);
        off();
        resolve();
      }
    });
  });
}

describe('多 DataChannel 支持', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('getChannel() 无参返回默认通道', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    // 在 connect 之前注册监听，避免错过 data-channel-ready 事件
    const channelReady = waitForChannel(controllerA, DEFAULT_LABEL);
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    const defaultChannel = controllerA.getChannel();
    expect(defaultChannel).toBeDefined();
    expect(defaultChannel!.label).toBe(DEFAULT_LABEL);
  });

  test('getChannel() 未连接时返回 undefined', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });
    expect(controllerA.getChannel()).toBeUndefined();
  });

  test('getChannel(label) 查找不存在的通道返回 undefined', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    expect(controllerA.getChannel('nonexistent')).toBeUndefined();
  });

  test('createDataChannel 创建的通道自动注册到 channels', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const channelReady = waitForChannel(controllerA, DEFAULT_LABEL);
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    // 创建额外通道
    controllerA.createDataChannel('file-transfer');
    await waitForChannel(controllerA, 'file-transfer');

    expect(controllerA.getChannel('file-transfer')).toBeDefined();
    expect(controllerA.getChannel('file-transfer')!.label).toBe('file-transfer');
  });

  test('getChannelLabels 返回所有已注册通道的 label', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const channelReady = waitForChannel(controllerA, DEFAULT_LABEL);
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    controllerA.createDataChannel('chat');
    await waitForChannel(controllerA, 'chat');

    const labels = controllerA.getChannelLabels();
    expect(labels).toContain(DEFAULT_LABEL);
    expect(labels).toContain('chat');
    expect(labels.length).toBe(2);
  });

  test('send(label, data) 通过指定通道发送', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const channelReady = waitForChannel(controllerA, DEFAULT_LABEL);
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    // A 创建额外通道
    controllerA.createDataChannel('extra');
    await waitForChannel(controllerA, 'extra');

    // B 等待收到 extra 通道
    await waitForChannel(controllerB, 'extra');

    // B 监听 extra 通道的 raw-message
    const received: unknown[] = [];
    controllerB.on('raw-message', ({ data, channel }) => {
      if (channel.label === 'extra') {
        received.push(data);
      }
    });

    // A 通过 extra 通道发送
    controllerA.send('extra', 'hello-via-extra');

    // 等待消息到达
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 3000);
    });

    expect(received).toContain('hello-via-extra');
  });

  test('send(label, data) label 不存在时抛错', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    expect(() => controllerA!.send('nonexistent', 'data')).toThrow();
  });

  test('emitTo 通过指定通道发送自定义事件', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    interface TestEvents {
      greeting: string;
    }
    const typedA = createRtcController<TestEvents>({ signaling: sigA, connectTimeout: 10_000 });
    const typedB = createRtcController<TestEvents>({ signaling: sigB, connectTimeout: 10_000 });
    controllerA = typedA;
    controllerB = typedB;

    const channelReady = waitForChannel(typedA, DEFAULT_LABEL);
    await Promise.all([typedA.connect(), waitForPhase(typedB, 'connected')]);
    await channelReady;

    // A 创建额外通道
    typedA.createDataChannel('events');
    await waitForChannel(typedA, 'events');
    await waitForChannel(typedB, 'events');

    // B 监听自定义事件
    const receivedPayloads: string[] = [];
    typedB.on('greeting', (payload) => {
      receivedPayloads.push(payload);
    });

    // A 通过 events 通道发送自定义事件
    typedA.emitTo('events', 'greeting', 'hi from events channel');

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (receivedPayloads.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 3000);
    });

    expect(receivedPayloads).toContain('hi from events channel');
  });

  test('dispose 后 channels 清空，getChannelLabels 返回空', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const channelReady = waitForChannel(controllerA, DEFAULT_LABEL);
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    controllerA.createDataChannel('temp');
    await waitForChannel(controllerA, 'temp');

    expect(controllerA.getChannelLabels().length).toBeGreaterThan(0);

    controllerA.dispose();
    expect(controllerA.getChannelLabels()).toEqual([]);
    controllerA = null;
  });
});
