/**
 * Browser 环境集成测试 — RtcRoom 多方通信
 *
 * 使用真实 RTCPeerConnection API（Chromium 提供）
 * 覆盖：创建房间 → join → 成员发现 → P2P 连接 → 消息收发 → leave → dispose
 */

import { afterEach, describe, expect, test } from 'vitest';
import { createRtcRoom } from '../index';
import type { RtcRoom } from '../types';
import { createMockRoomSignaling } from './helpers/mock-room-signaling';

/** 等待指定事件触发一次 */
function waitForEvent<T>(room: RtcRoom, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for event "${event}"`)), 5000);
    const off = (room as RtcRoom<Record<string, unknown>>).on(event as 'error', (payload: unknown) => {
      clearTimeout(timeout);
      off();
      resolve(payload as T);
    });
  });
}

describe('createRtcRoom 基础功能', () => {
  let roomA: RtcRoom | null = null;
  let roomB: RtcRoom | null = null;

  afterEach(() => {
    roomA?.dispose();
    roomB?.dispose();
    roomA = null;
    roomB = null;
  });

  test('初始 phase 应该是 idle', () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });
    expect(roomA.phase).toBe('idle');
  });

  test('peerId 应该返回创建时传入的值', () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });
    expect(roomA.peerId).toBe('peer-a');
  });

  test('初始 members 应该为空数组', () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });
    expect(roomA.members).toEqual([]);
  });

  test('join 后 phase 应该变为 joined', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    await roomA.join();
    expect(roomA.phase).toBe('joined');
  });

  test('join 应该触发 room-phase-change 事件', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    const phases: string[] = [];
    roomA.on('room-phase-change', (event) => phases.push(event.phase));

    await roomA.join();
    expect(phases).toContain('joining');
    expect(phases).toContain('joined');
  });

  test('leave 后 phase 应该变为 left', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    await roomA.join();
    roomA.leave();
    expect(roomA.phase).toBe('left');
  });

  test('dispose 后 phase 应该变为 disposed', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    await roomA.join();
    roomA.dispose();
    expect(roomA.phase).toBe('disposed');
  });

  test('dispose 应该是幂等的', () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    roomA.dispose();
    roomA.dispose();
    roomA.dispose();
    expect(roomA.phase).toBe('disposed');
  });

  test('dispose 后调用 join 应该抛出错误', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    roomA.dispose();
    await expect(roomA.join()).rejects.toThrow(/dispose/u);
  });

  test('未 join 时调用 broadcast 应该抛出错误', () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    expect(() => (roomA as RtcRoom<{ msg: string }>).broadcast('msg', 'test')).toThrow(/not joined/u);
  });

  test('leave 后可以重新 join', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    await roomA.join();
    roomA.leave();
    expect(roomA.phase).toBe('left');

    await roomA.join();
    expect(roomA.phase).toBe('joined');
  });

  test('AbortSignal 已 aborted 时应该立即 dispose', () => {
    const mockSignaling = createMockRoomSignaling();
    const abortController = new AbortController();
    abortController.abort();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
      signal: abortController.signal,
    });

    expect(roomA.phase).toBe('disposed');
  });

  test('AbortSignal abort 后应该触发 dispose', async () => {
    const mockSignaling = createMockRoomSignaling();
    const abortController = new AbortController();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
      signal: abortController.signal,
    });

    expect(roomA.phase).toBe('idle');
    abortController.abort();
    expect(roomA.phase).toBe('disposed');
  });
});

describe('createRtcRoom 多方连接', () => {
  let roomA: RtcRoom | null = null;
  let roomB: RtcRoom | null = null;
  let roomC: RtcRoom | null = null;

  afterEach(() => {
    roomA?.dispose();
    roomB?.dispose();
    roomC?.dispose();
    roomA = null;
    roomB = null;
    roomC = null;
  });

  test('两个 peer join 后应该互相发现', async () => {
    const mockSignaling = createMockRoomSignaling();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
      connectTimeout: 10_000,
    });
    roomB = createRtcRoom({
      peerId: 'peer-b',
      roomSignaling: mockSignaling.createAdapter('peer-b'),
      connectTimeout: 10_000,
    });

    await roomA.join();
    const memberJoinedPromise = waitForEvent<{ peerId: string }>(roomA, 'member-joined');
    await roomB.join();
    const memberJoinedEvent = await memberJoinedPromise;

    expect(memberJoinedEvent.peerId).toBe('peer-b');
    expect(roomA.members).toContain('peer-b');
    expect(roomB.members).toContain('peer-a');
  });

  test('peer 离开后应该触发 member-left 事件', async () => {
    const mockSignaling = createMockRoomSignaling();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
      connectTimeout: 10_000,
    });
    roomB = createRtcRoom({
      peerId: 'peer-b',
      roomSignaling: mockSignaling.createAdapter('peer-b'),
      connectTimeout: 10_000,
    });

    await roomA.join();
    await roomB.join();

    const memberLeftPromise = waitForEvent<{ peerId: string }>(roomA, 'member-left');
    roomB.leave();
    const memberLeftEvent = await memberLeftPromise;

    expect(memberLeftEvent.peerId).toBe('peer-b');
    expect(roomA.members).not.toContain('peer-b');
  });

  test('getPeerStates 应该返回所有 peer 的状态', async () => {
    const mockSignaling = createMockRoomSignaling();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
      connectTimeout: 10_000,
    });
    roomB = createRtcRoom({
      peerId: 'peer-b',
      roomSignaling: mockSignaling.createAdapter('peer-b'),
      connectTimeout: 10_000,
    });

    await roomA.join();
    await roomB.join();

    const states = roomA.getPeerStates();
    expect(states.size).toBeGreaterThanOrEqual(1);
    expect(states.has('peer-b')).toBe(true);
  });

  test('getRemoteStreams 对不存在的 peer 应该返回空数组', async () => {
    const mockSignaling = createMockRoomSignaling();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    await roomA.join();
    expect(roomA.getRemoteStreams('non-existent')).toEqual([]);
  });

  test('getAllRemoteStreams 初始应该为空 Map', async () => {
    const mockSignaling = createMockRoomSignaling();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    await roomA.join();
    const streams = roomA.getAllRemoteStreams();
    expect(streams.size).toBe(0);
  });

  test('getPeerController 对不存在的 peer 应该返回 undefined', async () => {
    const mockSignaling = createMockRoomSignaling();

    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    await roomA.join();
    expect(roomA.getPeerController('non-existent')).toBeUndefined();
  });
});

describe('createRtcRoom 事件系统', () => {
  let roomA: RtcRoom | null = null;

  afterEach(() => {
    roomA?.dispose();
    roomA = null;
  });

  test('on 应该返回取消订阅函数', () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    const off = roomA.on('room-phase-change', () => {});
    expect(off).toBeTypeOf('function');
    off();
  });

  test('once 应该只触发一次', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    let callCount = 0;
    roomA.once('room-phase-change', () => {
      callCount++;
    });

    await roomA.join();
    roomA.leave();

    // once 只触发一次（joining 时触发，后续不再触发）
    expect(callCount).toBe(1);
  });

  test('off 应该取消订阅', async () => {
    const mockSignaling = createMockRoomSignaling();
    roomA = createRtcRoom({
      peerId: 'peer-a',
      roomSignaling: mockSignaling.createAdapter('peer-a'),
    });

    let callCount = 0;
    const handler = () => {
      callCount++;
    };
    roomA.on('room-phase-change', handler);
    roomA.off('room-phase-change', handler);

    await roomA.join();
    expect(callCount).toBe(0);
  });
});
