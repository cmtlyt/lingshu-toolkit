/**
 * Node 环境集成测试 — 覆盖 createRoom / createPeerEntry / bridgeControllerEvents
 *
 * 通过 mock createRtcController 在 node 环境执行 createRoom 全流程，
 * 覆盖 room.ts line 406-409、peer-manager.ts line 83/103、
 * bridgeControllerEvents 的 failed/track/track-removed 回调（line 47/51/55）、
 * unsubscribeRoomSignaling else 分支（line 200）
 */

import { beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import type { RoomSignalingAdapter, RtcRoom } from '../types';

// ── mock createRtcController ──

type EventHandler = (...args: unknown[]) => void;

function createMockController() {
  const eventHandlers = new Map<string, EventHandler[]>();
  return {
    phase: 'idle' as string,
    on(event: string, handler: EventHandler) {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
    connect: vi.fn(async () => {
      // 模拟连接成功
    }),
    dispose: vi.fn(),
    addTrack: vi.fn(() => ({}) as RTCRtpSender),
    removeTrack: vi.fn(),
    emit: vi.fn(),
    /** 手动触发注册的事件 */
    __fireEvent(event: string, payload: unknown) {
      const handlers = eventHandlers.get(event) ?? [];
      for (const handler of handlers) {
        handler(payload);
      }
    },
    __eventHandlers: eventHandlers,
  };
}

let latestMockController: ReturnType<typeof createMockController>;

vi.mock('@/shared/rtc-controller', () => {
  return {
    createRtcController: vi.fn(() => {
      latestMockController = createMockController();
      return latestMockController;
    }),
  };
});

// import 必须在 vi.mock 之后
const { createRtcRoom } = await import('../index');

// ── helpers ──

function createMockAdapter() {
  const handlers: Array<(msg: unknown) => void> = [];
  const adapter: RoomSignalingAdapter = {
    join: vi.fn(async () => []),
    leave: vi.fn(),
    sendTo: vi.fn(),
    onMessage(cb) {
      handlers.push(cb as (msg: unknown) => void);
      return () => {
        const index = handlers.indexOf(cb as (msg: unknown) => void);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      };
    },
  };
  return { adapter, handlers };
}

// ── tests ──

describe('createRoom 初始化覆盖（line 406-409）', () => {
  test('createRtcRoom 应成功创建房间实例', () => {
    const { adapter } = createMockAdapter();
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });

    expect(room.phase).toBe('idle');
    expect(room.peerId).toBe('a');
    room.dispose();
  });
});

describe('createPeerEntry 覆盖（line 83/103）+ bridgeControllerEvents 回调', () => {
  let room: RtcRoom;
  let handlers: Array<(msg: unknown) => void>;

  beforeEach(async () => {
    const mock = createMockAdapter();
    handlers = mock.handlers;
    room = createRtcRoom({ peerId: 'a', roomSignaling: mock.adapter });
    await room.join();
  });

  test('member-joined 应触发 createPeerEntry 并注册事件桥接', () => {
    // 触发 member-joined → 调用 createPeerEntry (line 83/103)
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    expect(room.members).toContain('b');

    // latestMockController 是 createPeerEntry 中创建的 mock controller
    // 验证 bridgeControllerEvents 注册了事件
    expect(latestMockController.__eventHandlers.has('connected')).toBe(true);
    expect(latestMockController.__eventHandlers.has('failed')).toBe(true);
    expect(latestMockController.__eventHandlers.has('track')).toBe(true);
    expect(latestMockController.__eventHandlers.has('track-removed')).toBe(true);

    room.dispose();
  });

  test('failed 回调应桥接为 peer-failed 事件（line 47-48）', () => {
    handlers[0]?.({ type: 'member-joined', peerId: 'c' });
    const controller = latestMockController;

    const failedEvents: unknown[] = [];
    room.on('peer-failed', (event) => failedEvents.push(event));

    // 触发 controller 的 failed 事件
    const fakeError = new Error('ice failed');
    controller.__fireEvent('failed', { error: fakeError });

    expect(failedEvents).toHaveLength(1);
    expect((failedEvents[0] as { peerId: string }).peerId).toBe('c');
    expect((failedEvents[0] as { error: Error }).error).toBe(fakeError);

    room.dispose();
  });

  test('track 回调应桥接为 track 事件（line 51-52）', () => {
    handlers[0]?.({ type: 'member-joined', peerId: 'd' });
    const controller = latestMockController;

    const trackEvents: unknown[] = [];
    room.on('track', (event) => trackEvents.push(event));

    const fakeTrack = { id: 'track-1' };
    const fakeStreams = [{ id: 'stream-1' }];
    controller.__fireEvent('track', { track: fakeTrack, streams: fakeStreams });

    expect(trackEvents).toHaveLength(1);
    expect((trackEvents[0] as { peerId: string }).peerId).toBe('d');
    expect((trackEvents[0] as { track: { id: string } }).track).toBe(fakeTrack);
    expect((trackEvents[0] as { streams: unknown[] }).streams).toBe(fakeStreams);

    room.dispose();
  });

  test('track-removed 回调应桥接为 track-removed 事件（line 55-56）', () => {
    handlers[0]?.({ type: 'member-joined', peerId: 'e' });
    const controller = latestMockController;

    const removedEvents: unknown[] = [];
    room.on('track-removed', (event) => removedEvents.push(event));

    const fakeTrack = { id: 'track-2' };
    controller.__fireEvent('track-removed', { track: fakeTrack });

    expect(removedEvents).toHaveLength(1);
    expect((removedEvents[0] as { peerId: string }).peerId).toBe('e');
    expect((removedEvents[0] as { track: { id: string } }).track).toBe(fakeTrack);

    room.dispose();
  });
});

describe('unsubscribeRoomSignaling else 分支（line 200）', () => {
  test('dispose 不经 join 时 unsubscribeRoomSignaling 应为 null', () => {
    const { adapter } = createMockAdapter();
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });

    // 未 join 直接 dispose — performLeave 中 unsubscribeRoomSignaling 为 null
    expect(() => room.dispose()).not.toThrow();
    expect(room.phase).toBe('disposed');
  });

  test('leave 后再 join 再 leave 覆盖 unsubscribeRoomSignaling 非 null 和 null 路径', async () => {
    const { adapter } = createMockAdapter();
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });

    await room.join();
    room.leave(); // 第一次 leave: unsubscribeRoomSignaling 非 null → 调用并置 null
    expect(room.phase).toBe('left');

    await room.join();
    room.leave(); // 第二次 leave: 新的 unsubscribeRoomSignaling
    expect(room.phase).toBe('left');

    room.dispose();
  });

  test('joining 状态下 dispose 应走 unsubscribeRoomSignaling 为 null 的 else 分支', async () => {
    const { adapter } = createMockAdapter();
    // join 永远不 resolve，使 phase 停在 joining，此时 unsubscribeRoomSignaling 仍为 null
    (adapter.join as Mock).mockReturnValue(new Promise(() => {}));

    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });

    // 发起 join 但不 await（会挂起）
    const _joinPromise = room.join();
    expect(room.phase).toBe('joining');

    // 在 joining 状态 dispose → performLeave 执行到 line 200，unsubscribeRoomSignaling 为 null
    room.dispose();
    expect(room.phase).toBe('disposed');

    // joinPromise 会因为超时竞争或直接被忽略（dispose 后不影响）
    // 不 await joinPromise，避免挂起
  });
});

describe('performJoin 中 existingMembers 包含自己的 peerId（line 167-168 continue）', () => {
  test('join 返回包含自己 peerId 时应跳过', async () => {
    const { adapter } = createMockAdapter();
    (adapter.join as Mock).mockResolvedValueOnce(['a', 'remote-peer']);

    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter, connectTimeout: 100 });

    await room.join();

    // 自己不应出现在 members 中
    expect(room.members).not.toContain('a');
    expect(room.members).toContain('remote-peer');

    room.dispose();
  });
});
