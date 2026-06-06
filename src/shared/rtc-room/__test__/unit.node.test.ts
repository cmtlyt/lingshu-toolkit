/**
 * Node 环境单元测试 — 内部模块覆盖率攻坚
 *
 * 覆盖：adapters/logger / core/room-state / core/signaling-bridge / core/media-manager
 */

import { describe, expect, test, vi } from 'vitest';
import { createDefaultLogger, resolveLoggerAdapter } from '../adapters/logger';
import {
  addTrackToAllPeers,
  applyLocalTracks,
  createMediaManagerState,
  removeTrackFromAllPeers,
} from '../core/media-manager';
import type { PeerManagerDeps } from '../core/peer-manager';
import { removePeerEntry } from '../core/peer-manager';
import type { RoomStateContext } from '../core/room-state';
import { assertJoined, assertNotDisposed, assertPhase, setPhase } from '../core/room-state';
import { deriveSignalingAdapter, dispatchToAdapter } from '../core/signaling-bridge';
import type { PeerEntry, RoomSignalingAdapter } from '../types';

// ── adapters/logger ──

describe('adapters/logger', () => {
  test('createDefaultLogger 应该返回包含 warn/error/debug 的对象', () => {
    const logger = createDefaultLogger();
    expect(logger.warn).toBeTypeOf('function');
    expect(logger.error).toBeTypeOf('function');
    expect(logger.debug).toBeTypeOf('function');
  });

  test('resolveLoggerAdapter 无参数时应该返回默认 logger', () => {
    const logger = resolveLoggerAdapter();
    expect(logger.warn).toBeTypeOf('function');
    expect(logger.error).toBeTypeOf('function');
    expect(logger.debug).toBeTypeOf('function');
  });

  test('resolveLoggerAdapter 传入自定义 logger 时应该返回合并后的 logger', () => {
    const customWarn = vi.fn();
    const customError = vi.fn();
    const logger = resolveLoggerAdapter({ warn: customWarn, error: customError });
    // resolveLoggerAdapter 内部会 .bind() 包装，验证调用转发即可
    logger.warn('test-warn');
    logger.error('test-error');
    expect(customWarn).toHaveBeenCalledWith('test-warn');
    expect(customError).toHaveBeenCalledWith('test-error');
    expect(logger.debug).toBeTypeOf('function');
  });
});

// ── core/room-state ──

describe('core/room-state', () => {
  function createMockStateCtx(phase: RoomStateContext['phase'] = 'idle'): RoomStateContext {
    return { phase, dispatch: vi.fn() };
  }

  test('setPhase 应该更新 phase 并分发事件', () => {
    const ctx = createMockStateCtx('idle');
    setPhase(ctx, 'joining');
    expect(ctx.phase).toBe('joining');
    expect(ctx.dispatch).toHaveBeenCalledWith('room-phase-change', { phase: 'joining', prevPhase: 'idle' });
  });

  test('assertPhase 允许的 phase 不应抛错', () => {
    const ctx = createMockStateCtx('joined');
    expect(() => assertPhase(ctx, 'test', 'joined', 'idle')).not.toThrow();
  });

  test('assertPhase 不允许的 phase 应抛 RoomInvalidStateError', () => {
    const ctx = createMockStateCtx('idle');
    expect(() => assertPhase(ctx, 'broadcast', 'joined')).toThrow(/cannot call broadcast/u);
  });

  test('assertNotDisposed 非 disposed 不应抛错', () => {
    const ctx = createMockStateCtx('joined');
    expect(() => assertNotDisposed(ctx, 'test')).not.toThrow();
  });

  test('assertNotDisposed disposed 应抛 RoomDisposedError', () => {
    const ctx = createMockStateCtx('disposed');
    expect(() => assertNotDisposed(ctx, 'join')).toThrow(/dispose/u);
  });

  test('assertJoined joined 状态不应抛错', () => {
    const ctx = createMockStateCtx('joined');
    expect(() => assertJoined(ctx, 'broadcast')).not.toThrow();
  });

  test('assertJoined 非 joined 状态应抛 RoomInvalidStateError', () => {
    const ctx = createMockStateCtx('idle');
    expect(() => assertJoined(ctx, 'broadcast')).toThrow(/not joined/u);
  });
});

// ── core/signaling-bridge ──

describe('core/signaling-bridge', () => {
  function createMockRoomSignaling(): RoomSignalingAdapter {
    return {
      join: vi.fn(),
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
    };
  }

  test('deriveSignalingAdapter send 应该委托到 roomSignaling.sendTo', () => {
    const roomSig = createMockRoomSignaling();
    const adapter = deriveSignalingAdapter(roomSig, 'local', 'remote');

    const message = { type: 'offer' as const, sdp: 'test-sdp' };
    adapter.send(message);

    expect(roomSig.sendTo).toHaveBeenCalledWith('remote', { from: 'local', signal: message });
  });

  test('deriveSignalingAdapter onMessage 应该注册 handler 到 __handlers', () => {
    const roomSig = createMockRoomSignaling();
    const adapter = deriveSignalingAdapter(roomSig, 'local', 'remote');

    const handler = vi.fn();
    adapter.onMessage(handler);

    expect(adapter.__handlers).toContain(handler);
  });

  test('deriveSignalingAdapter onMessage 返回的取消函数应该移除 handler', () => {
    const roomSig = createMockRoomSignaling();
    const adapter = deriveSignalingAdapter(roomSig, 'local', 'remote');

    const handler = vi.fn();
    const unsubscribe = adapter.onMessage(handler);
    expect(adapter.__handlers).toHaveLength(1);

    unsubscribe();
    expect(adapter.__handlers).toHaveLength(0);
  });

  test('deriveSignalingAdapter onMessage 取消函数对不存在的 handler 应安全无操作', () => {
    const roomSig = createMockRoomSignaling();
    const adapter = deriveSignalingAdapter(roomSig, 'local', 'remote');

    const handler = vi.fn();
    const unsubscribe = adapter.onMessage(handler);
    unsubscribe();
    // 二次调用不应抛错（idx < 0 分支）
    unsubscribe();
    expect(adapter.__handlers).toHaveLength(0);
  });

  test('deriveSignalingAdapter dispose 应该清空 handlers', () => {
    const roomSig = createMockRoomSignaling();
    const adapter = deriveSignalingAdapter(roomSig, 'local', 'remote');

    adapter.onMessage(vi.fn());
    adapter.onMessage(vi.fn());
    expect(adapter.__handlers).toHaveLength(2);

    adapter.dispose!();
    expect(adapter.__handlers).toHaveLength(0);
  });

  test('dispatchToAdapter 应该调用所有 handler', () => {
    const roomSig = createMockRoomSignaling();
    const adapter = deriveSignalingAdapter(roomSig, 'local', 'remote');

    const handlerA = vi.fn();
    const handlerB = vi.fn();
    adapter.onMessage(handlerA);
    adapter.onMessage(handlerB);

    const signal = { type: 'offer' as const, sdp: 'test' };
    dispatchToAdapter(adapter, signal);

    expect(handlerA).toHaveBeenCalledWith(signal);
    expect(handlerB).toHaveBeenCalledWith(signal);
  });
});

// ── core/media-manager ──

describe('core/media-manager', () => {
  test('createMediaManagerState 应该返回初始状态', () => {
    const state = createMediaManagerState();
    expect(state.localTracks).toEqual([]);
    expect(state.trackIdCounter).toBe(0);
  });

  /** 构造伪 PeerEntry 用于覆盖 addTrack/removeTrack/applyLocalTracks */
  function createFakePeerEntry(phase = 'connected'): PeerEntry {
    const trackSenders = new Map<string, RTCRtpSender>();
    return {
      peerId: 'fake',
      controller: {
        phase,
        addTrack: vi.fn(() => ({ track: null }) as unknown as RTCRtpSender),
        removeTrack: vi.fn(),
      } as unknown as PeerEntry['controller'],
      derivedSignaling: { send: vi.fn(), onMessage: vi.fn(() => vi.fn()), __handlers: [], dispose: vi.fn() },
      trackSenders,
    };
  }

  test('addTrackToAllPeers 应跳过终态 peer（SKIP_PHASES 分支）', () => {
    const state = createMediaManagerState();
    const connectedEntry = createFakePeerEntry('connected');
    const closedEntry = createFakePeerEntry('closed');
    const failedEntry = createFakePeerEntry('failed');
    const disconnectedEntry = createFakePeerEntry('disconnected');

    const peers = new Map<string, PeerEntry>([
      ['p1', connectedEntry],
      ['p2', closedEntry],
      ['p3', failedEntry],
      ['p4', disconnectedEntry],
    ]);

    const fakeTrack = {} as MediaStreamTrack;
    const trackId = addTrackToAllPeers(state, peers, fakeTrack, []);

    expect(trackId).toMatch(/^local-track-/u);
    // connected peer 应被调用 addTrack
    expect(connectedEntry.controller.addTrack).toHaveBeenCalledOnce();
    // 终态 peer 应被跳过
    expect(closedEntry.controller.addTrack).not.toHaveBeenCalled();
    expect(failedEntry.controller.addTrack).not.toHaveBeenCalled();
    expect(disconnectedEntry.controller.addTrack).not.toHaveBeenCalled();
  });

  test('addTrackToAllPeers 第二个 peer 抛异常时应回滚第一个 peer 的 sender', () => {
    const state = createMediaManagerState();
    const successEntry = createFakePeerEntry('connected');
    const failEntry = createFakePeerEntry('connected');

    const fakeSender = { track: null } as unknown as RTCRtpSender;
    (successEntry.controller.addTrack as ReturnType<typeof vi.fn>).mockReturnValue(fakeSender);
    (failEntry.controller.addTrack as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('addTrack failed');
    });

    const peers = new Map<string, PeerEntry>([
      ['p1', successEntry],
      ['p2', failEntry],
    ]);

    const fakeTrack = {} as MediaStreamTrack;
    expect(() => addTrackToAllPeers(state, peers, fakeTrack, [])).toThrow('addTrack failed');

    // 第一个 peer 的 sender 应被回滚移除
    expect(successEntry.controller.removeTrack).toHaveBeenCalledWith(fakeSender);
    // 状态不应被更新
    expect(state.localTracks).toHaveLength(0);
  });

  test('removeTrackFromAllPeers 应移除轨道并清理 sender', () => {
    const state = createMediaManagerState();
    const entry = createFakePeerEntry('connected');
    const fakeSender = {} as RTCRtpSender;
    entry.trackSenders.set('t1', fakeSender);

    const peers = new Map<string, PeerEntry>([['p1', entry]]);
    state.localTracks.push({ trackId: 't1', track: {} as MediaStreamTrack, streams: [] });

    removeTrackFromAllPeers(state, peers, 't1');

    expect(state.localTracks).toHaveLength(0);
    expect(entry.controller.removeTrack).toHaveBeenCalledWith(fakeSender);
    expect(entry.trackSenders.has('t1')).toBe(false);
  });

  test('removeTrackFromAllPeers 对无 sender 的 peer 应安全跳过', () => {
    const state = createMediaManagerState();
    const entry = createFakePeerEntry('connected');
    // 没有对应的 sender
    const peers = new Map<string, PeerEntry>([['p1', entry]]);

    removeTrackFromAllPeers(state, peers, 'non-existent');
    expect(entry.controller.removeTrack).not.toHaveBeenCalled();
  });

  test('applyLocalTracks 应将已有轨道应用到新 controller', () => {
    const state = createMediaManagerState();
    state.localTracks.push(
      { trackId: 't1', track: {} as MediaStreamTrack, streams: [] },
      { trackId: 't2', track: {} as MediaStreamTrack, streams: [] },
    );

    const fakeController = { addTrack: vi.fn(() => ({}) as RTCRtpSender) } as unknown as PeerEntry['controller'];
    const trackSenders = new Map<string, RTCRtpSender>();

    applyLocalTracks(state, fakeController, trackSenders);

    expect(fakeController.addTrack).toHaveBeenCalledTimes(2);
    expect(trackSenders.size).toBe(2);
    expect(trackSenders.has('t1')).toBe(true);
    expect(trackSenders.has('t2')).toBe(true);
  });
});

// ── core/peer-manager ──

describe('core/peer-manager', () => {
  test('removePeerEntry 对不存在的 peer 应安全无操作', () => {
    const peers = new Map<string, PeerEntry>();
    const dispatch = vi.fn();
    const deps: PeerManagerDeps = {
      localPeerId: 'local',
      options: {} as PeerManagerDeps['options'],
      logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      dispatch,
      peers,
      mediaState: createMediaManagerState(),
    };

    // 不应抛错，也不应分发事件
    expect(() => removePeerEntry(deps, 'non-existent')).not.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
