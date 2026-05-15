/**
 * RtcRoom 主体实现
 *
 * 对应 RFC.md「API设计」+「内部实现要点」章节
 *
 * 聚合 event-emitter / room-state / peer-manager / media-manager / signaling-bridge，
 * 实现完整的 RtcRoom 接口
 */

import type { EventMap, RtcPhase } from '@/shared/rtc-controller';
import { throwError } from '@/shared/throw-error';
import type { ResolvedLoggerAdapter } from '../adapters/logger';
import { resolveLoggerAdapter } from '../adapters/logger';
import { DEFAULT_JOIN_TIMEOUT, ERROR_FN_NAME } from '../constants';
import { RoomInvalidStateError } from '../errors/room-invalid-state-error';
import { RoomPeerNotFoundError } from '../errors/room-peer-not-found-error';
import { RoomTimeoutError } from '../errors/room-timeout-error';
import type {
  AllRoomEvents,
  PeerEntry,
  RoomPhase,
  RoomSignalingAdapter,
  RoomSignalingMessage,
  RtcRoom,
  RtcRoomOptions,
} from '../types';
import { createEventEmitter } from './event-emitter';
import type { MediaManagerState } from './media-manager';
import { addTrackToAllPeers, createMediaManagerState, removeTrackFromAllPeers } from './media-manager';
import type { PeerManagerDeps } from './peer-manager';
import { createPeerEntry, removePeerEntry } from './peer-manager';
import type { RoomStateContext } from './room-state';
import { assertJoined, assertNotDisposed, setPhase } from './room-state';
import { dispatchToAdapter } from './signaling-bridge';

/** Room 内部共享上下文 */
interface RoomContext {
  readonly localPeerId: string;
  readonly roomSignaling: RoomSignalingAdapter;
  readonly joinTimeout: number;
  readonly logger: ResolvedLoggerAdapter;
  readonly emitter: ReturnType<typeof createEventEmitter>;
  readonly peers: Map<string, PeerEntry>;
  readonly mediaState: MediaManagerState;
  readonly cleanupFns: Array<() => void>;
  readonly stateCtx: RoomStateContext;
  readonly peerDeps: PeerManagerDeps;
  unsubscribeRoomSignaling: (() => void) | null;
}

/** 安全执行函数，忽略异常 */
function callSafely(fn: () => void): void {
  try {
    fn();
  } catch {
    // dispose 清理阶段忽略异常
  }
}

/** 查找 peer entry，不存在则抛 RoomPeerNotFoundError */
function requirePeerEntry(ctx: RoomContext, peerId: string, _caller: string): PeerEntry {
  const entry = ctx.peers.get(peerId);
  if (!entry) {
    throwError(ERROR_FN_NAME, `peer "${peerId}" not found`, RoomPeerNotFoundError as unknown as ErrorConstructor);
  }
  return entry;
}

/** 查找已连接的 peer entry，不存在或未连接则抛错 */
function requireConnectedPeerEntry(ctx: RoomContext, peerId: string, _caller: string): PeerEntry {
  const entry = ctx.peers.get(peerId);
  if (!entry || entry.controller.phase !== 'connected') {
    throwError(
      ERROR_FN_NAME,
      `peer "${peerId}" not found or not connected`,
      RoomPeerNotFoundError as unknown as ErrorConstructor,
    );
  }
  return entry;
}

/** 房间信令消息路由 */
function handleRoomMessage(ctx: RoomContext, message: RoomSignalingMessage): void {
  if (ctx.stateCtx.phase === 'disposed') {
    return;
  }

  switch (message.type) {
    case 'member-joined': {
      if (message.peerId === ctx.localPeerId) {
        return;
      }
      if (ctx.peers.has(message.peerId)) {
        return;
      }
      const entry = createPeerEntry(ctx.peerDeps, message.peerId);
      ctx.peers.set(message.peerId, entry);
      ctx.emitter.dispatch('member-joined', { peerId: message.peerId });
      break;
    }
    case 'member-left': {
      removePeerEntry(ctx.peerDeps, message.peerId);
      break;
    }
    case 'peer-signal': {
      let entry = ctx.peers.get(message.from);
      if (!entry) {
        entry = createPeerEntry(ctx.peerDeps, message.from);
        ctx.peers.set(message.from, entry);
        ctx.emitter.dispatch('member-joined', { peerId: message.from });
      }
      dispatchToAdapter(entry.derivedSignaling, message.signal);
      break;
    }
    default:
      break;
  }
}

/** 创建 join 超时竞速 Promise */
function createJoinTimeoutPromise(joinTimeout: number): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          new (RoomTimeoutError as unknown as ErrorConstructor)(
            `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: join() timed out after ${joinTimeout}ms`,
          ),
        ),
      joinTimeout,
    );
  });
}

/** join 流程：获取成员列表 + 建立连接 */
async function performJoin(ctx: RoomContext): Promise<void> {
  assertNotDisposed(ctx.stateCtx, 'join');
  if (ctx.stateCtx.phase === 'left') {
    setPhase(ctx.stateCtx, 'idle');
  }
  if (ctx.stateCtx.phase !== 'idle') {
    throwError(
      ERROR_FN_NAME,
      `cannot call join() in phase "${ctx.stateCtx.phase}", expected "idle"`,
      RoomInvalidStateError as unknown as ErrorConstructor,
    );
  }

  setPhase(ctx.stateCtx, 'joining');

  let existingMembers: string[];
  try {
    existingMembers = await Promise.race([
      ctx.roomSignaling.join(ctx.localPeerId),
      createJoinTimeoutPromise(ctx.joinTimeout),
    ]);
  } catch (error) {
    setPhase(ctx.stateCtx, 'idle');
    throw error;
  }

  ctx.unsubscribeRoomSignaling = ctx.roomSignaling.onMessage((msg) => handleRoomMessage(ctx, msg));

  const connectPromises: Promise<void>[] = [];
  for (let i = 0; i < existingMembers.length; i++) {
    const remotePeerId = existingMembers[i];
    if (remotePeerId === ctx.localPeerId || ctx.peers.has(remotePeerId)) {
      continue;
    }

    const entry = createPeerEntry(ctx.peerDeps, remotePeerId);
    ctx.peers.set(remotePeerId, entry);
    ctx.emitter.dispatch('member-joined', { peerId: remotePeerId });

    connectPromises.push(
      entry.controller.connect().catch((connectError) => {
        ctx.emitter.dispatch('peer-failed', { peerId: remotePeerId, error: connectError as Error });
        ctx.logger.warn(`failed to connect to peer ${remotePeerId}`, connectError);
      }),
    );
  }

  await Promise.allSettled(connectPromises);
  setPhase(ctx.stateCtx, 'joined');
}

/** leave 流程：清理所有 peer + 通知信令 */
function performLeave(ctx: RoomContext): void {
  if (ctx.stateCtx.phase === 'disposed' || ctx.stateCtx.phase === 'left' || ctx.stateCtx.phase === 'idle') {
    return;
  }

  setPhase(ctx.stateCtx, 'leaving');

  for (const [, entry] of ctx.peers) {
    entry.controller.dispose();
  }
  ctx.peers.clear();

  if (ctx.unsubscribeRoomSignaling) {
    ctx.unsubscribeRoomSignaling();
    ctx.unsubscribeRoomSignaling = null;
  }

  try {
    void ctx.roomSignaling.leave(ctx.localPeerId);
  } catch (leaveError) {
    ctx.logger.error('failed to notify room signaling of leave', leaveError);
  }

  ctx.mediaState.localTracks.length = 0;
  setPhase(ctx.stateCtx, 'left');
}

/** dispose 流程：leave + 清理信令 + 清理函数队列 */
function performDispose(ctx: RoomContext): void {
  if (ctx.stateCtx.phase === 'disposed') {
    return;
  }

  performLeave(ctx);

  if (ctx.roomSignaling.dispose) {
    callSafely(ctx.roomSignaling.dispose.bind(ctx.roomSignaling));
  }

  for (let i = 0; i < ctx.cleanupFns.length; i++) {
    callSafely(ctx.cleanupFns[i]);
  }
  ctx.cleanupFns.length = 0;

  setPhase(ctx.stateCtx, 'disposed');
  ctx.emitter.clear();
}

/** 配置 AbortSignal 集成 */
function setupAbortSignal(ctx: RoomContext, signal: AbortSignal | undefined): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    performDispose(ctx);
    return;
  }
  const onAbort = () => performDispose(ctx);
  signal.addEventListener('abort', onAbort, { once: true });
  ctx.cleanupFns.push(() => signal.removeEventListener('abort', onAbort));
}

// ── 消息操作 ──

/** 广播事件到所有已连接 peer */
function broadcastEvent(ctx: RoomContext, event: string, payload: unknown): void {
  assertNotDisposed(ctx.stateCtx, 'broadcast');
  assertJoined(ctx.stateCtx, 'broadcast');
  for (const [, entry] of ctx.peers) {
    if (entry.controller.phase !== 'connected') {
      continue;
    }
    entry.controller.emit(event, payload);
  }
}

/** 发送事件到指定 peer */
function sendEvent(ctx: RoomContext, targetPeerId: string, event: string, payload: unknown): void {
  assertNotDisposed(ctx.stateCtx, 'send');
  assertJoined(ctx.stateCtx, 'send');
  const entry = requireConnectedPeerEntry(ctx, targetPeerId, 'send');
  entry.controller.emit(event, payload);
}

/** 发送原始数据到指定 peer */
function sendRawData(
  ctx: RoomContext,
  targetPeerId: string,
  data: string | ArrayBuffer | Blob | ArrayBufferView,
): void {
  assertNotDisposed(ctx.stateCtx, 'sendRaw');
  assertJoined(ctx.stateCtx, 'sendRaw');
  const entry = requireConnectedPeerEntry(ctx, targetPeerId, 'sendRaw');
  entry.controller.send(data);
}

/** 广播原始数据到所有已连接 peer */
function broadcastRawData(ctx: RoomContext, data: string | ArrayBuffer | Blob | ArrayBufferView): void {
  assertNotDisposed(ctx.stateCtx, 'broadcastRaw');
  assertJoined(ctx.stateCtx, 'broadcastRaw');
  for (const [, entry] of ctx.peers) {
    if (entry.controller.phase !== 'connected') {
      continue;
    }
    entry.controller.send(data);
  }
}

// ── 媒体操作 ──

/** 获取指定 peer 的远程流 */
function getRemoteStreamsOf(ctx: RoomContext, remotePeerId: string): readonly MediaStream[] {
  const entry = ctx.peers.get(remotePeerId);
  if (!entry) {
    return [];
  }
  return entry.controller.getRemoteStreams();
}

/** 获取所有 peer 的远程流 */
function getAllRemoteStreamsMap(ctx: RoomContext): Map<string, readonly MediaStream[]> {
  const result = new Map<string, readonly MediaStream[]>();
  for (const [remotePeerId, entry] of ctx.peers) {
    result.set(remotePeerId, entry.controller.getRemoteStreams());
  }
  return result;
}

// ── 连接管理 ──

/** 重连指定 peer */
async function reconnectSinglePeer(ctx: RoomContext, remotePeerId: string): Promise<void> {
  assertNotDisposed(ctx.stateCtx, 'reconnectPeer');
  assertJoined(ctx.stateCtx, 'reconnectPeer');
  const entry = requirePeerEntry(ctx, remotePeerId, 'reconnectPeer');
  await entry.controller.reconnect();
}

/** 重连所有未连接的 peer */
async function reconnectAllPeers(ctx: RoomContext): Promise<void> {
  assertNotDisposed(ctx.stateCtx, 'reconnectAll');
  assertJoined(ctx.stateCtx, 'reconnectAll');
  const promises: Promise<void>[] = [];
  for (const [, entry] of ctx.peers) {
    if (entry.controller.phase === 'connected') {
      continue;
    }
    promises.push(entry.controller.reconnect());
  }
  await Promise.allSettled(promises);
}

// ── 状态查询 ──

/** 获取所有 peer 的连接状态 */
function collectPeerStates(ctx: RoomContext): Map<string, RtcPhase> {
  const result = new Map<string, RtcPhase>();
  for (const [remotePeerId, entry] of ctx.peers) {
    result.set(remotePeerId, entry.controller.phase);
  }
  return result;
}

/** 获取指定 peer 的统计信息 */
async function collectPeerStats(ctx: RoomContext, remotePeerId: string): Promise<RTCStatsReport> {
  const entry = requirePeerEntry(ctx, remotePeerId, 'getPeerStats');
  return entry.controller.getStats();
}

// ── 构建 RtcRoom 返回对象 ──

/** 组装 RtcRoom 实例 */
function buildRoomApi<UserEvents extends EventMap>(ctx: RoomContext): RtcRoom<UserEvents> {
  return {
    get phase(): RoomPhase {
      return ctx.stateCtx.phase;
    },
    get peerId(): string {
      return ctx.localPeerId;
    },
    get members(): readonly string[] {
      return Array.from(ctx.peers.keys());
    },
    on: ctx.emitter.on as RtcRoom<UserEvents>['on'],
    once: ctx.emitter.once as RtcRoom<UserEvents>['once'],
    off: ctx.emitter.off as RtcRoom<UserEvents>['off'],
    join: () => performJoin(ctx),
    leave: () => performLeave(ctx),
    dispose: () => performDispose(ctx),
    broadcast: (event, ...args) => broadcastEvent(ctx, event as string, args.length > 0 ? args[0] : undefined),
    send: (targetPeerId, event, ...args) =>
      sendEvent(ctx, targetPeerId, event as string, args.length > 0 ? args[0] : undefined),
    sendRaw: (targetPeerId, data) => sendRawData(ctx, targetPeerId, data),
    broadcastRaw: (data) => broadcastRawData(ctx, data),
    addTrack(track, ...streams) {
      assertNotDisposed(ctx.stateCtx, 'addTrack');
      assertJoined(ctx.stateCtx, 'addTrack');
      return addTrackToAllPeers(ctx.mediaState, ctx.peers, track, streams);
    },
    removeTrack(trackId) {
      assertNotDisposed(ctx.stateCtx, 'removeTrack');
      removeTrackFromAllPeers(ctx.mediaState, ctx.peers, trackId);
    },
    getRemoteStreams: (remotePeerId) => getRemoteStreamsOf(ctx, remotePeerId),
    getAllRemoteStreams: () => getAllRemoteStreamsMap(ctx),
    reconnectPeer: (remotePeerId) => reconnectSinglePeer(ctx, remotePeerId),
    reconnectAll: () => reconnectAllPeers(ctx),
    getPeerController: ((remotePeerId: string) =>
      ctx.peers.get(remotePeerId)?.controller) as RtcRoom<UserEvents>['getPeerController'],
    getPeerStates: () => collectPeerStates(ctx),
    getPeerStats: (remotePeerId) => collectPeerStats(ctx, remotePeerId),
  };
}

function createRoom<UserEvents extends EventMap = Record<string, never>>(options: RtcRoomOptions): RtcRoom<UserEvents> {
  const { peerId: localPeerId, roomSignaling, joinTimeout: userJoinTimeout, signal, logger: userLogger } = options;

  const joinTimeout = userJoinTimeout ?? DEFAULT_JOIN_TIMEOUT;
  const logger = resolveLoggerAdapter(userLogger);
  const emitter = createEventEmitter<AllRoomEvents<UserEvents>>(logger);
  const peers = new Map<string, PeerEntry>();
  const mediaState = createMediaManagerState();
  const cleanupFns: Array<() => void> = [];

  const stateCtx: RoomStateContext = { phase: 'idle', dispatch: emitter.dispatch };
  const peerDeps: PeerManagerDeps = { localPeerId, options, logger, dispatch: emitter.dispatch, peers, mediaState };

  const ctx: RoomContext = {
    localPeerId,
    roomSignaling,
    joinTimeout,
    logger,
    emitter: emitter as ReturnType<typeof createEventEmitter>,
    peers,
    mediaState,
    cleanupFns,
    stateCtx,
    peerDeps,
    unsubscribeRoomSignaling: null,
  };

  setupAbortSignal(ctx, signal);

  return buildRoomApi<UserEvents>(ctx);
}

export { createRoom };
