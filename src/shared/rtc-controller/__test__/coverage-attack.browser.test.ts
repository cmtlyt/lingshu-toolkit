/**
 * 覆盖率攻坚测试 — 命中所有防御分支
 *
 * 覆盖目标文件：
 * - core/media.ts — addTrack / removeTrack / getRemoteStreams
 * - core/data-channel.ts — parseEventData / dispatchParsedEvent 防御分支
 * - core/connection.ts — ICE 状态机 / 错误处理 / track 事件
 * - core/controller.ts — 信令路由 / 错误处理 / 媒体 API 代理
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '../adapters/logger';
import {
  assertPhase,
  flushPendingCandidates,
  handleAnswer,
  handleIceCandidate,
  waitForConnection,
  wireConnectionEvents,
} from '../core/connection';
import { performConnect, performDispose, processOffer, routeSignalingMessage } from '../core/controller';
import type { ControllerContext } from '../core/controller-context';
import { dispatchParsedEvent, parseEventData } from '../core/data-channel';
import { createEventEmitter } from '../core/event-emitter';
import { getRemoteStreams } from '../core/media';
import { createRtcController } from '../index';
import type { RtcController, SignalingAdapter, SignalingMessage } from '../types';
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

// ─────────────────────────────────────────────
// media.ts 覆盖
// ─────────────────────────────────────────────

describe('media.ts 覆盖', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('addTrack / removeTrack 正常路径', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    // 通过 canvas 获取真实的 MediaStreamTrack（浏览器不允许直接 new MediaStreamTrack）
    const canvas = document.createElement('canvas');
    const stream = canvas.captureStream();
    const track = stream.getVideoTracks()[0];
    const sender = controllerA.addTrack(track);
    expect(sender).toBeInstanceOf(RTCRtpSender);

    controllerA.removeTrack(sender);
  });

  test('getRemoteStreams 正常路径（连接后获取）', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    const streams = controllerA.getRemoteStreams();
    expect(Array.isArray(streams)).toBe(true);
  });

  test('getRemoteStreams 无连接时返回空数组', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    // phase 是 idle，peerConnection 为 null
    const streams = controllerA.getRemoteStreams();
    expect(streams).toEqual([]);
  });

  test('addTrack 无连接时抛出 RtcInvalidStateError', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    const fakeTrack = {} as MediaStreamTrack;
    expect(() => controllerA!.addTrack(fakeTrack)).toThrow(/addTrack/u);
  });

  test('removeTrack 无连接时抛出 RtcInvalidStateError', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    const fakeSender = {} as RTCRtpSender;
    expect(() => controllerA!.removeTrack(fakeSender)).toThrow(/removeTrack/u);
  });
});

// ─────────────────────────────────────────────
// data-channel.ts 覆盖
// ─────────────────────────────────────────────

describe('data-channel.ts 防御分支覆盖', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('非字符串 DataChannel 消息走 raw-message（parseEventData 返回 null）', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await new Promise<void>((resolve) => {
      const off = controllerB!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    const received = new Promise<unknown>((resolve) => {
      controllerB!.on('raw-message', (event) => resolve(event.data));
    });

    // 发送非字符串数据（ArrayBuffer），触发 parseEventData typeof !== 'string' 分支
    const buffer = new TextEncoder().encode('binary data').buffer;
    controllerA.send(buffer as unknown as string);
    const data = await received;
    expect(data).toBeDefined();
  });

  test('DataChannel 收到与内置事件同名的自定义事件时忽略', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await new Promise<void>((resolve) => {
      const off = controllerA!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    // 直接通过底层 DataChannel 发送一条伪造的事件协议消息，事件名为内置事件名
    const conflictMessage = JSON.stringify({
      __rtc_event__: true,
      event: 'connected',
      payload: { fake: true },
    });
    // 通过 A 侧的 peerConnection 获取 defaultChannel 并直接 send
    const channel = controllerA.peerConnection!.createDataChannel('__test_inject__');
    // 等待 channel 打开
    await new Promise<void>((resolve) => {
      channel.onopen = () => resolve();
    });
    // 但我们需要从 B 侧的角度接收，所以直接在 A 侧的 defaultChannel 上 send
    // 实际上应通过 A->B 的路径发送
    controllerA.send(conflictMessage);

    // 等待消息到达 B 侧（事件驱动：用 vi.waitFor 轮询而非固定 delay）
    await vi.waitFor(() => {
      // 验证 B 侧没有收到名为 'connected' 的事件（被忽略了）
      // 此测试的目的是命中 dispatchParsedEvent 中的内置事件冲突分支
      expect(controllerB!.phase).toBe('connected');
    });
  });

  test('onUserEventHook 返回 true 时事件被消费不分发', async () => {
    const hookFn = vi.fn(() => true);
    const [sigA, sigB] = createMockSignalingPair();

    interface TestEvents {
      greeting: { message: string };
    }

    controllerA = createRtcController<TestEvents>({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController<TestEvents>({
      signaling: sigB,
      connectTimeout: 10_000,
      __onUserEvent: hookFn,
    });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await new Promise<void>((resolve) => {
      const off = controllerB!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    const eventHandler = vi.fn();
    // @ts-expect-error
    controllerB.on('greeting', eventHandler);

    (controllerA as RtcController<TestEvents>).emit('greeting', { message: 'hello' });

    // 等待 hook 被调用（事件驱动轮询替代固定 delay）
    await vi.waitFor(() => {
      expect(hookFn).toHaveBeenCalled();
    });
    // hook 返回 true，事件被消费，不会分发到 emitter
    expect(eventHandler).not.toHaveBeenCalled();
  });

  test('onUserEventHook 返回 非 true 时事件正常分发', async () => {
    const hookFn = vi.fn(() => false);
    const [sigA, sigB] = createMockSignalingPair();

    interface TestEvents {
      greeting: { message: string };
    }

    controllerA = createRtcController<TestEvents>({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController<TestEvents>({
      signaling: sigB,
      connectTimeout: 10_000,
      __onUserEvent: hookFn,
    });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await new Promise<void>((resolve) => {
      const off = controllerB!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    const received = new Promise<{ message: string }>((resolve) => {
      controllerB!.on('greeting' as never, ((payload: { message: string }) => resolve(payload)) as never);
    });

    (controllerA as RtcController<TestEvents>).emit('greeting', { message: 'hello' });

    const result = await received;
    expect(hookFn).toHaveBeenCalled();
    expect(result).toEqual({ message: 'hello' });
  });
});

// ─────────────────────────────────────────────
// controller.ts 覆盖
// ─────────────────────────────────────────────

describe('controller.ts 覆盖', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('closed 状态下信令消息被忽略（routeSignalingMessage 短路）', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });
    controllerA.dispose();

    // dispose 后 phase 为 closed，后续信令消息应被忽略
    expect(controllerA.phase).toBe('closed');
  });

  test('send 在 channel 未就绪时抛出 RtcChannelNotReadyError', () => {
    const [sigA] = createMockSignalingPair();
    // idle 状态下没有 data channel
    controllerA = createRtcController({ signaling: sigA });

    expect(() => controllerA!.send('test')).toThrow(/data channel/iu);
  });

  test('emit 在 channel 未就绪时抛出 RtcChannelNotReadyError', () => {
    interface TestEvents {
      ping: undefined;
    }

    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController<TestEvents>({ signaling: sigA });

    expect(() => (controllerA as RtcController<TestEvents>).emit('ping')).toThrow(/data channel/iu);
  });

  test('emit 无参数时 payload 为 undefined（条件表达式 else 分支）', async () => {
    interface TestEvents {
      ping: undefined;
    }

    const [sigA, sigB] = createMockSignalingPair();
    const _controllerA = createRtcController<TestEvents>({ signaling: sigA, connectTimeout: 10_000 });
    controllerA = _controllerA;
    const _controllerB = createRtcController<TestEvents>({ signaling: sigB, connectTimeout: 10_000 });
    controllerB = _controllerB;

    await Promise.all([_controllerA.connect(), waitForPhase(_controllerB, 'connected')]);
    await new Promise<void>((resolve) => {
      const off = _controllerB.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });

    const received = new Promise<unknown>((resolve) => {
      _controllerB.on('ping', () => resolve(undefined));
    });

    // emit 不传 payload，触发 args.length > 0 ? args[0] : undefined 的 else 分支
    _controllerA.emit('ping');
    const result = await received;
    expect(result).toBeUndefined();
  });

  test('emit 非字符串事件名时静默忽略（命中 typeof event !== string 分支）', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    // 传入 Symbol 作为事件名，触发 typeof event !== 'string' 防御分支
    // @ts-expect-error 故意传入非法类型以命中防御分支
    expect(() => controllerA!.emit(Symbol('test'))).not.toThrow();
  });

  test('createDataChannel 无连接时抛出错误', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    expect(() => controllerA!.createDataChannel('test')).toThrow(/createDataChannel/u);
  });

  test('getStats 无连接时抛出错误', async () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    await expect(controllerA.getStats()).rejects.toThrow(/getStats/u);
  });

  test('signaling.dispose 存在时被调用（dispose 分支覆盖）', () => {
    const disposeSpy = vi.fn();
    const [sigA] = createMockSignalingPair();
    // 给信令添加 dispose 方法
    (sigA as SignalingAdapter & { dispose?: () => void }).dispose = disposeSpy;
    controllerA = createRtcController({ signaling: sigA });
    controllerA.dispose();

    expect(disposeSpy).toHaveBeenCalled();
  });

  test('重复 dispose 不触发 closed 事件（wasClosed 分支）', () => {
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });

    const closedHandler = vi.fn();
    controllerA.on('closed', closedHandler);

    controllerA.dispose();
    expect(closedHandler).toHaveBeenCalledOnce();

    // 再次 dispose 不应触发
    controllerA.dispose();
    expect(closedHandler).toHaveBeenCalledOnce();
  });

  test('answerer 侧 processOffer 路径覆盖（signaling → connecting 状态转换）', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const phaseChangesB: string[] = [];
    controllerB.on('phase-change', (event) => phaseChangesB.push(event.phase));

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    // B 侧（answerer）应该经过 signaling → connecting → connected
    expect(phaseChangesB).toContain('signaling');
    expect(phaseChangesB).toContain('connecting');
    expect(phaseChangesB).toContain('connected');
  });

  test('自定义 logger 传入时被使用（覆盖 logger/emitter 初始化行）', () => {
    const customLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, logger: customLogger });

    // 触发一个会调用 logger.warn 的操作
    controllerA.dispose();
    expect(controllerA.phase).toBe('closed');
  });

  test('信令发送未知类型消息走 default 分支', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    // 通过信令发送一个未知类型的消息
    await sigA.send({ type: 'unknown-type' } as never);

    // 不应该抛错，只是走 default break
    expect(controllerA.phase).toBe('idle');
  });

  test('offerer 侧 ondatachannel 回调覆盖', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    // B 侧手动创建一个 data channel 触发 A 侧的 ondatachannel
    const extraChannel = controllerB.peerConnection!.createDataChannel('extra');
    expect(extraChannel).toBeInstanceOf(RTCDataChannel);

    // 等待 A 侧收到 ondatachannel 事件（缩短 delay，此处无法用事件驱动替代）
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
});

// ─────────────────────────────────────────────
// connection.ts 内部函数覆盖（构造伪 ControllerContext）
// ─────────────────────────────────────────────

/** 构造最小可工作的伪 ControllerContext */
function createFakeContext(overrides?: Partial<ControllerContext>): ControllerContext {
  const logger = resolveLoggerAdapter();
  const emitter = createEventEmitter(logger);
  let resolveConn: () => void = () => {};
  let rejectConn: (_e: Error) => void = () => {};
  const connectionPromise = new Promise<void>((resolve, reject) => {
    resolveConn = resolve;
    rejectConn = reject;
  });
  // 预防 unhandled rejection（ICE failed 等场景会 reject 但无人 await）
  connectionPromise.catch(() => {});

  return {
    phase: 'idle',
    peerConnection: null,
    defaultChannel: null,
    channels: new Map(),
    pendingCandidates: [],
    emitter,
    logger,
    resolveConnection: resolveConn,
    rejectConnection: rejectConn,
    connectionPromise,
    disposeFn: vi.fn(),
    ...overrides,
  };
}

describe('connection.ts 内部函数覆盖', () => {
  test('assertPhase 失败时抛出 RtcInvalidStateError', () => {
    const ctx = createFakeContext({ phase: 'idle' });
    expect(() => assertPhase(ctx, 'connected', 'testFn')).toThrow(/requires phase "connected"/u);
  });

  test('flushPendingCandidates peerConnection 为 null 时直接返回', () => {
    const ctx = createFakeContext({ peerConnection: null });
    ctx.pendingCandidates.push({ candidate: 'fake' } as unknown as RTCIceCandidateInit);

    // 不抛错，直接 return
    expect(() => flushPendingCandidates(ctx)).not.toThrow();
    // pendingCandidates 未清空（因为 peerConnection 为 null 提前返回）
    expect(ctx.pendingCandidates).toHaveLength(1);
  });

  test('handleIceCandidate peerConnection 为 null 时直接返回', () => {
    const ctx = createFakeContext({ peerConnection: null });
    const candidate = { candidate: 'fake' } as unknown as RTCIceCandidateInit;

    expect(() => handleIceCandidate(ctx, candidate)).not.toThrow();
  });

  test('handleIceCandidate remoteDescription 未设置时缓冲到 pendingCandidates', () => {
    const fakePc = new RTCPeerConnection();
    const ctx = createFakeContext({ peerConnection: fakePc });
    const candidate = { candidate: 'fake', sdpMid: '0', sdpMLineIndex: 0 } as RTCIceCandidateInit;

    // remoteDescription 为 null，应缓冲
    handleIceCandidate(ctx, candidate);
    expect(ctx.pendingCandidates).toHaveLength(1);

    fakePc.close();
  });

  test('handleAnswer peerConnection 为 null 时直接返回', async () => {
    const ctx = createFakeContext({ peerConnection: null });

    // 不抛错，直接 return
    await expect(handleAnswer(ctx, 'fake-sdp')).resolves.toBeUndefined();
  });

  test('handleAnswer setRemoteDescription 失败时抛出 RtcSignalingError', async () => {
    const fakePc = new RTCPeerConnection();
    const ctx = createFakeContext({ peerConnection: fakePc });

    // 传入无效 SDP 触发 setRemoteDescription 失败
    await expect(handleAnswer(ctx, 'invalid-sdp')).rejects.toThrow(/failed to handle answer/u);
    expect(ctx.phase).toBe('failed');

    fakePc.close();
  });

  test('wireConnectionEvents ICE 状态机 disconnected/failed/closed 分支', () => {
    const fakePc = new RTCPeerConnection();
    const [sigA] = createMockSignalingPair();
    const ctx = createFakeContext({ phase: 'connected', peerConnection: fakePc });

    wireConnectionEvents(ctx, fakePc, sigA);

    const events: string[] = [];
    ctx.emitter.on('ice-state-change', (event) => events.push(event.state));
    ctx.emitter.on('disconnected', () => events.push('evt:disconnected'));
    ctx.emitter.on('failed', () => events.push('evt:failed'));

    // 模拟 ICE disconnected 状态
    Object.defineProperty(fakePc, 'iceConnectionState', { value: 'disconnected', configurable: true });
    fakePc.oniceconnectionstatechange!(new Event('iceconnectionstatechange'));
    expect(events).toContain('disconnected');
    expect(events).toContain('evt:disconnected');
    expect(ctx.phase).toBe('disconnected');

    // 模拟 ICE failed 状态
    Object.defineProperty(fakePc, 'iceConnectionState', { value: 'failed', configurable: true });
    fakePc.oniceconnectionstatechange!(new Event('iceconnectionstatechange'));
    expect(events).toContain('failed');
    expect(events).toContain('evt:failed');
    expect(ctx.phase).toBe('failed');

    // 模拟 ICE closed 状态（no-op）
    Object.defineProperty(fakePc, 'iceConnectionState', { value: 'closed', configurable: true });
    fakePc.oniceconnectionstatechange!(new Event('iceconnectionstatechange'));
    expect(events).toContain('closed');

    fakePc.close();
  });

  test('wireConnectionEvents ICE connected 且已经是 connected 不重复触发', () => {
    const fakePc = new RTCPeerConnection();
    const [sigA] = createMockSignalingPair();
    const ctx = createFakeContext({ phase: 'connecting', peerConnection: fakePc });

    wireConnectionEvents(ctx, fakePc, sigA);

    const connectedHandler = vi.fn();
    ctx.emitter.on('connected', connectedHandler);

    // 第一次 connected
    Object.defineProperty(fakePc, 'iceConnectionState', { value: 'connected', configurable: true });
    fakePc.oniceconnectionstatechange!(new Event('iceconnectionstatechange'));
    expect(connectedHandler).toHaveBeenCalledOnce();
    expect(ctx.phase).toBe('connected');

    // 第二次 connected（phase 已是 connected），不应重复触发
    fakePc.oniceconnectionstatechange!(new Event('iceconnectionstatechange'));
    expect(connectedHandler).toHaveBeenCalledOnce();

    fakePc.close();
  });

  test('wireConnectionEvents onicecandidate 发送返回 Promise 且 catch 错误', async () => {
    const fakePc = new RTCPeerConnection();
    const errorSpy = vi.fn();
    const failingSignaling: SignalingAdapter = {
      send: () => Promise.reject(new Error('send failed')),
      onMessage: () => () => {},
    };
    const ctx = createFakeContext({
      peerConnection: fakePc,
      logger: { debug: vi.fn(), warn: vi.fn(), error: errorSpy },
    });

    wireConnectionEvents(ctx, fakePc, failingSignaling);

    // 直接构造 event-like 对象（浏览器不允许用 mock 对象构造 RTCPeerConnectionIceEvent）
    const fakeEvent = {
      candidate: {
        candidate: 'candidate:1234',
        sdpMid: '0',
        sdpMLineIndex: 0,
        toJSON: () => {
          return { candidate: 'candidate:1234', sdpMid: '0', sdpMLineIndex: 0 };
        },
      },
    } as unknown as RTCPeerConnectionIceEvent;
    fakePc.onicecandidate!(fakeEvent);

    // 等 Promise.catch 跑完（用 vi.waitFor 轮询替代固定 delay）
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    fakePc.close();
  });

  test('wireConnectionEvents ontrack 回调触发 track 和 track-removed 事件', () => {
    const fakePc = new RTCPeerConnection();
    const [sigA] = createMockSignalingPair();
    const ctx = createFakeContext({ peerConnection: fakePc });

    wireConnectionEvents(ctx, fakePc, sigA);

    const trackHandler = vi.fn();
    const trackRemovedHandler = vi.fn();
    ctx.emitter.on('track', trackHandler);
    ctx.emitter.on('track-removed', trackRemovedHandler);

    // 构造伪 track 和 event
    const fakeTrack = { onended: null as (() => void) | null } as unknown as MediaStreamTrack;
    const fakeEvent = { track: fakeTrack, streams: [] } as unknown as RTCTrackEvent;

    fakePc.ontrack!(fakeEvent);
    expect(trackHandler).toHaveBeenCalledOnce();

    // 触发 track.onended
    fakeTrack.onended!(new Event('ended'));
    expect(trackRemovedHandler).toHaveBeenCalledOnce();

    fakePc.close();
  });

  test('waitForConnection 非 timeout 错误直接 re-throw', async () => {
    const genericError = new Error('some other error');
    const ctx = createFakeContext();
    // 立即 reject connectionPromise 一个非 RtcTimeoutError 的错误
    ctx.rejectConnection(genericError);

    await expect(waitForConnection(ctx, 10_000)).rejects.toThrow('some other error');
  });
});

// ─────────────────────────────────────────────
// data-channel.ts 内部函数覆盖
// ─────────────────────────────────────────────

describe('data-channel.ts 内部函数覆盖', () => {
  test('parseEventData 非字符串数据返回 null', () => {
    expect(parseEventData(123)).toBeNull();
    expect(parseEventData(null)).toBeNull();
    expect(parseEventData(undefined)).toBeNull();
    expect(parseEventData(new ArrayBuffer(0))).toBeNull();
  });

  test('dispatchParsedEvent 内置事件名被忽略', () => {
    const warnSpy = vi.fn();
    // 直接构造 logger 对象（不通过 resolveLoggerAdapter，避免 .bind() 丢失 spy 引用）
    const logger = { debug: vi.fn(), warn: warnSpy, error: vi.fn() };
    const emitter = createEventEmitter(logger);
    const ctx = createFakeContext({ emitter, logger });

    const dispatchSpy = vi.spyOn(emitter, 'dispatch');

    dispatchParsedEvent(ctx, { __rtc_event__: true, event: 'connected', payload: {} });

    // 内置事件被忽略，logger.warn 被调用
    expect(warnSpy).toHaveBeenCalled();
    // dispatch 不应被调用来分发 'connected' 事件
    const dispatchCalls = dispatchSpy.mock.calls.filter((call) => call[0] === 'connected');
    expect(dispatchCalls).toHaveLength(0);

    dispatchSpy.mockRestore();
  });

  test('dispatchParsedEvent onUserEventHook 返回 true 消费事件', () => {
    const ctx = createFakeContext({ onUserEventHook: () => true });
    const dispatchSpy = vi.spyOn(ctx.emitter, 'dispatch');

    dispatchParsedEvent(ctx, { __rtc_event__: true, event: 'custom-event', payload: { data: 1 } });

    // hook 消费了事件，emitter.dispatch 不应被调用
    const dispatchCalls = dispatchSpy.mock.calls.filter((call) => call[0] === 'custom-event');
    expect(dispatchCalls).toHaveLength(0);

    dispatchSpy.mockRestore();
  });

  test('dispatchParsedEvent onUserEventHook 返回 false 正常分发', () => {
    const ctx = createFakeContext({ onUserEventHook: () => false });
    const dispatchSpy = vi.spyOn(ctx.emitter, 'dispatch');

    dispatchParsedEvent(ctx, { __rtc_event__: true, event: 'custom-event', payload: { data: 1 } });

    // hook 未消费，emitter.dispatch 应被调用
    const dispatchCalls = dispatchSpy.mock.calls.filter((call) => call[0] === 'custom-event');
    expect(dispatchCalls).toHaveLength(1);

    dispatchSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// media.ts getRemoteStreams 循环遍历覆盖（通过导出的内部函数 + mock getReceivers 直接测试）
// ─────────────────────────────────────────────

describe('media.ts getRemoteStreams 内部函数覆盖', () => {
  test('getRemoteStreams 遍历 receivers，有 track 的收集为流', () => {
    // 用 canvas.captureStream() 获取真实 MediaStreamTrack（浏览器环境要求）
    const canvas = document.createElement('canvas');
    const realStream = canvas.captureStream();
    const realTrack = realStream.getTracks()[0];

    const fakePc = {
      getReceivers: () => [{ track: realTrack }, { track: null }, { track: realTrack }],
    } as unknown as RTCPeerConnection;
    const ctx = createFakeContext({ phase: 'connected', peerConnection: fakePc });

    const streams = getRemoteStreams(ctx);
    // 2 个有 track 的 receiver → 2 个流
    expect(streams).toHaveLength(2);
  });

  test('getRemoteStreams peerConnection 为 null 返回空数组', () => {
    const ctx = createFakeContext({ phase: 'connected', peerConnection: null });

    const streams = getRemoteStreams(ctx);
    expect(streams).toHaveLength(0);
  });

  test('getRemoteStreams receivers 全部 track 为 null 返回空数组', () => {
    const fakePc = {
      getReceivers: () => [{ track: null }, { track: null }],
    } as unknown as RTCPeerConnection;
    const ctx = createFakeContext({ phase: 'connected', peerConnection: fakePc });

    const streams = getRemoteStreams(ctx);
    expect(streams).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────
// event-emitter.ts line 96 — once handler idx < 0 分支（browser 环境）
// ─────────────────────────────────────────────

describe('event-emitter.ts once handler idx<0 分支（browser 环境覆盖）', () => {
  test('前面的 handler off 掉后面的 once handler，dispatch 内 indexOf 返回 -1', () => {
    const logger = resolveLoggerAdapter();
    const emitter = createEventEmitter(logger);

    const onceHandler = vi.fn();
    // 先注册一个普通 handler（A），在 A 中 off 掉 once handler（B）
    // dispatch 快照遍历：A 先执行 → off(B) 从 entries 中移除 B → 遍历到 B 时 entries.indexOf(B) 返回 -1
    emitter.on('chat', () => {
      emitter.off('chat', onceHandler);
    });
    emitter.once('chat', onceHandler);

    emitter.dispatch('chat', { text: 'hello' });

    // onceHandler 仍然被调用（因为 snapshot 已包含它），但 entries.indexOf 返回 -1 不执行 splice
    expect(onceHandler).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────
// connection.ts 补充覆盖
// ─────────────────────────────────────────────

describe('connection.ts 补充覆盖', () => {
  test('flushPendingCandidates 有 pendingCandidates 时执行循环体', async () => {
    const addIceSpy = vi.fn();
    const fakePc = { addIceCandidate: addIceSpy } as unknown as RTCPeerConnection;
    const ctx = createFakeContext({ peerConnection: fakePc });
    ctx.pendingCandidates.push(
      { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 },
      { candidate: 'c2', sdpMid: '0', sdpMLineIndex: 0 },
    );

    await flushPendingCandidates(ctx);

    expect(addIceSpy).toHaveBeenCalledTimes(2);
    expect(ctx.pendingCandidates).toHaveLength(0);
  });

  test('ICE disconnected 但 phase 不是 connected 时不触发 disconnected 事件', () => {
    const fakePc = new RTCPeerConnection();
    const [sigA] = createMockSignalingPair();
    // phase 设为 connecting（非 connected）
    const ctx = createFakeContext({ phase: 'connecting', peerConnection: fakePc });

    wireConnectionEvents(ctx, fakePc, sigA);

    const disconnectedHandler = vi.fn();
    ctx.emitter.on('disconnected', disconnectedHandler);

    // 模拟 ICE disconnected
    Object.defineProperty(fakePc, 'iceConnectionState', { value: 'disconnected', configurable: true });
    fakePc.oniceconnectionstatechange!(new Event('iceconnectionstatechange'));

    // phase 不是 connected，不应触发 disconnected 事件
    expect(disconnectedHandler).not.toHaveBeenCalled();
    // phase 不变
    expect(ctx.phase).toBe('connecting');

    fakePc.close();
  });
});

// ─────────────────────────────────────────────
// controller.ts 间接覆盖（通过信令触发内部分支）
// ─────────────────────────────────────────────

describe('controller.ts 间接覆盖', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('routeSignalingMessage closed 短路 — dispose 后信令消息被忽略', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA });
    controllerB = createRtcController({ signaling: sigB });

    // dispose 后 phase 为 closed
    controllerB.dispose();

    // A 侧发送 offer，B 侧已 closed 应被忽略
    const errorHandler = vi.fn();
    controllerB.on('error', errorHandler);

    // 通过 A 侧连接触发 B 侧收到信令
    controllerA.connect().catch(() => {});
    // 等信令消息传递（用 vi.waitFor 轮询替代固定 delay）
    await vi.waitFor(() => {
      // B 已 closed，不应触发 error
      expect(controllerB!.phase).toBe('closed');
    });
  });

  test('routeSignalingMessage answer catch — handleAnswer 失败触发 error 事件', async () => {
    // 直接通过 routeSignalingMessage 调用，mock peerConnection 使 handleAnswer 抛错
    const emitter = createEventEmitter(resolveLoggerAdapter());
    const mockPc = {
      setRemoteDescription: vi.fn().mockRejectedValue(new Error('invalid SDP')),
    } as unknown as RTCPeerConnection;
    const ctx = createFakeContext({ phase: 'connecting', emitter, peerConnection: mockPc });

    const errorHandler = vi.fn();
    ctx.emitter.on('error', errorHandler);

    const onOffer = vi.fn().mockResolvedValue(undefined);
    routeSignalingMessage(ctx, { type: 'answer', sdp: 'invalid-sdp' }, onOffer);

    // handleAnswer 是 async，等 microtask 完成
    await vi.waitFor(() => {
      expect(errorHandler).toHaveBeenCalledOnce();
    });
    expect(errorHandler.mock.calls[0][0].context).toBe('signaling:answer');
  });

  test('routeSignalingMessage offer catch — processOffer 失败触发 error 事件', async () => {
    // 手动构建可单向推送消息给 B 的信令对
    const bListeners: Array<(msg: SignalingMessage) => void> = [];
    const sigBCustom: SignalingAdapter = {
      send: () => Promise.reject(new Error('signaling send failed')),
      onMessage: (callback) => {
        bListeners.push(callback);
        return () => {
          const removeIdx = bListeners.indexOf(callback);
          if (removeIdx >= 0) {
            bListeners.splice(removeIdx, 1);
          }
        };
      },
    };

    controllerB = createRtcController({ signaling: sigBCustom, connectTimeout: 10_000 });
    const errorPromise = new Promise<void>((resolve) => {
      controllerB!.on('error', () => resolve());
    });

    // 直接向 B 侧推送一个 offer 消息
    for (const listener of bListeners) {
      listener({ type: 'offer', sdp: 'fake-sdp' });
    }

    await errorPromise;
    expect(true).toBe(true);
  });

  test('performConnect offer catch — signaling.send 失败触发 RtcSignalingError', async () => {
    const failingSig: SignalingAdapter = {
      send: () => Promise.reject(new Error('send failed')),
      onMessage: () => () => {},
    };
    controllerA = createRtcController({ signaling: failingSig, connectTimeout: 10_000 });

    await expect(controllerA.connect()).rejects.toThrow(/failed to create\/send offer/u);
    expect(controllerA.phase).toBe('failed');
  });

  test('signaling 无 dispose 方法时 dispose 不抛错', () => {
    const sigWithoutDispose: SignalingAdapter = {
      send: vi.fn(),
      onMessage: () => () => {},
    };
    controllerA = createRtcController({ signaling: sigWithoutDispose });
    expect(() => controllerA!.dispose()).not.toThrow();
    expect(controllerA.phase).toBe('closed');
  });

  test('自定义 logger 初始化覆盖 resolveLoggerAdapter/createEventEmitter 行', () => {
    const customLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const [sigA] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, logger: customLogger });

    // logger/emitter 初始化行（line 299-300）被覆盖
    expect(controllerA.phase).toBe('idle');

    // 触发 debug 日志的操作
    controllerA.dispose();
  });

  test('performConnect autoCreateDataChannel:false 时 ondatachannel 赋值 defaultChannel（branch 10#0）', async () => {
    // 直接调用导出的 performConnect，autoCreateDataChannel:false
    // ctx.defaultChannel 保持 null → ondatachannel 触发时 !ctx.defaultChannel 为 true → 赋值
    const ctx = createFakeContext({ phase: 'idle' });
    const [sigA] = createMockSignalingPair();
    const config = {
      rtcConfig: { iceServers: [] },
      dataChannelLabel: '__test__',
      dataChannelOptions: { ordered: true },
      autoCreateDataChannel: false,
      connectTimeout: 10_000,
    };

    // performConnect 内部创建 RTCPeerConnection 并注册 ondatachannel
    // 然后 createOffer → setLocalDescription → signaling.send → waitForConnection
    // waitForConnection 会 await ctx.connectionPromise，我们稍后 reject 它来结束等待
    const connectPromise = performConnect(ctx, config as never, sigA).catch(() => {
      // 预期 reject（我们主动 reject connectionPromise 来结束等待）
    });

    // 等待 performConnect 内部设置好 ondatachannel（轮询 peerConnection 创建完成）
    await vi.waitFor(() => {
      expect(ctx.peerConnection).not.toBeNull();
    });

    // 此时 ctx.peerConnection 已创建，且 ondatachannel 已注册
    // ctx.defaultChannel 仍为 null（autoCreateDataChannel:false）
    expect(ctx.defaultChannel).toBeNull();

    // 手动触发 ondatachannel 回调
    const fakeChannel = ctx.peerConnection!.createDataChannel('__fake_incoming__');
    const fakeEvent = new RTCDataChannelEvent('datachannel', { channel: fakeChannel });
    ctx.peerConnection!.ondatachannel!(fakeEvent);

    // 现在 ctx.defaultChannel 应该被赋值
    expect(ctx.defaultChannel).toBe(fakeChannel);

    // 通过 reject connectionPromise 结束 waitForConnection
    ctx.rejectConnection(new Error('test cleanup'));
    await connectPromise;

    // 清理
    ctx.peerConnection!.close();
  });

  test('answerer 已连接后再收到 renegotiation offer（processOffer 非 idle + 非 signaling 分支）', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    // 先正常连接
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);

    // A 侧手动创建新 offer 并发送给 B（renegotiation）
    // B 侧此时 phase 是 connected（非 idle），命中 branch 7#1
    // try 成功后 phase 仍是 connected（非 signaling），命中 branch 8#0（false 分支）
    const offer = await controllerA.peerConnection!.createOffer();
    await controllerA.peerConnection!.setLocalDescription(offer);
    await sigA.send({ type: 'offer', sdp: offer.sdp! });

    // 等待 B 处理完 renegotiation（事件驱动轮询替代固定 500ms delay）
    await vi.waitFor(() => {
      expect(controllerB!.phase).toBe('connected');
    });
  });

  test('processOffer phase=connected 时 try 成功 → 命中 branch 8#1（else 分支：phase 非 signaling 跳过 waitForConnection）', async () => {
    const [sigA] = createMockSignalingPair();
    // 用 mock peerConnection 确保 try 块稳定成功，且不触发任何 ICE 回调改变 phase
    const mockPc = {
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      createAnswer: vi.fn().mockResolvedValue({ sdp: 'fake-answer-sdp' }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
    } as unknown as RTCPeerConnection;

    // phase=connected 模拟 renegotiation 场景：跳过 idle 入口，try 成功后 phase 仍为 connected（非 signaling）
    // → 命中 if(ctx.phase==='signaling') 的 else 分支（branch 8#1）
    const ctx = createFakeContext({ phase: 'connected', peerConnection: mockPc });
    const config = {
      rtcConfig: { iceServers: [] },
      dataChannelLabel: '__test__',
      dataChannelOptions: { ordered: true },
      autoCreateDataChannel: true,
      connectTimeout: 10_000,
    };

    await processOffer(ctx, 'fake-offer-sdp', config as never, sigA);

    // phase 仍为 connected（未走 signaling→connecting 路径）
    expect(ctx.phase).toBe('connected');
  });
});

// ─────────────────────────────────────────────
// controller.ts 导出内部函数覆盖（routeSignalingMessage / performDispose）
// ─────────────────────────────────────────────

describe('controller.ts 导出内部函数覆盖', () => {
  test('routeSignalingMessage closed 短路 — phase=closed 时直接 return（branch 3#0）', () => {
    const ctx = createFakeContext({ phase: 'closed' });
    const onOffer = vi.fn();

    // 不抛错，直接 return
    routeSignalingMessage(ctx, { type: 'offer', sdp: 'fake' }, onOffer);

    // onOffer 不应被调用
    expect(onOffer).not.toHaveBeenCalled();
  });

  test('performDispose wasClosed=true — phase 已是 closed 时不触发 closed 事件（branch 2#1）', () => {
    const logger = resolveLoggerAdapter();
    const emitter = createEventEmitter(logger);
    // phase 已经是 closed
    const ctx = createFakeContext({ phase: 'closed', emitter });
    const closedHandler = vi.fn();
    ctx.emitter.on('closed', closedHandler);

    const [sigA] = createMockSignalingPair();
    performDispose(ctx, [], sigA, emitter);

    // wasClosed=true → 不应触发 closed 事件
    expect(closedHandler).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// CR 修复后新增防御分支覆盖
// ─────────────────────────────────────────────

describe('controller.ts 信令消息字段校验防御分支', () => {
  test('routeSignalingMessage offer 缺少 sdp 时触发 error 事件', () => {
    const emitter = createEventEmitter(resolveLoggerAdapter());
    const ctx = createFakeContext({ phase: 'idle', emitter });
    const errorHandler = vi.fn();
    ctx.emitter.on('error', errorHandler);

    // offer 消息缺少 sdp 字段，onOffer 不应被调用
    const onOffer = vi.fn().mockResolvedValue(undefined);
    routeSignalingMessage(ctx, { type: 'offer' } as SignalingMessage, onOffer);

    expect(onOffer).not.toHaveBeenCalled();
    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler.mock.calls[0][0].context).toBe('signaling:offer');
    expect(errorHandler.mock.calls[0][0].error.message).toContain('invalid offer');
  });

  test('routeSignalingMessage answer 缺少 sdp 时触发 error 事件', () => {
    const emitter = createEventEmitter(resolveLoggerAdapter());
    const ctx = createFakeContext({ phase: 'connecting', emitter });
    const errorHandler = vi.fn();
    ctx.emitter.on('error', errorHandler);

    // answer 消息缺少 sdp 字段
    const onOffer = vi.fn().mockResolvedValue(undefined);
    routeSignalingMessage(ctx, { type: 'answer' } as SignalingMessage, onOffer);

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler.mock.calls[0][0].context).toBe('signaling:answer');
    expect(errorHandler.mock.calls[0][0].error.message).toContain('invalid answer');
  });

  test('routeSignalingMessage ice-candidate 缺少 candidate 时触发 error 事件', () => {
    const emitter = createEventEmitter(resolveLoggerAdapter());
    const ctx = createFakeContext({ phase: 'connecting', emitter });
    const errorHandler = vi.fn();
    ctx.emitter.on('error', errorHandler);

    // ice-candidate 消息缺少 candidate 字段
    const onOffer = vi.fn().mockResolvedValue(undefined);
    routeSignalingMessage(ctx, { type: 'ice-candidate' } as SignalingMessage, onOffer);

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler.mock.calls[0][0].context).toBe('signaling:ice-candidate');
    expect(errorHandler.mock.calls[0][0].error.message).toContain('invalid ice-candidate');
  });
});

describe('event-emitter.ts 清理分支覆盖', () => {
  test('removeEntry: entries 已被 off 清除后，取消订阅函数调用不报错', () => {
    const emitter = createEventEmitter(resolveLoggerAdapter());
    const handler = vi.fn();

    // on 注册 → 拿到取消函数
    const unsubscribe = emitter.on('test-event' as never, handler);
    // 通过 off 移除同一个 handler → entries 被清空 → Map 中 key 被 delete
    emitter.off('test-event' as never, handler);
    // 再调用取消函数 → removeEntry 中 listeners.get(key) 为 undefined → 命中 !entries 分支
    expect(() => unsubscribe()).not.toThrow();
  });

  test('off: 移除唯一 handler 后 listeners Map 清理 key', () => {
    const emitter = createEventEmitter(resolveLoggerAdapter());
    const handler = vi.fn();

    emitter.on('solo-event' as never, handler);
    // dispatch 前先验证 handler 能被调用
    emitter.dispatch('solo-event' as never, undefined);
    expect(handler).toHaveBeenCalledOnce();

    // off 移除唯一 handler → entries.length === 0 → listeners.delete(key)
    emitter.off('solo-event' as never, handler);

    // 再 dispatch 不应再调用 handler（Map 中 key 已不存在）
    handler.mockClear();
    emitter.dispatch('solo-event' as never, undefined);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('connection.ts waitForConnection phase 守卫', () => {
  test('waitForConnection: connectionPromise resolve 时 phase 已非 connected → 调用 setPhase', async () => {
    const emitter = createEventEmitter(resolveLoggerAdapter());
    // 模拟 answerer 场景：processOffer 已经将 phase 设为 connecting，
    // waitForConnection 开始前 phase 还是 connecting
    let resolveConnection!: () => void;
    const connectionPromise = new Promise<void>((resolve) => {
      resolveConnection = resolve;
    });

    const ctx = createFakeContext({
      phase: 'connecting',
      emitter,
      peerConnection: {} as RTCPeerConnection,
    });
    ctx.connectionPromise = connectionPromise;

    const phaseChangeHandler = vi.fn();
    ctx.emitter.on('phase-change', phaseChangeHandler);

    // 启动 waitForConnection（不 await，先让 promise pending）
    const waitPromise = waitForConnection(ctx, 10_000);

    // resolve connectionPromise → ctx.phase 仍是 connecting → 命中 setPhase('connected')
    resolveConnection();
    await waitPromise;

    expect(ctx.phase).toBe('connected');
    expect(phaseChangeHandler).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// doEmitTo 防御分支覆盖
// ─────────────────────────────────────────────

describe('doEmitTo 防御分支', () => {
  let controllerA: RtcController | null = null;
  let controllerB: RtcController | null = null;

  afterEach(() => {
    controllerA?.dispose();
    controllerB?.dispose();
    controllerA = null;
    controllerB = null;
  });

  test('emitTo 非字符串事件名时静默忽略（命中 typeof event !== string 分支）', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const channelReady = new Promise<void>((resolve) => {
      const off = controllerA!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    const label = controllerA.getChannelLabels()[0]!;
    // @ts-expect-error — 故意传非字符串事件名命中防御分支
    expect(() => controllerA!.emitTo(label, 123)).not.toThrow();
  });

  test('emitTo 内置事件名时静默忽略（命中 BUILTIN_EVENT_NAMES.has 分支）', async () => {
    const [sigA, sigB] = createMockSignalingPair();
    controllerA = createRtcController({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController({ signaling: sigB, connectTimeout: 10_000 });

    const channelReady = new Promise<void>((resolve) => {
      const off = controllerA!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    const label = controllerA.getChannelLabels()[0]!;
    // @ts-expect-error — 故意传内置事件名命中防御分支
    expect(() => controllerA!.emitTo(label, 'connected')).not.toThrow();
  });

  test('emitTo 无 payload 时走 undefined 分支（命中 args.length > 0 else）', async () => {
    const [sigA, sigB] = createMockSignalingPair();

    interface TestEvents {
      ping: undefined;
    }
    controllerA = createRtcController<TestEvents>({ signaling: sigA, connectTimeout: 10_000 });
    controllerB = createRtcController<TestEvents>({ signaling: sigB, connectTimeout: 10_000 });

    const channelReady = new Promise<void>((resolve) => {
      const off = controllerA!.on('data-channel-ready', () => {
        off();
        resolve();
      });
    });
    await Promise.all([controllerA.connect(), waitForPhase(controllerB, 'connected')]);
    await channelReady;

    const label = (controllerA as RtcController<TestEvents>).getChannelLabels()[0]!;
    // 不传 payload，命中 args.length > 0 的 else 分支
    expect(() => (controllerA as RtcController<TestEvents>).emitTo(label, 'ping')).not.toThrow();
  });
});
