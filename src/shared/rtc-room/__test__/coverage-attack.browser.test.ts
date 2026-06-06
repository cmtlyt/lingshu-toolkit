/**
 * Browser 环境覆盖率攻坚测试
 *
 * 策略：一次 P2P 连接测多个路径，减少连接开销
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRtcRoom } from '../index';
import type { RoomSignalingAdapter, RtcRoom } from '../types';
import { createMockRoomSignaling } from './helpers/mock-room-signaling';

function waitForEvent<T>(room: RtcRoom, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    const off = (room as RtcRoom<Record<string, unknown>>).on(event as 'error', (payload: unknown) => {
      clearTimeout(timeout);
      off();
      resolve(payload as T);
    });
  });
}

// ── 不需要 P2P 连接的防御分支 ──

describe('防御分支（无需 P2P 连接）', () => {
  let room: RtcRoom | null = null;

  afterEach(() => {
    room?.dispose();
    room = null;
  });

  test('send / sendRaw 对不存在 peer 应抛 not found', async () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom<{ msg: string }>({ peerId: 'a', roomSignaling: sig.createAdapter('a') });
    await room.join();

    expect(() => (room as RtcRoom<{ msg: string }>).send('x', 'msg', 'v')).toThrow(/not found/u);
    expect(() => room!.sendRaw('x', 'data')).toThrow(/not found/u);
  });

  test('dispose 后 broadcast / send / sendRaw / broadcastRaw 均抛 dispose', () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom<{ m: string }>({ peerId: 'a', roomSignaling: sig.createAdapter('a') });
    room.dispose();

    expect(() => (room as RtcRoom<{ m: string }>).broadcast('m', '')).toThrow(/dispose/u);
    expect(() => (room as RtcRoom<{ m: string }>).send('b', 'm', '')).toThrow(/dispose/u);
    expect(() => room!.sendRaw('b', 'x')).toThrow(/dispose/u);
    expect(() => room!.broadcastRaw('x')).toThrow(/dispose/u);
  });

  test('reconnectPeer / reconnectAll 的防御分支', async () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom({ peerId: 'a', roomSignaling: sig.createAdapter('a') });

    // 未 join
    await expect(room.reconnectAll()).rejects.toThrow(/not joined/u);
    await expect(room.reconnectPeer('x')).rejects.toThrow(/not joined/u);

    room.dispose();
    await expect(room.reconnectPeer('x')).rejects.toThrow(/dispose/u);
    await expect(room.reconnectAll()).rejects.toThrow(/dispose/u);
  });

  test('getPeerStats 对不存在 peer 应抛 not found', async () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom({ peerId: 'a', roomSignaling: sig.createAdapter('a') });
    await room.join();
    await expect(room.getPeerStats('x')).rejects.toThrow(/not found/u);
  });

  test('addTrack 未 join / dispose 后应抛错', () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom({ peerId: 'a', roomSignaling: sig.createAdapter('a') });
    expect(() => room!.addTrack(null as unknown as MediaStreamTrack)).toThrow(/not joined/u);

    room.dispose();
    expect(() => room!.addTrack(null as unknown as MediaStreamTrack)).toThrow(/dispose/u);
  });

  test('removeTrack dispose 后应抛错；对不存在 trackId 安全无操作', async () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom({ peerId: 'a', roomSignaling: sig.createAdapter('a') });
    await room.join();
    expect(() => room!.removeTrack('non-existent')).not.toThrow();

    room.dispose();
    expect(() => room!.removeTrack('x')).toThrow(/dispose/u);
  });

  test('已 joined / joining 状态重复 join 应抛错', async () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom({ peerId: 'a', roomSignaling: sig.createAdapter('a') });
    await room.join();
    await expect(room.join()).rejects.toThrow(/cannot call join/u);
  });

  test('idle 状态 leave 应无操作', () => {
    const sig = createMockRoomSignaling();
    room = createRtcRoom({ peerId: 'a', roomSignaling: sig.createAdapter('a') });
    room.leave();
    expect(room.phase).toBe('idle');
  });

  test('roomSignaling.leave 抛错时 leave 应正常完成', async () => {
    const adapter: RoomSignalingAdapter = {
      join: vi.fn(async () => []),
      leave: () => {
        throw new Error('leave failed');
      },
      sendTo: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
    };
    room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();
    expect(() => room!.leave()).not.toThrow();
    expect(room.phase).toBe('left');
  });

  test('roomSignaling 无 dispose 方法时 dispose 应正常', async () => {
    const adapter: RoomSignalingAdapter = {
      join: vi.fn(async () => []),
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
    };
    room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();
    expect(() => room!.dispose()).not.toThrow();
    expect(room.phase).toBe('disposed');
  });

  test('join 超时应回退到 idle', async () => {
    vi.useFakeTimers();
    const adapter: RoomSignalingAdapter = {
      join: () => new Promise(() => {}),
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
    };
    room = createRtcRoom({ peerId: 'a', roomSignaling: adapter, joinTimeout: 1000 });
    const joinPromise = room.join();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(joinPromise).rejects.toThrow(/timed out/u);
    expect(room.phase).toBe('idle');
    vi.useRealTimers();
  });
});

// ── handleRoomMessage 分支 ──

describe('handleRoomMessage 分支', () => {
  let room: RtcRoom | null = null;

  afterEach(() => {
    room?.dispose();
    room = null;
  });

  test('收到自己的 member-joined / 未知 type 应安全忽略', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const adapter: RoomSignalingAdapter = {
      async join() {
        return [];
      },
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage(cb) {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) {
            handlers.splice(i, 1);
          }
        };
      },
    };
    room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();

    const handler = vi.fn();
    room.on('member-joined', handler);

    // 自己的 member-joined 被忽略
    handlers[0]?.({ type: 'member-joined', peerId: 'a' });
    expect(handler).not.toHaveBeenCalled();

    // 未知 type 走 default 分支
    expect(() => handlers[0]?.({ type: 'unknown' })).not.toThrow();
  });

  test('收到未知 peer 的 peer-signal 应自动创建 entry', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const adapter: RoomSignalingAdapter = {
      async join() {
        return [];
      },
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage(cb) {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) {
            handlers.splice(i, 1);
          }
        };
      },
    };
    room = createRtcRoom({ peerId: 'a', roomSignaling: adapter, connectTimeout: 10_000 });
    await room.join();

    const promise = waitForEvent<{ peerId: string }>(room, 'member-joined');
    handlers[0]?.({ type: 'peer-signal', from: 'unknown-peer', signal: { type: 'offer', sdp: 'x' } });
    const event = await promise;
    expect(event.peerId).toBe('unknown-peer');
    expect(room.members).toContain('unknown-peer');
  });
});

// ── 需要真实 P2P 连接的集成路径（一次连接测多路径） ──

describe('P2P 连接后的操作覆盖', () => {
  let roomA: RtcRoom | null = null;
  let roomB: RtcRoom | null = null;

  afterEach(() => {
    roomA?.dispose();
    roomB?.dispose();
    roomA = null;
    roomB = null;
  });

  test('连接后：broadcast / send / sendRaw / broadcastRaw / addTrack / removeTrack / reconnect / stats', async () => {
    const sig = createMockRoomSignaling();
    roomA = createRtcRoom<{ msg: string }>({
      peerId: 'a',
      roomSignaling: sig.createAdapter('a'),
      connectTimeout: 15_000,
    });
    roomB = createRtcRoom<{ msg: string }>({
      peerId: 'b',
      roomSignaling: sig.createAdapter('b'),
      connectTimeout: 15_000,
    });

    // 建立连接
    await roomA.join();
    const memberJoinedP = waitForEvent(roomA, 'member-joined');
    await roomB.join();
    await memberJoinedP;

    // 等 data-channel-ready（A 侧和 B 侧都要就绪）
    await Promise.all([waitForEvent(roomA, 'data-channel-ready'), waitForEvent(roomB, 'data-channel-ready')]);

    // ── broadcast ──
    const broadcastP = waitForEvent<{ from: string; payload: string }>(roomB, 'msg');
    (roomA as RtcRoom<{ msg: string }>).broadcast('msg', 'hello');
    const broadcastResult = await broadcastP;
    expect(broadcastResult.from).toBe('a');
    expect(broadcastResult.payload).toBe('hello');

    // ── send ──
    const sendP = waitForEvent<{ from: string; payload: string }>(roomB, 'msg');
    (roomA as RtcRoom<{ msg: string }>).send('b', 'msg', 'targeted');
    const sendResult = await sendP;
    expect(sendResult.from).toBe('a');
    expect(sendResult.payload).toBe('targeted');

    // ── sendRaw ──
    const rawP = waitForEvent<{ peerId: string; data: unknown }>(roomB, 'raw-message');
    roomA.sendRaw('b', 'raw-data');
    const rawResult = await rawP;
    expect(rawResult.data).toBe('raw-data');

    // ── broadcastRaw ──
    const bRawP = waitForEvent<{ peerId: string; data: unknown }>(roomB, 'raw-message');
    roomA.broadcastRaw('broadcast-raw');
    const bRawResult = await bRawP;
    expect(bRawResult.data).toBe('broadcast-raw');

    // ── addTrack + removeTrack ──
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    audioCtx.createOscillator().connect(dest);
    const track = dest.stream.getAudioTracks()[0];

    const trackId = roomA.addTrack(track, dest.stream);
    expect(trackId).toMatch(/^local-track-/u);
    expect(() => roomA!.removeTrack(trackId)).not.toThrow();
    track.stop();
    await audioCtx.close();

    // ── getPeerStates ──
    const states = roomA.getPeerStates();
    expect(states.has('b')).toBe(true);

    // ── getPeerStats ──
    const stats = await roomA.getPeerStats('b');
    expect(stats).toBeDefined();

    // ── getPeerController ──
    const ctrl = roomA.getPeerController('b');
    expect(ctrl).toBeDefined();

    // ── getRemoteStreams / getAllRemoteStreams ──
    const streams = roomA.getRemoteStreams('b');
    expect(Array.isArray(streams)).toBe(true);
    const allStreams = roomA.getAllRemoteStreams();
    expect(allStreams.has('b')).toBe(true);

    // ── broadcast 不传 payload（三元 false 分支 line 377） ──
    const noPaylodBroadcastP = waitForEvent<{ from: string; payload: unknown }>(roomB, 'ping');
    (roomA as RtcRoom<{ ping: undefined }>).broadcast('ping');
    const noPaylodBroadcast = await noPaylodBroadcastP;
    expect(noPaylodBroadcast.from).toBe('a');
    expect(noPaylodBroadcast.payload).toBeUndefined();

    // ── send 不传 payload（三元 false 分支 line 379） ──
    const noPayloadSendP = waitForEvent<{ from: string; payload: unknown }>(roomB, 'ping');
    (roomA as RtcRoom<{ ping: undefined }>).send('b', 'ping');
    const noPayloadSend = await noPayloadSendP;
    expect(noPayloadSend.from).toBe('a');
    expect(noPayloadSend.payload).toBeUndefined();

    // ── reconnectPeer + reconnectAll（放最后，因为 reconnect 后 data channel 需重建） ──
    await expect(roomA.reconnectPeer('b')).resolves.toBeUndefined();
    await expect(roomA.reconnectAll()).resolves.toBeUndefined();
  });
});

// ── disposed 后收消息 + 已存在 peer 重复 member-joined ──

describe('handleRoomMessage 额外分支', () => {
  test('disposed 后收到消息应被安全忽略', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const adapter: RoomSignalingAdapter = {
      async join() {
        return [];
      },
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage(cb) {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) {
            handlers.splice(i, 1);
          }
        };
      },
    };
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();
    const handler = handlers[0];

    room.dispose();
    // disposed 后收到消息不应抛错
    expect(() => handler?.({ type: 'member-joined', peerId: 'x' })).not.toThrow();
  });

  test('已存在 peer 的重复 member-joined 应被忽略', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const adapter: RoomSignalingAdapter = {
      async join() {
        return [];
      },
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage(cb) {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) {
            handlers.splice(i, 1);
          }
        };
      },
    };
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter, connectTimeout: 10_000 });
    await room.join();

    let joinCount = 0;
    room.on('member-joined', () => {
      joinCount++;
    });

    // 第一次 member-joined
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    expect(joinCount).toBe(1);

    // 重复 member-joined 应被忽略
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    expect(joinCount).toBe(1);

    room.dispose();
  });
});

// ── broadcast/broadcastRaw 跳过未连接 peer + reconnectAll 跳过已连接 ──

describe('broadcast 跳过未连接 peer / reconnectAll 跳过已连接', () => {
  test('broadcast 和 broadcastRaw 应跳过未连接的 peer', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const adapter: RoomSignalingAdapter = {
      async join() {
        return [];
      },
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage(cb) {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) {
            handlers.splice(i, 1);
          }
        };
      },
    };
    const room = createRtcRoom<{ ping: string }>({
      peerId: 'a',
      roomSignaling: adapter,
      connectTimeout: 10_000,
    });
    await room.join();

    // 添加一个 peer（通过 peer-signal），此时 peer 处于 signaling 状态（未连接）
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    expect(room.members).toContain('b');

    // broadcast / broadcastRaw 应跳过未连接 peer 而不抛错
    expect(() => (room as RtcRoom<{ ping: string }>).broadcast('ping', 'test')).not.toThrow();
    expect(() => room.broadcastRaw('raw')).not.toThrow();

    // reconnectAll 应跳过未连接（非 connected）的 peer，这里会尝试 reconnect
    // 但不应抛错
    await expect(room.reconnectAll()).resolves.toBeUndefined();

    room.dispose();
  });
});

// ── performJoin connect 失败 ──

describe('performJoin connect 失败', () => {
  test('join 时已有成员的 connect 失败应触发 peer-failed 但 join 仍成功', async () => {
    // 创建一个会让 connect 失败的场景：
    // adapter 返回已有成员列表，但 sendTo 什么也不做（信令不通）导致连接超时
    const handlers: Array<(msg: any) => void> = [];
    const adapter: RoomSignalingAdapter = {
      async join() {
        return ['existing-peer'];
      },
      leave: vi.fn(),
      sendTo: vi.fn(), // 信令丢弃，connect 会超时/失败
      onMessage(cb) {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) {
            handlers.splice(i, 1);
          }
        };
      },
    };

    const room = createRtcRoom({
      peerId: 'a',
      roomSignaling: adapter,
      connectTimeout: 500, // 短超时以加速测试
    });

    const peerFailedEvents: Array<{ peerId: string }> = [];
    room.on('peer-failed', (event) => peerFailedEvents.push(event));

    await room.join();

    // join 应成功（connect 失败被 catch 了）
    expect(room.phase).toBe('joined');
    expect(room.members).toContain('existing-peer');

    // peer-failed 应被触发
    expect(peerFailedEvents.length).toBeGreaterThanOrEqual(1);
    expect(peerFailedEvents[0].peerId).toBe('existing-peer');

    room.dispose();
  });
});

// ── removePeerEntry 不存在的 peer ──

describe('removePeerEntry 不存在 peer', () => {
  test('member-left 消息对不存在的 peer 应安全无操作', async () => {
    const handlers: Array<(msg: any) => void> = [];
    const adapter: RoomSignalingAdapter = {
      async join() {
        return [];
      },
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage(cb) {
        handlers.push(cb);
        return () => {
          const i = handlers.indexOf(cb);
          if (i >= 0) {
            handlers.splice(i, 1);
          }
        };
      },
    };
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();

    // 发送不存在 peer 的 member-left 不应抛错
    expect(() => handlers[0]?.({ type: 'member-left', peerId: 'non-existent' })).not.toThrow();

    room.dispose();
  });
});

// ── performJoin 跳过自己 peerId（line 168 continue 分支） ──

describe('performJoin 跳过自己 peerId', () => {
  test('join 返回包含自己 peerId 的成员列表时应跳过自己', async () => {
    const adapter: RoomSignalingAdapter = {
      async join(peerId: string) {
        return [peerId, 'other-peer'];
      }, // 返回自己 + 其他
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
    };
    const room = createRtcRoom({
      peerId: 'a',
      roomSignaling: adapter,
      connectTimeout: 500,
    });

    await room.join();

    // 自己不应在 members 中，其他 peer 应在
    expect(room.members).not.toContain('a');
    expect(room.members).toContain('other-peer');

    room.dispose();
  });
});

// ── performLeave 中 unsubscribeRoomSignaling 为 null 的 else 分支（line 200） ──

describe('performLeave unsubscribeRoomSignaling null', () => {
  test('leave 后再次 leave 时 unsubscribeRoomSignaling 应为 null', async () => {
    const adapter: RoomSignalingAdapter = {
      join: vi.fn(async () => []),
      leave: vi.fn(),
      sendTo: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
    };
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();

    // 第一次 leave 会调用 unsubscribeRoomSignaling 并置 null
    room.leave();
    expect(room.phase).toBe('left');

    // 重新 join
    await room.join();

    // 第二次 leave
    room.leave();
    expect(room.phase).toBe('left');

    room.dispose();
  });
});
