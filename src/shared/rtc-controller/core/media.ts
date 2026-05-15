/**
 * 媒体轨道管理
 *
 * 对应 RFC.md「RtcController 媒体流」章节
 *
 * 职责：
 * - addTrack / removeTrack / getRemoteStreams
 * - 前置守卫（assertNotDisposed / phase 检查）
 */

import { throwError } from '@/shared/throw-error';
import { ERROR_FN_NAME } from '../constants';
import { RtcInvalidStateError } from '../errors/rtc-invalid-state-error';
import type { EventMap } from '../types';
import { assertNotDisposed } from './connection';
import type { ControllerContext } from './controller-context';

/**
 * 添加本地媒体轨道
 *
 * 需要 peerConnection 已创建（phase 非 idle / closed）
 */
function addTrack<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  track: MediaStreamTrack,
  ...streams: MediaStream[]
): RTCRtpSender {
  assertNotDisposed(ctx, 'addTrack');
  if (!ctx.peerConnection) {
    throwError(
      ERROR_FN_NAME,
      'addTrack() requires an active connection (phase must not be "idle")',
      RtcInvalidStateError as unknown as ErrorConstructor,
    );
  }
  return ctx.peerConnection.addTrack(track, ...streams);
}

/** 移除本地媒体轨道 */
function removeTrack<UserEvents extends EventMap>(ctx: ControllerContext<UserEvents>, sender: RTCRtpSender): void {
  assertNotDisposed(ctx, 'removeTrack');
  if (!ctx.peerConnection) {
    throwError(
      ERROR_FN_NAME,
      'removeTrack() requires an active connection',
      RtcInvalidStateError as unknown as ErrorConstructor,
    );
  }
  ctx.peerConnection.removeTrack(sender);
}

/** 获取所有远端媒体流 */
function getRemoteStreams<UserEvents extends EventMap>(ctx: ControllerContext<UserEvents>): readonly MediaStream[] {
  assertNotDisposed(ctx, 'getRemoteStreams');
  if (!ctx.peerConnection) {
    return [];
  }
  const streams: MediaStream[] = [];
  const receivers = ctx.peerConnection.getReceivers();
  for (let i = 0; i < receivers.length; i++) {
    const receiver = receivers[i];
    if (!receiver.track) {
      continue;
    }
    const stream = new MediaStream([receiver.track]);
    streams.push(stream);
  }
  return streams;
}

export { addTrack, getRemoteStreams, removeTrack };
