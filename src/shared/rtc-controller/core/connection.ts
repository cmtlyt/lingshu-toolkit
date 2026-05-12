/**
 * RTCPeerConnection 生命周期管理
 *
 * 对应 RFC.md「连接建立流程」「接收 offer 流程」「ICE Candidate 处理策略」章节
 *
 * 本模块不直接持有状态，而是通过 ControllerContext 接收/操作共享状态，
 * 由 core/controller.ts 创建 context 并注入。
 */

import { throwError } from '@/shared/throw-error';
import { ERROR_FN_NAME } from '../constants';
import { RtcDisposedError } from '../errors/rtc-disposed-error';
import { RtcInvalidStateError } from '../errors/rtc-invalid-state-error';
import { RtcSignalingError } from '../errors/rtc-signaling-error';
import { RtcTimeoutError } from '../errors/rtc-timeout-error';
import type { RtcPhase, SignalingAdapter } from '../types';
import type { ControllerContext } from './controller-context';

/** 检查是否已 disposed，是则抛 RtcDisposedError */
function assertNotDisposed(ctx: ControllerContext, caller: string): void {
  if (ctx.phase === 'closed') {
    throwError(ERROR_FN_NAME, `cannot call ${caller}() after dispose`, RtcDisposedError as unknown as ErrorConstructor);
  }
}

/** 检查当前 phase 是否为期望值，否则抛 RtcInvalidStateError */
function assertPhase(ctx: ControllerContext, expected: RtcPhase, caller: string): void {
  if (ctx.phase !== expected) {
    throwError(
      ERROR_FN_NAME,
      `${caller}() requires phase "${expected}", current is "${ctx.phase}"`,
      RtcInvalidStateError as unknown as ErrorConstructor,
    );
  }
}

/** 更新 phase 并触发 phase-change 事件 */
function setPhase(ctx: ControllerContext, next: RtcPhase): void {
  const prevPhase = ctx.phase;
  ctx.phase = next;
  ctx.emitter.dispatch('phase-change', { phase: next, prevPhase });
}

/** 将 ICE candidate 缓冲队列中暂存的候选批量添加到 RTCPeerConnection */
function flushPendingCandidates(ctx: ControllerContext): void {
  if (!ctx.peerConnection) {
    return;
  }
  for (let i = 0; i < ctx.pendingCandidates.length; i++) {
    ctx.peerConnection.addIceCandidate(new RTCIceCandidate(ctx.pendingCandidates[i]));
  }
  ctx.pendingCandidates.length = 0;
}

/** 处理远端 ICE candidate：remoteDescription 已设置则直接添加，否则缓冲 */
function handleIceCandidate(ctx: ControllerContext, candidate: RTCIceCandidateInit): void {
  if (!ctx.peerConnection) {
    return;
  }
  if (ctx.peerConnection.remoteDescription) {
    ctx.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } else {
    ctx.pendingCandidates.push(candidate);
  }
}

/** 处理远端 answer：setRemoteDescription + flushPendingCandidates */
async function handleAnswer(ctx: ControllerContext, sdp: string): Promise<void> {
  if (!ctx.peerConnection) {
    return;
  }
  try {
    await ctx.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    flushPendingCandidates(ctx);
  } catch (error) {
    setPhase(ctx, 'failed');
    throwError(ERROR_FN_NAME, 'failed to handle answer', RtcSignalingError as unknown as ErrorConstructor, {
      cause: error,
    });
  }
}

/**
 * 为 RTCPeerConnection 注册原生事件，桥接到控制器状态机和事件系统
 *
 * 注册的事件包括：
 * - oniceconnectionstatechange → 状态机流转 + ice-state-change 事件
 * - onicecandidate → 通过信令发送 candidate
 * - onicegatheringstatechange → ice-gathering-complete 事件
 * - onsignalingstatechange → signaling-state-change 事件
 * - ontrack → track 事件
 */
function wireConnectionEvents(
  ctx: ControllerContext,
  peerConnection: RTCPeerConnection,
  signaling: SignalingAdapter,
): void {
  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;
    ctx.emitter.dispatch('ice-state-change', { state });

    switch (state) {
      case 'connected':
      case 'completed':
        if (ctx.phase !== 'connected') {
          setPhase(ctx, 'connected');
          ctx.emitter.dispatch('connected');
          ctx.resolveConnection();
        }
        break;
      case 'disconnected':
        if (ctx.phase === 'connected') {
          setPhase(ctx, 'disconnected');
          ctx.emitter.dispatch('disconnected', { reason: 'ice-disconnected' });
        }
        break;
      case 'failed':
        setPhase(ctx, 'failed');
        ctx.emitter.dispatch('failed', { error: new Error('ICE connection failed') });
        ctx.rejectConnection(new Error('ICE connection failed'));
        break;
      case 'closed':
        break;
      default:
        break;
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) {
      return;
    }
    const sendResult = signaling.send({ type: 'ice-candidate', candidate: event.candidate.toJSON() });
    if (sendResult && typeof (sendResult as Promise<void>).catch === 'function') {
      (sendResult as Promise<void>).catch((error) => {
        ctx.logger.error('failed to send ICE candidate', error);
      });
    }
  };

  peerConnection.onicegatheringstatechange = () => {
    if (peerConnection.iceGatheringState === 'complete') {
      ctx.emitter.dispatch('ice-gathering-complete');
    }
  };

  peerConnection.onsignalingstatechange = () => {
    ctx.emitter.dispatch('signaling-state-change', { state: peerConnection.signalingState });
  };

  peerConnection.ontrack = (event) => {
    ctx.emitter.dispatch('track', {
      track: event.track,
      streams: event.streams,
    });

    event.track.onended = () => {
      ctx.emitter.dispatch('track-removed', { track: event.track });
    };
  };
}

/**
 * 等待 ICE 连接建立，受 connectTimeout 保护
 *
 * connectionPromise 在 wireConnectionEvents 中 resolve/reject
 * 超时时抛 RtcTimeoutError 并自动 dispose
 */
async function waitForConnection(ctx: ControllerContext, connectTimeout: number): Promise<void> {
  const timeoutId = setTimeout(() => {
    ctx.rejectConnection(new RtcTimeoutError(`connect timed out after ${connectTimeout}ms`));
  }, connectTimeout);

  try {
    await ctx.connectionPromise;
    setPhase(ctx, 'connected');
  } catch (error) {
    if (error instanceof RtcTimeoutError) {
      ctx.disposeFn();
      throwError(
        ERROR_FN_NAME,
        `connect timed out after ${connectTimeout}ms`,
        RtcTimeoutError as unknown as ErrorConstructor,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export {
  assertNotDisposed,
  assertPhase,
  flushPendingCandidates,
  handleAnswer,
  handleIceCandidate,
  setPhase,
  waitForConnection,
  wireConnectionEvents,
};
