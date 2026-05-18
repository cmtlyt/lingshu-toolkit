/**
 * Peer 连接生命周期管理
 *
 * 对应 RFC.md「成员管理」+「Offerer决定规则」章节
 *
 * 职责：
 * - 创建 / 移除 PeerEntry（派生信令 + 控制器 + 事件桥接 + 本地轨道应用）
 * - Offerer 决定规则：joiner 始终为 Offerer
 * - controller 内置事件 → Room 级事件桥接
 */

import type { EventMap, RtcController } from '@/shared/rtc-controller';
import { createRtcController } from '@/shared/rtc-controller';
import type { RtcControllerInternalOptions } from '@/shared/rtc-controller/types';
import type { ResolvedLoggerAdapter } from '../adapters/logger';
import type { DerivedSignalingAdapter, PeerEntry, RtcRoomOptions } from '../types';
import type { createEventEmitter } from './event-emitter';
import type { MediaManagerState } from './media-manager';
import { applyLocalTracks } from './media-manager';
import { deriveSignalingAdapter } from './signaling-bridge';

interface PeerManagerDeps {
  readonly localPeerId: string;
  readonly options: RtcRoomOptions;
  readonly logger: ResolvedLoggerAdapter;
  readonly dispatch: ReturnType<typeof createEventEmitter>['dispatch'];
  readonly peers: Map<string, PeerEntry>;
  readonly mediaState: MediaManagerState;
}

/**
 * 将 controller 的 8 类内置事件桥接为 Room 级事件（均附加 peerId 字段）
 */
function bridgeControllerEvents(
  remotePeerId: string,
  controller: RtcController<EventMap>,
  dispatch: ReturnType<typeof createEventEmitter>['dispatch'],
): void {
  controller.on('connected', () => {
    dispatch('peer-connected', { peerId: remotePeerId });
  });

  controller.on('disconnected', ({ reason }) => {
    dispatch('peer-disconnected', { peerId: remotePeerId, reason });
  });

  controller.on('failed', ({ error }) => {
    dispatch('peer-failed', { peerId: remotePeerId, error });
  });

  controller.on('track', ({ track, streams }) => {
    dispatch('track', { peerId: remotePeerId, track, streams });
  });

  controller.on('track-removed', ({ track }) => {
    dispatch('track-removed', { peerId: remotePeerId, track });
  });

  controller.on('data-channel-ready', ({ channel, label }) => {
    dispatch('data-channel-ready', { peerId: remotePeerId, channel, label });
  });

  controller.on('data-channel-closed', ({ label }) => {
    dispatch('data-channel-closed', { peerId: remotePeerId, label });
  });

  controller.on('raw-message', ({ data, channel }) => {
    dispatch('raw-message', { peerId: remotePeerId, data, channel });
  });

  controller.on('error', ({ error, context }) => {
    dispatch('error', { error, context, peerId: remotePeerId });
  });
}

/**
 * 创建单个 peer 的 PeerEntry
 *
 * 1. 派生 SignalingAdapter
 * 2. 创建 RtcController（注入 __onUserEvent 钩子）
 * 3. 注册事件桥接
 * 4. 应用已有本地轨道
 */
function createPeerEntry(deps: PeerManagerDeps, remotePeerId: string): PeerEntry {
  const { localPeerId, options, dispatch, mediaState } = deps;

  const derivedSignaling: DerivedSignalingAdapter = deriveSignalingAdapter(
    options.roomSignaling,
    localPeerId,
    remotePeerId,
  );

  const controllerOptions: RtcControllerInternalOptions = {
    signaling: derivedSignaling,
    rtcConfig: options.rtcConfig,
    dataChannelLabel: options.dataChannelLabel,
    dataChannelOptions: options.dataChannelOptions,
    autoCreateDataChannel: options.autoCreateDataChannel,
    connectTimeout: options.connectTimeout,
    logger: options.logger,
    __onUserEvent(event: string, payload: unknown): boolean | undefined {
      dispatch(event, { from: remotePeerId, payload });
      return true;
    },
  };

  const controller = createRtcController<EventMap>(controllerOptions);
  const trackSenders = new Map<string, RTCRtpSender>();

  bridgeControllerEvents(remotePeerId, controller, dispatch);
  applyLocalTracks(mediaState, controller, trackSenders);

  return { peerId: remotePeerId, controller, derivedSignaling, trackSenders };
}

/**
 * 移除 peer entry：dispose controller + 从 peers Map 移除 + 分发 member-left
 */
function removePeerEntry(deps: PeerManagerDeps, peerId: string): void {
  const entry = deps.peers.get(peerId);
  if (!entry) {
    return;
  }

  entry.controller.dispose();
  deps.peers.delete(peerId);
  deps.dispatch('member-left', { peerId });
}

export type { PeerManagerDeps };
export { createPeerEntry, removePeerEntry };
