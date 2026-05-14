/**
 * RtcController 主体实现
 *
 * 对应 RFC.md「内部实现要点」章节
 *
 * 聚合 event-emitter / connection / data-channel / media，
 * 实现 connect / reconnect / dispose 等公开 API + 信令消息自动路由
 */

import { throwError } from '@/shared/throw-error';
import { resolveLoggerAdapter } from '../adapters/logger';
import {
  DEFAULT_CONNECT_TIMEOUT,
  DEFAULT_DATA_CHANNEL_LABEL,
  DEFAULT_DATA_CHANNEL_OPTIONS,
  ERROR_FN_NAME,
} from '../constants';
import { RtcChannelNotReadyError } from '../errors/rtc-channel-not-ready-error';
import { RtcDisposedError } from '../errors/rtc-disposed-error';
import { RtcSignalingError } from '../errors/rtc-signaling-error';
import type { BuiltinEvents, EventMap, RtcController, RtcControllerInternalOptions, SignalingAdapter } from '../types';
import {
  assertNotDisposed,
  assertPhase,
  flushPendingCandidates,
  handleAnswer,
  handleIceCandidate,
  setPhase,
  waitForConnection,
  wireConnectionEvents,
} from './connection';
import type { ControllerContext } from './controller-context';
import { BUILTIN_EVENT_NAMES, encodeEventMessage, wireDataChannelEvents } from './data-channel';
import { createEventEmitter } from './event-emitter';
import { addTrack, getRemoteStreams, removeTrack } from './media';

/** 创建连接 Promise 及其 resolve/reject 句柄 */
function createConnectionDeferred() {
  let resolveConnection: (() => void) | undefined;
  let rejectConnection: ((_error: Error) => void) | undefined;
  const connectionPromise = new Promise<void>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
  return { connectionPromise, resolveConnection: resolveConnection!, rejectConnection: rejectConnection! };
}

/** 安全关闭资源，忽略 close 中可能抛出的异常 */
function closeResource(target: { close: () => void } | null): void {
  if (!target) {
    return;
  }
  try {
    target.close();
  } catch {
    // dispose 清理阶段忽略关闭异常
  }
}

/** 安全执行函数，忽略执行中可能抛出的异常 */
function callSafely(fn: () => void): void {
  try {
    fn();
  } catch {
    // dispose 清理阶段忽略异常
  }
}

/** 创建 logger + emitter 基础设施（纯 return 以规避 V8 const-split instrumentation） */
function createEventInfra<UserEvents extends EventMap>(userLogger?: RtcControllerInternalOptions['logger']) {
  return {
    logger: resolveLoggerAdapter(userLogger),
    emitter: createEventEmitter<UserEvents>(resolveLoggerAdapter(userLogger)),
  };
}

/** 执行 dispose 清理逻辑（拆出以降低主函数复杂度） */
function performDispose<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  cleanupFns: Array<() => void>,
  signaling: SignalingAdapter,
  emitter: ReturnType<typeof createEventEmitter<UserEvents>>,
): void {
  closeResource(ctx.defaultChannel);
  ctx.defaultChannel = null;
  closeResource(ctx.peerConnection);
  ctx.peerConnection = null;
  ctx.pendingCandidates.length = 0;

  for (let i = 0; i < cleanupFns.length; i++) {
    callSafely(cleanupFns[i]);
  }
  cleanupFns.length = 0;

  if (signaling.dispose) {
    callSafely(signaling.dispose.bind(signaling));
  }

  const wasClosed = ctx.phase === 'closed';
  setPhase(ctx, 'closed');
  if (!wasClosed) {
    ctx.emitter.dispatch('closed');
  }
  emitter.clear();
}

/** 路由信令消息到对应的内部处理函数 */
function routeSignalingMessage<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  message: { type: string; sdp?: string; candidate?: RTCIceCandidateInit },
  onOffer: (sdp: string) => Promise<void>,
): void {
  if (ctx.phase === 'closed') {
    return;
  }

  switch (message.type) {
    case 'offer':
      onOffer(message.sdp!).catch((error) => {
        ctx.emitter.dispatch('error', { error: error as Error, context: 'signaling:offer' });
      });
      break;
    case 'answer':
      handleAnswer(ctx, message.sdp!).catch((error) => {
        ctx.emitter.dispatch('error', { error: error as Error, context: 'signaling:answer' });
      });
      break;
    case 'ice-candidate':
      handleIceCandidate(ctx, message.candidate!);
      break;
    default:
      break;
  }
}

/** 断言默认数据通道已就绪 */
function assertChannelReady<UserEvents extends EventMap>(ctx: ControllerContext<UserEvents>, caller: string): void {
  if (!ctx.defaultChannel || ctx.defaultChannel.readyState !== 'open') {
    throwError(
      ERROR_FN_NAME,
      `data channel is not ready, cannot ${caller}`,
      RtcChannelNotReadyError as unknown as ErrorConstructor,
    );
  }
}

/** 连接配置（从 options 中提取，供外部函数使用） */
interface ConnectConfig {
  rtcConfig: RTCConfiguration;
  dataChannelLabel: string;
  dataChannelOptions: RTCDataChannelInit;
  autoCreateDataChannel: boolean;
  connectTimeout: number;
}

/** 接收 offer 流程（拆出以降低主函数行数） */
async function processOffer<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  sdp: string,
  config: ConnectConfig,
  signaling: SignalingAdapter,
): Promise<void> {
  assertNotDisposed(ctx, 'handleOffer');
  if (ctx.phase === 'idle') {
    setPhase(ctx, 'signaling');
    ctx.peerConnection = new RTCPeerConnection(config.rtcConfig);
    wireConnectionEvents(ctx, ctx.peerConnection, signaling);
    ctx.peerConnection.ondatachannel = (ev) => {
      ctx.defaultChannel = ev.channel;
      wireDataChannelEvents(ctx, ev.channel);
    };
  }
  try {
    await ctx.peerConnection!.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
    flushPendingCandidates(ctx);
    const answer = await ctx.peerConnection!.createAnswer();
    await ctx.peerConnection!.setLocalDescription(answer);
    await signaling.send({ type: 'answer', sdp: answer.sdp! });
  } catch (error) {
    setPhase(ctx, 'failed');
    throwError(ERROR_FN_NAME, 'failed to handle offer', RtcSignalingError as unknown as ErrorConstructor, {
      cause: error,
    });
  }
  if (ctx.phase === 'signaling') {
    setPhase(ctx, 'connecting');
    await waitForConnection(ctx, config.connectTimeout);
  }
}

/** 作为 Offerer 发起连接（拆出以降低主函数行数） */
async function performConnect<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  config: ConnectConfig,
  signaling: SignalingAdapter,
): Promise<void> {
  assertNotDisposed(ctx, 'connect');
  assertPhase(ctx, 'idle', 'connect');
  setPhase(ctx, 'signaling');
  ctx.peerConnection = new RTCPeerConnection(config.rtcConfig);
  wireConnectionEvents(ctx, ctx.peerConnection, signaling);
  if (config.autoCreateDataChannel) {
    ctx.defaultChannel = ctx.peerConnection.createDataChannel(config.dataChannelLabel, config.dataChannelOptions);
    wireDataChannelEvents(ctx, ctx.defaultChannel);
  }
  ctx.peerConnection.ondatachannel = (ev) => {
    if (!ctx.defaultChannel || ctx.defaultChannel.readyState === 'closed') {
      ctx.defaultChannel = ev.channel;
    }
    wireDataChannelEvents(ctx, ev.channel);
  };
  try {
    const offer = await ctx.peerConnection.createOffer();
    await ctx.peerConnection.setLocalDescription(offer);
    await signaling.send({ type: 'offer', sdp: offer.sdp! });
  } catch (error) {
    setPhase(ctx, 'failed');
    throwError(ERROR_FN_NAME, 'failed to create/send offer', RtcSignalingError as unknown as ErrorConstructor, {
      cause: error,
    });
  }
  setPhase(ctx, 'connecting');
  await waitForConnection(ctx, config.connectTimeout);
}

/** 发送自定义事件到 DataChannel（拆出以降低主函数行数） */
function emitUserEvent<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  logger: ReturnType<typeof resolveLoggerAdapter>,
  event: string | number | symbol,
  ...args: unknown[]
): void {
  assertNotDisposed(ctx, 'emit');
  const eventName = event as string;
  if (BUILTIN_EVENT_NAMES.has(eventName)) {
    logger.warn(`cannot emit builtin event "${eventName}" via controller.emit(), ignored`);
    return;
  }
  assertChannelReady(ctx, 'emit event');
  const payload = args.length > 0 ? args[0] : undefined;
  ctx.defaultChannel!.send(encodeEventMessage(eventName, payload));
}

/** 创建新的数据通道（拆出以降低主函数行数） */
function doCreateDataChannel<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  label: string,
  channelOptions?: RTCDataChannelInit,
): RTCDataChannel {
  assertNotDisposed(ctx, 'createDataChannel');
  if (!ctx.peerConnection) {
    throwError(
      ERROR_FN_NAME,
      'createDataChannel() requires an active connection',
      RtcDisposedError as unknown as ErrorConstructor,
    );
  }
  const channel = ctx.peerConnection.createDataChannel(label, channelOptions);
  wireDataChannelEvents(ctx, channel);
  return channel;
}

/** 重置连接 Promise（reconnect 清理后需要新的 Promise） */
function resetConnectionPromise<UserEvents extends EventMap>(ctx: ControllerContext<UserEvents>): void {
  const newDeferred = createConnectionDeferred();
  ctx.resolveConnection = newDeferred.resolveConnection;
  ctx.rejectConnection = newDeferred.rejectConnection;
  ctx.connectionPromise = newDeferred.connectionPromise;
}

/** 配置 AbortSignal 集成 */
function setupAbortSignal(signal: AbortSignal | undefined, dispose: () => void, cleanupFns: Array<() => void>): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    dispose();
    return;
  }
  const onAbort = () => dispose();
  signal.addEventListener('abort', onAbort, { once: true });
  cleanupFns.push(() => signal.removeEventListener('abort', onAbort));
}

function createRtcController<UserEvents extends EventMap = BuiltinEvents>(
  options: RtcControllerInternalOptions,
): RtcController<UserEvents> {
  const {
    signaling,
    rtcConfig: userRtcConfig,
    dataChannelLabel: userDataChannelLabel,
    dataChannelOptions: userDataChannelOptions,
    autoCreateDataChannel: userAutoCreate,
    connectTimeout: userConnectTimeout,
    logger: userLogger,
    signal,
    __onUserEvent: onUserEventHook,
  } = options;
  const config: ConnectConfig = {
    rtcConfig: userRtcConfig || { iceServers: [] },
    dataChannelLabel: userDataChannelLabel || DEFAULT_DATA_CHANNEL_LABEL,
    dataChannelOptions: userDataChannelOptions || DEFAULT_DATA_CHANNEL_OPTIONS,
    autoCreateDataChannel: userAutoCreate !== false,
    connectTimeout: userConnectTimeout || DEFAULT_CONNECT_TIMEOUT,
  };

  const { logger, emitter } = createEventInfra<UserEvents>(userLogger);
  const cleanupFns: Array<() => void> = [];
  const deferred = createConnectionDeferred();
  let disposed = false;

  const ctx: ControllerContext<UserEvents> = {
    phase: 'idle',
    peerConnection: null,
    defaultChannel: null,
    pendingCandidates: [],
    emitter,
    logger,
    resolveConnection: deferred.resolveConnection,
    rejectConnection: deferred.rejectConnection,
    connectionPromise: deferred.connectionPromise,
    disposeFn: () => dispose(),
    onUserEventHook,
  };

  const onOffer = (sdp: string) => processOffer(ctx, sdp, config, signaling);
  const unsubscribe = signaling.onMessage((msg) => routeSignalingMessage(ctx, msg, onOffer));
  cleanupFns.push(unsubscribe);

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    performDispose(ctx, cleanupFns, signaling, emitter);
  }

  setupAbortSignal(signal, dispose, cleanupFns);

  const connect = () => performConnect(ctx, config, signaling);
  async function reconnect(): Promise<void> {
    assertNotDisposed(ctx, 'reconnect');
    if (ctx.phase !== 'idle') {
      closeResource(ctx.peerConnection);
      ctx.peerConnection = null;
      closeResource(ctx.defaultChannel);
      ctx.defaultChannel = null;
      ctx.pendingCandidates.length = 0;
      resetConnectionPromise(ctx);
      ctx.emitter.dispatch('disconnected', { reason: 'reconnect' });
      setPhase(ctx, 'idle');
    }
    await connect();
  }

  function send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    assertNotDisposed(ctx, 'send');
    assertChannelReady(ctx, 'send data');
    ctx.defaultChannel!.send(data as string);
  }

  async function getStats(): Promise<RTCStatsReport> {
    assertNotDisposed(ctx, 'getStats');
    if (!ctx.peerConnection) {
      throwError(
        ERROR_FN_NAME,
        'getStats() requires an active connection',
        RtcDisposedError as unknown as ErrorConstructor,
      );
    }
    return ctx.peerConnection.getStats();
  }

  return {
    get phase() {
      return ctx.phase;
    },
    get peerConnection() {
      return ctx.peerConnection;
    },
    on: emitter.on,
    once: emitter.once,
    off: emitter.off,
    connect,
    reconnect,
    dispose,
    addTrack: (track, ...streams) => addTrack(ctx, track, ...streams),
    removeTrack: (sender) => removeTrack(ctx, sender),
    getRemoteStreams: () => getRemoteStreams(ctx),
    createDataChannel: (label, opts) => doCreateDataChannel(ctx, label, opts),
    emit: (event, ...args) => emitUserEvent(ctx, logger, event, ...args),
    send,
    getStats,
  };
}

export { createRtcController, performConnect, performDispose, processOffer, routeSignalingMessage };
