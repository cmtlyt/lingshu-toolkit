/**
 * 本地轨道管理
 *
 * 对应 RFC.md「本地轨道管理」章节
 *
 * 维护 localTracks 列表，统一管理 addTrack / removeTrack / applyLocalTracks
 */

import type { RtcController } from '@/shared/rtc-controller';
import type { LocalTrackEntry, PeerEntry } from '../types';

/** 跳过的 controller phase（终态，不再添加轨道） */
const SKIP_PHASES = new Set(['disconnected', 'failed', 'closed']);

interface MediaManagerState {
  readonly localTracks: LocalTrackEntry[];
  trackIdCounter: number;
}

function createMediaManagerState(): MediaManagerState {
  return { localTracks: [], trackIdCounter: 0 };
}

/**
 * 向所有已连接的 peer 添加本地轨道
 *
 * 跳过 disconnected / failed / closed 的 controller，
 * 对 idle / signaling / connecting / connected 均添加
 */
function addTrackToAllPeers(
  state: MediaManagerState,
  peers: ReadonlyMap<string, PeerEntry>,
  track: MediaStreamTrack,
  streams: MediaStream[],
): string {
  const trackId = `local-track-${++state.trackIdCounter}`;
  state.localTracks.push({ trackId, track, streams });

  for (const [, entry] of peers) {
    if (SKIP_PHASES.has(entry.controller.phase)) {
      continue;
    }
    const sender = entry.controller.addTrack(track, ...streams);
    entry.trackSenders.set(trackId, sender);
  }

  return trackId;
}

/**
 * 从所有 peer 移除指定本地轨道
 */
function removeTrackFromAllPeers(
  state: MediaManagerState,
  peers: ReadonlyMap<string, PeerEntry>,
  trackId: string,
): void {
  const idx = state.localTracks.findIndex((entry) => entry.trackId === trackId);
  if (idx >= 0) {
    state.localTracks.splice(idx, 1);
  }

  for (const [, entry] of peers) {
    const sender = entry.trackSenders.get(trackId);
    if (sender) {
      entry.controller.removeTrack(sender);
      entry.trackSenders.delete(trackId);
    }
  }
}

/**
 * 将当前所有本地轨道应用到新创建的 controller
 *
 * 保证后加入的 peer 能收到已有轨道
 */
function applyLocalTracks(
  state: MediaManagerState,
  controller: RtcController,
  trackSenders: Map<string, RTCRtpSender>,
): void {
  for (let i = 0; i < state.localTracks.length; i++) {
    const { trackId, track, streams } = state.localTracks[i];
    const sender = controller.addTrack(track, ...streams);
    trackSenders.set(trackId, sender);
  }
}

export type { MediaManagerState };
export { addTrackToAllPeers, applyLocalTracks, createMediaManagerState, removeTrackFromAllPeers };
