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
  const channels = new Map<string, { label: string; readyState: string }>();
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
    emitTo: vi.fn(),
    send: vi.fn(),
    createDataChannel: vi.fn((label: string) => {
      const channel = { label, readyState: 'open' };
      channels.set(label, channel);
      return channel;
    }),
    getChannel: vi.fn((label?: string) => {
      if (label === undefined) {
        return { label: 'default', readyState: 'open' };
      }
      return channels.get(label);
    }),
    getChannelLabels: vi.fn(() => [...channels.keys()]),
    getRemoteStreams: vi.fn(() => []),
    getStats: vi.fn(async () => new Map()),
    reconnect: vi.fn(async () => {}),
    /** 手动触发注册的事件 */
    __fireEvent(event: string, payload: unknown) {
      const handlers = eventHandlers.get(event) ?? [];
      for (const handler of handlers) {
        handler(payload);
      }
    },
    __eventHandlers: eventHandlers,
    __channels: channels,
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

// ── 多 DataChannel 支持 ──

describe('多 DataChannel 支持', () => {
  let room: RtcRoom;
  let handlers: Array<(msg: unknown) => void>;

  beforeEach(async () => {
    const mock = createMockAdapter();
    handlers = mock.handlers;
    room = createRtcRoom({ peerId: 'a', roomSignaling: mock.adapter });
    await room.join();
    // 模拟 peer 加入
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    latestMockController.phase = 'connected';
  });

  test('data-channel-closed 事件应桥接为 room 级事件', () => {
    const closedEvents: unknown[] = [];
    room.on('data-channel-closed', (event) => closedEvents.push(event));

    latestMockController.__fireEvent('data-channel-closed', { label: 'chat' });

    expect(closedEvents).toHaveLength(1);
    expect((closedEvents[0] as { peerId: string }).peerId).toBe('b');
    expect((closedEvents[0] as { label: string }).label).toBe('chat');

    room.dispose();
  });

  test('createDataChannel 应调用 controller.createDataChannel', () => {
    const channel = room.createDataChannel('b', 'file-transfer');
    expect(latestMockController.createDataChannel).toHaveBeenCalledWith('file-transfer', undefined);
    expect(channel.label).toBe('file-transfer');
    room.dispose();
  });

  test('getChannel 应代理到 controller.getChannel', () => {
    room.createDataChannel('b', 'chat');
    const channel = room.getChannel('b', 'chat');
    expect(latestMockController.getChannel).toHaveBeenCalledWith('chat');
    expect(channel?.label).toBe('chat');
    room.dispose();
  });

  test('getChannel 不传 label 返回默认通道', () => {
    const channel = room.getChannel('b');
    expect(latestMockController.getChannel).toHaveBeenCalledWith(undefined);
    expect(channel?.label).toBe('default');
    room.dispose();
  });

  test('getChannel peer 不存在时返回 undefined', () => {
    const channel = room.getChannel('nonexistent');
    expect(channel).toBeUndefined();
    room.dispose();
  });

  test('getChannelLabels 应代理到 controller.getChannelLabels', () => {
    room.createDataChannel('b', 'chat');
    room.createDataChannel('b', 'file');
    const labels = room.getChannelLabels('b');
    expect(labels).toContain('chat');
    expect(labels).toContain('file');
    room.dispose();
  });

  test('getChannelLabels peer 不存在时返回空数组', () => {
    const labels = room.getChannelLabels('nonexistent');
    expect(labels).toEqual([]);
    room.dispose();
  });

  test('sendTo 应调用 controller.emitTo', () => {
    // UserEvents 默认为空，用 as any 绕过类型检查触发运行时逻辑
    (room as any).sendTo('b', 'chat', 'greeting', 'hello');
    expect(latestMockController.emitTo).toHaveBeenCalledWith('chat', 'greeting', 'hello');
    room.dispose();
  });

  test('broadcastTo 应调用所有已连接 peer 的 controller.emitTo', () => {
    (room as any).broadcastTo('chat', 'greeting', 'hello');
    expect(latestMockController.emitTo).toHaveBeenCalledWith('chat', 'greeting', 'hello');
    room.dispose();
  });

  test('sendRaw(peerId, label, data) 应调用 controller.send(label, data)', () => {
    room.sendRaw('b', 'chat', 'raw-data');
    expect(latestMockController.send).toHaveBeenCalledWith('chat', 'raw-data');
    room.dispose();
  });

  test('sendRaw(peerId, data) 应调用 controller.send(data)', () => {
    const buffer = new ArrayBuffer(4);
    room.sendRaw('b', buffer);
    expect(latestMockController.send).toHaveBeenCalledWith(buffer);
    room.dispose();
  });

  test('broadcastRaw(label, data) 应调用 controller.send(label, data)', () => {
    room.broadcastRaw('chat', 'broadcast-raw');
    expect(latestMockController.send).toHaveBeenCalledWith('chat', 'broadcast-raw');
    room.dispose();
  });

  test('broadcastRaw(data) 应调用 controller.send(data)', () => {
    const buffer = new ArrayBuffer(4);
    room.broadcastRaw(buffer);
    expect(latestMockController.send).toHaveBeenCalledWith(buffer);
    room.dispose();
  });

  test('broadcastDataChannel 应为所有已连接 peer 创建同名通道', () => {
    room.broadcastDataChannel('file-transfer');
    expect(latestMockController.createDataChannel).toHaveBeenCalledWith('file-transfer', undefined);
    room.dispose();
  });

  test('broadcastDataChannel 应跳过未连接的 peer', () => {
    latestMockController.phase = 'connecting';
    latestMockController.createDataChannel.mockClear();
    room.broadcastDataChannel('file-transfer');
    expect(latestMockController.createDataChannel).not.toHaveBeenCalled();
    room.dispose();
  });

  test('broadcastTo 应跳过未连接的 peer（L281 continue 分支）', () => {
    latestMockController.phase = 'connecting';
    latestMockController.emitTo.mockClear();
    (room as any).broadcastTo('chat', 'greeting', 'hello');
    expect(latestMockController.emitTo).not.toHaveBeenCalled();
    room.dispose();
  });

  test('broadcastTo 无 payload 时应传 undefined（L478 cond-expr false 分支）', () => {
    latestMockController.emitTo.mockClear();
    (room as any).broadcastTo('chat', 'greeting');
    expect(latestMockController.emitTo).toHaveBeenCalledWith('chat', 'greeting', undefined);
    room.dispose();
  });

  test('sendTo 无 payload 时应传 undefined（L480 cond-expr false 分支）', () => {
    latestMockController.emitTo.mockClear();
    (room as any).sendTo('b', 'chat', 'greeting');
    expect(latestMockController.emitTo).toHaveBeenCalledWith('chat', 'greeting', undefined);
    room.dispose();
  });
});

describe('syncBroadcastChannels 防御分支', () => {
  test('peer 未连接时不应自动补建通道（L367 entry.phase !== connected 分支）', async () => {
    const { adapter, handlers } = createMockAdapter();
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();

    // 先有一个已连接 peer 来接收 broadcastDataChannel 注册
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    const controllerB = latestMockController;
    controllerB.phase = 'connected';
    controllerB.__fireEvent('connected', null);
    room.broadcastDataChannel('file-sync');

    // 新 peer 加入但不连接（phase 停留在 idle）
    handlers[0]?.({ type: 'member-joined', peerId: 'c' });
    const controllerC = latestMockController;
    controllerC.phase = 'idle';
    controllerC.createDataChannel.mockClear();
    // 手动触发 connected 事件但 phase 仍为 idle → syncBroadcastChannels 应走 entry.phase !== 'connected' 提前 return
    controllerC.__fireEvent('connected', null);

    expect(controllerC.createDataChannel).not.toHaveBeenCalled();

    room.dispose();
  });
});

describe('autoSyncBroadcastChannels 配置项', () => {
  test('默认启用：新 peer 连接后自动补建已注册的额外通道', async () => {
    const { adapter, handlers } = createMockAdapter();
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();

    // 先注册一个广播通道
    // 需要先有一个已连接 peer 来接收 broadcastDataChannel
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    const controllerB = latestMockController;
    controllerB.phase = 'connected';
    controllerB.__fireEvent('connected', null);

    room.broadcastDataChannel('file-sync');
    controllerB.createDataChannel.mockClear();

    // 新 peer 加入并连接 → 应自动补建 'file-sync' 通道
    handlers[0]?.({ type: 'member-joined', peerId: 'c' });
    const controllerC = latestMockController;
    controllerC.phase = 'connected';
    controllerC.createDataChannel.mockClear();
    controllerC.__fireEvent('connected', null);

    expect(controllerC.createDataChannel).toHaveBeenCalledWith('file-sync', undefined);

    room.dispose();
  });

  test('设为 false 时：新 peer 连接后不自动补建通道', async () => {
    const { adapter, handlers } = createMockAdapter();
    const room = createRtcRoom({
      peerId: 'a',
      roomSignaling: adapter,
      autoSyncBroadcastChannels: false,
    });
    await room.join();

    // 先注册广播通道
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    const controllerB = latestMockController;
    controllerB.phase = 'connected';
    controllerB.__fireEvent('connected', null);

    room.broadcastDataChannel('file-sync');

    // 新 peer 加入并连接 → 不应自动补建
    handlers[0]?.({ type: 'member-joined', peerId: 'c' });
    const controllerC = latestMockController;
    controllerC.phase = 'connected';
    controllerC.createDataChannel.mockClear();
    controllerC.__fireEvent('connected', null);

    expect(controllerC.createDataChannel).not.toHaveBeenCalled();

    room.dispose();
  });

  test('无已注册广播通道时：新 peer 连接后不触发 createDataChannel', async () => {
    const { adapter, handlers } = createMockAdapter();
    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();

    // 不调用 broadcastDataChannel，直接让新 peer 连接
    handlers[0]?.({ type: 'member-joined', peerId: 'b' });
    const controllerB = latestMockController;
    controllerB.phase = 'connected';
    controllerB.createDataChannel.mockClear();
    controllerB.__fireEvent('connected', null);

    expect(controllerB.createDataChannel).not.toHaveBeenCalled();

    room.dispose();
  });
});

// ── 覆盖率攻坚：room.ts 防御分支 ──

describe('performJoin 中途被 leave 应提前退出（L168-169 + L194 false 分支）', () => {
  test('join 等待期间调用 leave，后续流程不应复活状态', async () => {
    let joinResolve: (members: string[]) => void;
    const joinPromise = new Promise<string[]>((resolve) => {
      joinResolve = resolve;
    });

    const { adapter } = createMockAdapter();
    (adapter.join as ReturnType<typeof vi.fn>).mockReturnValue(joinPromise);

    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    const joinP = room.join();

    // join 尚未 resolve，此时调用 leave 使 phase 变为 left
    room.leave();

    // 现在让 join resolve，此时 phase 已不是 joining
    joinResolve!([]);
    await joinP.catch(() => {});

    // phase 应该不是 joined（因为 L168 的守卫 return 了）
    expect(room.phase).not.toBe('joined');

    room.dispose();
  });

  test('allSettled 后 phase 已非 joining 时不应 setPhase joined（L194 false 分支）', async () => {
    let connectResolve: () => void;
    const connectBlocker = new Promise<void>((resolve) => {
      connectResolve = resolve;
    });

    const { adapter } = createMockAdapter();
    // join 立即返回已有 member，使 L168 通过（phase 仍为 joining）
    (adapter.join as ReturnType<typeof vi.fn>).mockResolvedValue(['b']);

    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });

    const joinP = room.join();

    // 等一个 microtask 让 join resolve 后执行到 connect 调用
    await Promise.resolve();
    await Promise.resolve();

    // 此时 controller 已经创建，劫持其 connect 使其返回一个被控 promise
    latestMockController.connect.mockReturnValue(connectBlocker);

    // 在 connect 等待期间调用 leave，使 phase 变为 left
    room.leave();

    // 放行 connect promise，让 allSettled 完成
    connectResolve!();
    await joinP.catch(() => {});

    // allSettled 后 phase 不应该是 joined（因为 leave 把它变了）
    expect(room.phase).not.toBe('joined');

    room.dispose();
  });
});

describe('performLeave 中 roomSignaling.leave 返回 rejected promise（L219-220）', () => {
  test('leave 返回 rejected promise 时应通过 catch 回调记录错误', async () => {
    const { adapter } = createMockAdapter();
    (adapter.leave as ReturnType<typeof vi.fn>).mockReturnValue(Promise.reject(new Error('leave failed')));

    const room = createRtcRoom({ peerId: 'a', roomSignaling: adapter });
    await room.join();

    // leave 应该不抛异常（内部 catch 处理了）
    expect(() => room.leave()).not.toThrow();

    // 等一个 microtask 让 Promise.resolve().catch() 执行
    await Promise.resolve();

    expect(room.phase).toBe('left');
    room.dispose();
  });
});
