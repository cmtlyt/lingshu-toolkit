/**
 * drivers/broadcast-state.ts 覆盖率补强测试（Tier 3）
 *
 * 直接 import 内部纯函数，命中正常 createBroadcastDriver 主链路下不易触达的防御分支。
 *
 * 设计约束：
 * - 不重写源码逻辑（尤其是正常链路不可达的代码不允许通过重写让其可达）
 * - 不依赖 v8 ignore 注释绕过未覆盖项
 * - 通过构造伪 state（含 stub 化的 ChannelAdapter）触发各类状态机分支
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import * as broadcastProtocol from '../../drivers/broadcast-protocol';
import {
  abandonPendingAnnounce,
  abandonPendingForce,
  type BroadcastDriverState,
  drainOnDestroy,
  enterHolding,
  enterRemoteHeld,
  type HoldingState,
  handleAnnounce,
  handleForce,
  handleHeartbeat,
  handleMessage,
  handleReject,
  handleRelease,
  handleRemoteDead,
  pumpNextWaiter,
  type RemoteHeldState,
  removeWaiter,
  revokeHolding,
  startAnnounceCampaign,
  startForceCampaign,
  type Waiter,
} from '../../drivers/broadcast-state';
import type { ChannelAdapter, LockDriverHandle, LoggerAdapter } from '../../types';

const HEARTBEAT_INTERVAL_MS = 1000;
const DEAD_THRESHOLD_MS = 3000;

function createLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

interface FakeChannel extends ChannelAdapter {
  readonly sent: unknown[];
  triggerMessage: ((raw: unknown) => void) | null;
}

function createFakeChannel(): FakeChannel {
  const sent: unknown[] = [];
  const channel: FakeChannel = {
    sent,
    triggerMessage: null,
    postMessage: (msg: unknown) => {
      sent.push(msg);
    },
    subscribe: (handler: (raw: unknown) => void) => {
      channel.triggerMessage = handler;
      return () => {
        channel.triggerMessage = null;
      };
    },
    close: vi.fn(),
  };
  return channel;
}

function createFakeState(overrides: Partial<BroadcastDriverState> = {}): BroadcastDriverState {
  const logger = createLogger();
  const channel = createFakeChannel();
  return {
    deps: {
      id: 'test-id',
      name: 'broadcast-state-test',
      logger,
    } as unknown as BroadcastDriverState['deps'],
    channel,
    senderId: 'sender-self',
    status: { kind: 'idle' },
    waiters: [],
    pendingAnnounce: null,
    pendingForce: null,
    destroyed: false,
    unsubscribe: null,
    ...overrides,
  };
}

function makeWaiter(overrides: Partial<Waiter> = {}): Waiter {
  return {
    token: 'token-fake',
    resolve: vi.fn<(handle: LockDriverHandle) => void>(),
    reject: vi.fn<(error: Error) => void>(),
    abort: vi.fn<(error: Error) => void>(),
    ...overrides,
  };
}

function makeHolding(overrides: Partial<HoldingState> = {}): HoldingState {
  return {
    kind: 'holding',
    token: 'me',
    grantedAt: 100,
    released: false,
    revokeCallback: null,
    heartbeatTimer: null,
    ...overrides,
  };
}

function makeRemoteHeld(overrides: Partial<RemoteHeldState> = {}): RemoteHeldState {
  return {
    kind: 'remote-held',
    token: 'remote',
    peerTs: 100,
    lastHeartbeat: 100,
    deadTimer: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('drivers/broadcast-state — removeWaiter', () => {
  test('从队列中移除目标 waiter', () => {
    const w1 = makeWaiter({ token: 'a' });
    const w2 = makeWaiter({ token: 'b' });
    const list: Waiter[] = [w1, w2];
    removeWaiter(list, w2);
    expect(list).toEqual([w1]);
  });

  test('目标不存在 → 队列不变', () => {
    const w1 = makeWaiter({ token: 'a' });
    const stranger = makeWaiter({ token: 'x' });
    const list: Waiter[] = [w1];
    removeWaiter(list, stranger);
    expect(list).toEqual([w1]);
  });
});

describe('drivers/broadcast-state — enterHolding / handle.release', () => {
  test('enterHolding 切换状态 + 立即广播 heartbeat', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const handle = enterHolding(state, 'me');

    expect(state.status.kind).toBe('holding');
    expect((state.channel as FakeChannel).sent).toHaveLength(1);
    expect((state.channel as FakeChannel).sent[0]).toMatchObject({
      kind: 'heartbeat',
      token: 'me',
      senderId: 'sender-self',
    });
    expect(typeof handle.release).toBe('function');

    handle.release();
    expect(state.status.kind).toBe('idle');
    // release 又广播了一条
    const sent = (state.channel as FakeChannel).sent;
    expect(sent[sent.length - 1]).toMatchObject({ kind: 'release', token: 'me' });
  });

  test('handle.release 重复调用 → 幂等', () => {
    const state = createFakeState();
    const handle = enterHolding(state, 'me');
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  test('handle.onRevokedByDriver 在 holding 下注册 callback；释放后注册无效', () => {
    const state = createFakeState();
    const handle = enterHolding(state, 'me');
    const cb = vi.fn();
    handle.onRevokedByDriver(cb);
    expect(state.status.kind).toBe('holding');
    expect((state.status as HoldingState).revokeCallback).toBe(cb);

    handle.release();
    const cb2 = vi.fn();
    handle.onRevokedByDriver(cb2);
    expect(state.status.kind).toBe('idle');
  });
});

describe('drivers/broadcast-state — enterRemoteHeld', () => {
  test('从 idle 进入 remote-held → 启动 dead timer', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    enterRemoteHeld(state, 'remote', 100);
    expect(state.status.kind).toBe('remote-held');
    expect((state.status as RemoteHeldState).token).toBe('remote');
    expect((state.status as RemoteHeldState).deadTimer).not.toBeNull();
  });

  test('已有 remote-held → 重置 dead timer（停旧启新）', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    enterRemoteHeld(state, 'remote-1', 100);
    const oldTimer = (state.status as RemoteHeldState).deadTimer;
    enterRemoteHeld(state, 'remote-2', 200);
    expect((state.status as RemoteHeldState).token).toBe('remote-2');
    expect((state.status as RemoteHeldState).deadTimer).not.toBe(oldTimer);
  });
});

describe('drivers/broadcast-state — revokeHolding', () => {
  test('status 非 holding → 早退', () => {
    const state = createFakeState();
    expect(() => revokeHolding(state, 'force')).not.toThrow();
    expect(state.status.kind).toBe('idle');
  });

  test('holding.released=true → 早退', () => {
    const cb = vi.fn();
    const state = createFakeState();
    state.status = makeHolding({ released: true, revokeCallback: cb });
    revokeHolding(state, 'force');
    expect(cb).not.toHaveBeenCalled();
  });

  test('正常 revoke：清状态 + 触发 callback', () => {
    const cb = vi.fn();
    const state = createFakeState();
    state.status = makeHolding({ revokeCallback: cb });
    revokeHolding(state, 'force');
    expect(cb).toHaveBeenCalledWith('force');
    expect(state.status.kind).toBe('idle');
  });

  test('callback 抛错 → logger.error 捕获', () => {
    const cb = vi.fn(() => {
      throw new Error('cb-boom');
    });
    const state = createFakeState();
    state.status = makeHolding({ revokeCallback: cb });
    expect(() => revokeHolding(state, 'timeout')).not.toThrow();
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('revoke callback threw'),
      expect.any(Error),
    );
  });

  test('callback=null → 不调 callback 也不抛错', () => {
    const state = createFakeState();
    state.status = makeHolding({ revokeCallback: null });
    expect(() => revokeHolding(state, 'force')).not.toThrow();
    expect(state.status.kind).toBe('idle');
  });
});

describe('drivers/broadcast-state — abandonPendingAnnounce', () => {
  test('pendingAnnounce=null → 早退', () => {
    const state = createFakeState();
    expect(() => abandonPendingAnnounce(state, 'reason')).not.toThrow();
  });

  test('pendingAnnounce.abandoned=true → 早退', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingAnnounce = {
      requestId: 'req',
      ts: 100,
      waiter: w,
      abandoned: true,
      timer: null,
    };
    abandonPendingAnnounce(state, 'reason');
    expect(state.pendingAnnounce).not.toBeNull();
    expect(state.waiters).not.toContain(w);
  });

  test('正常 abandon：清 timer + 回队', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const w = makeWaiter();
    const timer = setTimeout(() => {}, 1_000_000);
    state.pendingAnnounce = {
      requestId: 'req',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer,
    };
    abandonPendingAnnounce(state, 'reason');
    expect(state.pendingAnnounce).toBeNull();
    expect(state.waiters).toContain(w);
  });

  test('timer=null → 不清 timer 但仍回队', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingAnnounce = {
      requestId: 'req',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    abandonPendingAnnounce(state, 'reason');
    expect(state.pendingAnnounce).toBeNull();
    expect(state.waiters).toContain(w);
  });
});

describe('drivers/broadcast-state — abandonPendingForce', () => {
  test('pendingForce=null → 早退', () => {
    const state = createFakeState();
    expect(() => abandonPendingForce(state, 'reason')).not.toThrow();
  });

  test('pendingForce.abandoned=true → 早退', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingForce = {
      token: 'me',
      ts: 100,
      waiter: w,
      abandoned: true,
      timer: null,
    };
    abandonPendingForce(state, 'reason');
    expect(state.pendingForce).not.toBeNull();
  });

  test('正常 abandon：清 timer + 回队', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const w = makeWaiter();
    const timer = setTimeout(() => {}, 1_000_000);
    state.pendingForce = {
      token: 'me',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer,
    };
    abandonPendingForce(state, 'reason');
    expect(state.pendingForce).toBeNull();
    expect(state.waiters).toContain(w);
  });

  test('timer=null → 不清 timer 但仍回队', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingForce = {
      token: 'me',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    abandonPendingForce(state, 'reason');
    expect(state.pendingForce).toBeNull();
    expect(state.waiters).toContain(w);
  });
});

describe('drivers/broadcast-state — handleRemoteDead', () => {
  test('status 非 remote-held → 早退', () => {
    const state = createFakeState();
    expect(() => handleRemoteDead(state, 'remote')).not.toThrow();
    expect(state.status.kind).toBe('idle');
  });

  test('remote-held 但 token 不匹配 → 早退', () => {
    const state = createFakeState();
    state.status = makeRemoteHeld({ token: 'remote-1' });
    handleRemoteDead(state, 'remote-2');
    expect(state.status.kind).toBe('remote-held');
  });

  test('正常 dead：清状态 + 触发 pump（启动 announce 竞选）', () => {
    const state = createFakeState();
    state.status = makeRemoteHeld({ token: 'remote' });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    state.waiters.push(makeWaiter({ token: 'me', resolve }));

    handleRemoteDead(state, 'remote');
    // pumpNextWaiter 启动 announce 竞选 → status 仍 idle 但 pendingAnnounce 已设置
    expect(state.pendingAnnounce).not.toBeNull();
    expect(state.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dead by heartbeat timeout'));
  });

  test('正常 dead 且无 waiter → 仅清状态', () => {
    const state = createFakeState();
    state.status = makeRemoteHeld({ token: 'remote' });
    handleRemoteDead(state, 'remote');
    expect(state.status.kind).toBe('idle');
    expect(state.pendingAnnounce).toBeNull();
  });
});

describe('drivers/broadcast-state — handleAnnounce', () => {
  test('msg.senderId === 自己 → 早退', () => {
    const state = createFakeState();
    handleAnnounce(state, {
      kind: 'announce',
      senderId: state.senderId,
      requestId: 'req',
      token: 'other',
      ts: 100,
      force: false,
    });
    expect((state.channel as FakeChannel).sent).toHaveLength(0);
  });

  test('holding 状态 + token 不同 → 广播 reject', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me' });
    handleAnnounce(state, {
      kind: 'announce',
      senderId: 'peer',
      requestId: 'req',
      token: 'attacker',
      ts: 100,
      force: false,
    });
    const sent = (state.channel as FakeChannel).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'reject', requestId: 'req', holderToken: 'me' });
  });

  test('holding 状态 + released=true → 不广播 reject，进入仲裁路径', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me', released: true });
    handleAnnounce(state, {
      kind: 'announce',
      senderId: 'peer',
      requestId: 'req',
      token: 'other',
      ts: 100,
      force: false,
    });
    expect((state.channel as FakeChannel).sent).toHaveLength(0);
  });

  test('pendingAnnounce 仲裁：我方更早 → 保持', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingAnnounce = {
      requestId: 'mine',
      ts: 100, // 我方更早
      waiter: w,
      abandoned: false,
      timer: null,
    };
    handleAnnounce(state, {
      kind: 'announce',
      senderId: 'peer',
      requestId: 'theirs',
      token: 'other',
      ts: 200,
      force: false,
    });
    expect(state.pendingAnnounce).not.toBeNull();
    expect(state.pendingAnnounce?.abandoned).toBe(false);
  });

  test('pendingAnnounce 仲裁：对方更早 → abandon 自己', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingAnnounce = {
      requestId: 'mine',
      ts: 200,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    handleAnnounce(state, {
      kind: 'announce',
      senderId: 'peer',
      requestId: 'theirs',
      token: 'other',
      ts: 100,
      force: false,
    });
    expect(state.pendingAnnounce).toBeNull();
    expect(state.waiters).toContain(w);
  });

  test('pendingAnnounce.abandoned=true → 不仲裁', () => {
    const state = createFakeState();
    state.pendingAnnounce = {
      requestId: 'mine',
      ts: 100,
      waiter: makeWaiter(),
      abandoned: true,
      timer: null,
    };
    handleAnnounce(state, {
      kind: 'announce',
      senderId: 'peer',
      requestId: 'theirs',
      token: 'other',
      ts: 200,
      force: false,
    });
    expect(state.pendingAnnounce?.abandoned).toBe(true);
  });

  test('idle + 无 pending → 不响应', () => {
    const state = createFakeState();
    handleAnnounce(state, {
      kind: 'announce',
      senderId: 'peer',
      requestId: 'req',
      token: 'other',
      ts: 100,
      force: false,
    });
    expect((state.channel as FakeChannel).sent).toHaveLength(0);
    expect(state.status.kind).toBe('idle');
  });
});

describe('drivers/broadcast-state — handleReject', () => {
  test('senderId === 自己 → 早退', () => {
    const state = createFakeState();
    handleReject(state, {
      kind: 'reject',
      senderId: state.senderId,
      requestId: 'req',
      holderToken: 'other',
      holderTs: 100,
    });
    expect(state.status.kind).toBe('idle');
  });

  test('holding 下收到他人 reject（token 不同）→ revoke 自己 + 切 remote-held', () => {
    const cb = vi.fn();
    const state = createFakeState();
    state.status = makeHolding({ token: 'me', revokeCallback: cb });
    handleReject(state, {
      kind: 'reject',
      senderId: 'peer',
      requestId: 'req',
      holderToken: 'attacker',
      holderTs: 200,
    });
    expect(cb).toHaveBeenCalledWith('force');
    expect(state.status.kind).toBe('remote-held');
    expect(state.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('double-hold detected'));
  });

  test('holding 下收到他人 reject（token 相同）→ 不 revoke', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me' });
    handleReject(state, {
      kind: 'reject',
      senderId: 'peer',
      requestId: 'req',
      holderToken: 'me',
      holderTs: 200,
    });
    expect(state.status.kind).toBe('holding');
  });

  test('pendingAnnounce 被明确拒绝 → abandon', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingAnnounce = {
      requestId: 'req-x',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    handleReject(state, {
      kind: 'reject',
      senderId: 'peer',
      requestId: 'req-x',
      holderToken: 'other',
      holderTs: 100,
    });
    expect(state.pendingAnnounce).toBeNull();
    expect(state.status.kind).toBe('remote-held');
  });

  test('pendingAnnounce.requestId 不匹配 → 不 abandon 但仍切 remote-held', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingAnnounce = {
      requestId: 'req-mine',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    handleReject(state, {
      kind: 'reject',
      senderId: 'peer',
      requestId: 'req-other',
      holderToken: 'other',
      holderTs: 100,
    });
    expect(state.pendingAnnounce).not.toBeNull();
    expect(state.status.kind).toBe('remote-held');
  });

  test('idle 下收到 reject → 切 remote-held', () => {
    const state = createFakeState();
    handleReject(state, {
      kind: 'reject',
      senderId: 'peer',
      requestId: 'req',
      holderToken: 'other',
      holderTs: 100,
    });
    expect(state.status.kind).toBe('remote-held');
  });

  test('remote-held 下收到 reject → 更新 remote-held（重置 deadTimer）', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    state.status = makeRemoteHeld({ token: 'remote' });
    handleReject(state, {
      kind: 'reject',
      senderId: 'peer',
      requestId: 'req',
      holderToken: 'remote',
      holderTs: 200,
    });
    expect(state.status.kind).toBe('remote-held');
  });
});

describe('drivers/broadcast-state — handleHeartbeat', () => {
  test('senderId === 自己 → 早退', () => {
    const state = createFakeState();
    handleHeartbeat(state, {
      kind: 'heartbeat',
      senderId: state.senderId,
      token: 'me',
      ts: 100,
    });
    expect(state.status.kind).toBe('idle');
  });

  test('holding + token 相同（自我心跳的回响）→ 早退', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me' });
    handleHeartbeat(state, {
      kind: 'heartbeat',
      senderId: 'peer',
      token: 'me',
      ts: 100,
    });
    expect(state.status.kind).toBe('holding');
  });

  test('holding + token 不同 → 双持冲突 revoke 自己', () => {
    const cb = vi.fn();
    const state = createFakeState();
    state.status = makeHolding({ token: 'me', revokeCallback: cb });
    handleHeartbeat(state, {
      kind: 'heartbeat',
      senderId: 'peer',
      token: 'attacker',
      ts: 100,
    });
    expect(cb).toHaveBeenCalledWith('force');
    expect(state.status.kind).toBe('remote-held');
    expect(state.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('double-hold detected via heartbeat'));
  });

  test('holding + token 不同但 released=true → 不进入双持冲突分支', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me', released: true });
    handleHeartbeat(state, {
      kind: 'heartbeat',
      senderId: 'peer',
      token: 'other',
      ts: 100,
    });
    // 走到后面切 remote-held
    expect(state.status.kind).toBe('remote-held');
  });

  test('pendingAnnounce 存在 + heartbeat → abandon pending', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingAnnounce = {
      requestId: 'req',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    handleHeartbeat(state, {
      kind: 'heartbeat',
      senderId: 'peer',
      token: 'other',
      ts: 100,
    });
    expect(state.pendingAnnounce).toBeNull();
    expect(state.status.kind).toBe('remote-held');
  });

  test('pendingAnnounce.abandoned=true → 不重复 abandon', () => {
    const state = createFakeState();
    state.pendingAnnounce = {
      requestId: 'req',
      ts: 100,
      waiter: makeWaiter(),
      abandoned: true,
      timer: null,
    };
    handleHeartbeat(state, {
      kind: 'heartbeat',
      senderId: 'peer',
      token: 'other',
      ts: 100,
    });
    expect(state.pendingAnnounce?.abandoned).toBe(true);
  });

  test('idle + 无 pending → 直接切 remote-held', () => {
    const state = createFakeState();
    handleHeartbeat(state, {
      kind: 'heartbeat',
      senderId: 'peer',
      token: 'other',
      ts: 100,
    });
    expect(state.status.kind).toBe('remote-held');
  });
});

describe('drivers/broadcast-state — handleRelease', () => {
  test('senderId === 自己 → 早退', () => {
    const state = createFakeState();
    handleRelease(state, {
      kind: 'release',
      senderId: state.senderId,
      token: 'me',
    });
    expect(state.status.kind).toBe('idle');
  });

  test('remote-held + token 匹配 → 切 idle + pump', () => {
    const state = createFakeState();
    state.status = makeRemoteHeld({ token: 'remote' });
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    state.waiters.push(makeWaiter({ token: 'me', resolve }));

    handleRelease(state, {
      kind: 'release',
      senderId: 'peer',
      token: 'remote',
    });
    // pump 走 announce 流程 → status 变成 holding（有 pending）或保持 idle 等仲裁
    // 根据 pumpNextWaiter 实现，会启动 announce 竞选 → pendingAnnounce 非 null
    expect(state.pendingAnnounce).not.toBeNull();
  });

  test('remote-held + token 不匹配 → 不动状态', () => {
    const state = createFakeState();
    state.status = makeRemoteHeld({ token: 'remote-a' });
    handleRelease(state, {
      kind: 'release',
      senderId: 'peer',
      token: 'remote-b',
    });
    expect(state.status.kind).toBe('remote-held');
  });

  test('idle 状态 → 不动', () => {
    const state = createFakeState();
    handleRelease(state, {
      kind: 'release',
      senderId: 'peer',
      token: 'remote',
    });
    expect(state.status.kind).toBe('idle');
  });

  test('holding 状态 → 不动（其他 Tab 的 release 与本方持锁无关）', () => {
    const state = createFakeState();
    state.status = makeHolding();
    handleRelease(state, {
      kind: 'release',
      senderId: 'peer',
      token: 'other',
    });
    expect(state.status.kind).toBe('holding');
  });
});

describe('drivers/broadcast-state — handleForce', () => {
  test('senderId === 自己 → 早退', () => {
    const state = createFakeState();
    handleForce(state, {
      kind: 'force',
      senderId: state.senderId,
      token: 'me',
      ts: 100,
    });
    expect(state.status.kind).toBe('idle');
  });

  test('pendingForce 仲裁：我方更早 → 保持', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingForce = {
      token: 'me',
      ts: 100,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    handleForce(state, {
      kind: 'force',
      senderId: 'peer',
      token: 'other',
      ts: 200,
    });
    expect(state.pendingForce).not.toBeNull();
    expect(state.pendingForce?.abandoned).toBe(false);
  });

  test('pendingForce 仲裁：对方更早 → abandon 自己', () => {
    const state = createFakeState();
    const w = makeWaiter();
    state.pendingForce = {
      token: 'me',
      ts: 200,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    handleForce(state, {
      kind: 'force',
      senderId: 'peer',
      token: 'other',
      ts: 100,
    });
    expect(state.pendingForce).toBeNull();
  });

  test('pendingForce.abandoned=true → 不仲裁', () => {
    const state = createFakeState();
    state.pendingForce = {
      token: 'me',
      ts: 100,
      waiter: makeWaiter(),
      abandoned: true,
      timer: null,
    };
    handleForce(state, {
      kind: 'force',
      senderId: 'peer',
      token: 'other',
      ts: 200,
    });
    expect(state.pendingForce?.abandoned).toBe(true);
  });

  test('holding + token 不同 → revoke 自己 + 切 remote-held', () => {
    const cb = vi.fn();
    const state = createFakeState();
    state.status = makeHolding({ token: 'me', revokeCallback: cb });
    handleForce(state, {
      kind: 'force',
      senderId: 'peer',
      token: 'attacker',
      ts: 100,
    });
    expect(cb).toHaveBeenCalledWith('force');
    expect(state.status.kind).toBe('remote-held');
  });

  test('holding + token 相同 → 不 revoke', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me' });
    handleForce(state, {
      kind: 'force',
      senderId: 'peer',
      token: 'me',
      ts: 100,
    });
    expect(state.status.kind).toBe('remote-held');
  });

  test('holding + token 不同 + released=true → 不进入 revoke 分支', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me', released: true });
    handleForce(state, {
      kind: 'force',
      senderId: 'peer',
      token: 'attacker',
      ts: 100,
    });
    expect(state.status.kind).toBe('remote-held');
  });
});

describe('drivers/broadcast-state — handleMessage 分发', () => {
  test('非合法 broadcast message → 早退', () => {
    const state = createFakeState();
    handleMessage(state, 'not-a-message');
    handleMessage(state, null);
    handleMessage(state, { foo: 'bar' });
    expect(state.status.kind).toBe('idle');
  });

  test.each([
    ['announce', { kind: 'announce', senderId: 'peer', requestId: 'r', token: 't', ts: 1, force: false }],
    ['reject', { kind: 'reject', senderId: 'peer', requestId: 'r', holderToken: 't', holderTs: 1 }],
    ['heartbeat', { kind: 'heartbeat', senderId: 'peer', token: 't', ts: 1 }],
    ['release', { kind: 'release', senderId: 'peer', token: 't' }],
    ['force', { kind: 'force', senderId: 'peer', token: 't', ts: 1 }],
  ])('分发 %s → 不抛错', (_name, msg) => {
    const state = createFakeState();
    expect(() => handleMessage(state, msg)).not.toThrow();
  });
});

describe('drivers/broadcast-state — pumpNextWaiter', () => {
  test('destroyed → 早退', () => {
    const state = createFakeState({ destroyed: true });
    state.waiters.push(makeWaiter());
    pumpNextWaiter(state);
    expect(state.pendingAnnounce).toBeNull();
  });

  test('status 非 idle → 早退', () => {
    const state = createFakeState();
    state.status = makeHolding();
    state.waiters.push(makeWaiter());
    pumpNextWaiter(state);
    expect(state.pendingAnnounce).toBeNull();
  });

  test('队列空 → 早退', () => {
    const state = createFakeState();
    pumpNextWaiter(state);
    expect(state.pendingAnnounce).toBeNull();
  });

  test('已有 pendingAnnounce → 早退', () => {
    const state = createFakeState();
    const existing = makeWaiter({ token: 'existing' });
    state.pendingAnnounce = {
      requestId: 'req',
      ts: 100,
      waiter: existing,
      abandoned: false,
      timer: null,
    };
    state.waiters.push(makeWaiter({ token: 'next' }));
    pumpNextWaiter(state);
    expect(state.pendingAnnounce?.waiter).toBe(existing);
  });

  test('已有 pendingForce → 早退', () => {
    const state = createFakeState();
    state.pendingForce = {
      token: 'forcing',
      ts: 100,
      waiter: makeWaiter({ token: 'forcing' }),
      abandoned: false,
      timer: null,
    };
    state.waiters.push(makeWaiter({ token: 'next' }));
    pumpNextWaiter(state);
    expect(state.pendingAnnounce).toBeNull();
  });

  test('正常 pump：取队首启动 announce 竞选', () => {
    const state = createFakeState();
    const w = makeWaiter({ token: 'next' });
    state.waiters.push(w);
    pumpNextWaiter(state);
    expect(state.pendingAnnounce).not.toBeNull();
    expect(state.pendingAnnounce?.waiter).toBe(w);
    expect(state.waiters).not.toContain(w);
  });
});

describe('drivers/broadcast-state — startAnnounceCampaign', () => {
  test('destroyed → logger.error 后早退', () => {
    const state = createFakeState({ destroyed: true });
    const w = makeWaiter();
    startAnnounceCampaign(state, w);
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('startAnnounceCampaign called after destroyed'),
    );
  });

  test('status 非 idle → 前置违反，logger.error + 回队', () => {
    const state = createFakeState();
    state.status = makeHolding();
    const w = makeWaiter();
    startAnnounceCampaign(state, w);
    expect(state.deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('precondition violated'));
    expect(state.waiters).toContain(w);
  });

  test('已有 pendingAnnounce → 前置违反', () => {
    const state = createFakeState();
    state.pendingAnnounce = {
      requestId: 'r',
      ts: 1,
      waiter: makeWaiter(),
      abandoned: false,
      timer: null,
    };
    const w = makeWaiter();
    startAnnounceCampaign(state, w);
    expect(state.deps.logger.error).toHaveBeenCalled();
    expect(state.waiters).toContain(w);
  });

  test('已有 pendingForce → 前置违反', () => {
    const state = createFakeState();
    state.pendingForce = {
      token: 'x',
      ts: 1,
      waiter: makeWaiter({ token: 'x' }),
      abandoned: false,
      timer: null,
    };
    const w = makeWaiter();
    startAnnounceCampaign(state, w);
    expect(state.deps.logger.error).toHaveBeenCalled();
  });

  test('正常 announce：广播 + 设置 timer + 窗口到期 enter holding', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'next', resolve });
    startAnnounceCampaign(state, w);

    expect(state.pendingAnnounce).not.toBeNull();
    const sent = (state.channel as FakeChannel).sent;
    expect(sent[0]).toMatchObject({ kind: 'announce', token: 'next' });

    // 推进窗口到期
    vi.runOnlyPendingTimers();

    expect(state.pendingAnnounce).toBeNull();
    expect(state.status.kind).toBe('holding');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('窗口期间被 abandon → timer 触发但 abandoned=true 早退', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'next', resolve });
    startAnnounceCampaign(state, w);

    // 模拟窗口期间被 abandon
    if (state.pendingAnnounce) {
      state.pendingAnnounce.abandoned = true;
    }

    vi.runOnlyPendingTimers();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('窗口到期时 destroyed → 早退', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'next', resolve });
    startAnnounceCampaign(state, w);

    state.destroyed = true;
    vi.runOnlyPendingTimers();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('drivers/broadcast-state — startForceCampaign', () => {
  test('destroyed → logger.error 后早退', () => {
    const state = createFakeState({ destroyed: true });
    const w = makeWaiter();
    startForceCampaign(state, w);
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('startForceCampaign called after destroyed'),
    );
  });

  test('本方持锁中 → 先 revoke 自己再抢', () => {
    const state = createFakeState();
    const cb = vi.fn();
    state.status = makeHolding({ token: 'self', revokeCallback: cb });
    const w = makeWaiter({ token: 'force-me' });
    startForceCampaign(state, w);

    expect(cb).toHaveBeenCalledWith('force');
    expect(state.pendingForce).not.toBeNull();
  });

  test('本方持锁但 released=true → 不重复 revoke', () => {
    const state = createFakeState();
    const cb = vi.fn();
    state.status = makeHolding({ token: 'self', released: true, revokeCallback: cb });
    const w = makeWaiter({ token: 'force-me' });
    startForceCampaign(state, w);
    // released=true 时 revokeHolding 不会调 callback
    expect(cb).not.toHaveBeenCalled();
  });

  test('正常 force：广播 + 设置 timer + 窗口到期 enter holding', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'force-me', resolve });
    startForceCampaign(state, w);

    expect(state.pendingForce).not.toBeNull();
    const sent = (state.channel as FakeChannel).sent;
    expect(sent[0]).toMatchObject({ kind: 'force', token: 'force-me' });

    vi.runOnlyPendingTimers();
    expect(state.pendingForce).toBeNull();
    expect(state.status.kind).toBe('holding');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('窗口期间被 abandon → timer 触发但 abandoned=true 早退', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'force-me', resolve });
    startForceCampaign(state, w);

    if (state.pendingForce) {
      state.pendingForce.abandoned = true;
    }
    vi.runOnlyPendingTimers();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('窗口到期时 destroyed → 早退', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const resolve = vi.fn<(handle: LockDriverHandle) => void>();
    const w = makeWaiter({ token: 'force-me', resolve });
    startForceCampaign(state, w);

    state.destroyed = true;
    vi.runOnlyPendingTimers();
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('drivers/broadcast-state — drainOnDestroy', () => {
  function buildAbortError(token: string): Error {
    return new Error(`aborted token=${token}`);
  }

  test('idle + 无 waiter / pending → 平稳收尾', () => {
    const state = createFakeState();
    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
    expect((state.channel as FakeChannel).close).toHaveBeenCalledTimes(1);
  });

  test('清理 pendingAnnounce + abort waiter', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const w = makeWaiter({ token: 'pending-a' });
    const timer = setTimeout(() => {}, 1_000_000);
    state.pendingAnnounce = {
      requestId: 'r',
      ts: 1,
      waiter: w,
      abandoned: false,
      timer,
    };
    drainOnDestroy(state, buildAbortError);
    expect(state.pendingAnnounce).toBeNull();
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('pendingAnnounce.timer=null → 跳过 clearTimeout', () => {
    const state = createFakeState();
    const w = makeWaiter({ token: 'pending-a' });
    state.pendingAnnounce = {
      requestId: 'r',
      ts: 1,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    drainOnDestroy(state, buildAbortError);
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('清理 pendingForce + abort waiter', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    const w = makeWaiter({ token: 'pending-f' });
    const timer = setTimeout(() => {}, 1_000_000);
    state.pendingForce = {
      token: 'pending-f',
      ts: 1,
      waiter: w,
      abandoned: false,
      timer,
    };
    drainOnDestroy(state, buildAbortError);
    expect(state.pendingForce).toBeNull();
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('pendingForce.timer=null → 跳过 clearTimeout', () => {
    const state = createFakeState();
    const w = makeWaiter({ token: 'pending-f' });
    state.pendingForce = {
      token: 'pending-f',
      ts: 1,
      waiter: w,
      abandoned: false,
      timer: null,
    };
    drainOnDestroy(state, buildAbortError);
    expect(w.abort).toHaveBeenCalledTimes(1);
  });

  test('普通 waiter 队列 → 全部 abort', () => {
    const state = createFakeState();
    const w1 = makeWaiter({ token: 'a' });
    const w2 = makeWaiter({ token: 'b' });
    state.waiters.push(w1, w2);
    drainOnDestroy(state, buildAbortError);
    expect(w1.abort).toHaveBeenCalledTimes(1);
    expect(w2.abort).toHaveBeenCalledTimes(1);
    expect(state.waiters).toHaveLength(0);
  });

  test('holding 状态 → 广播 release', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me' });
    drainOnDestroy(state, buildAbortError);
    const sent = (state.channel as FakeChannel).sent;
    expect(sent[sent.length - 1]).toMatchObject({ kind: 'release', token: 'me' });
    expect(state.status.kind).toBe('idle');
  });

  test('holding + postMessage 抛错 → logger.error 捕获', () => {
    const state = createFakeState();
    state.status = makeHolding({ token: 'me' });
    state.channel.postMessage = () => {
      throw new Error('postMessage-boom');
    };
    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('release broadcast failed during destroy'),
      expect.any(Error),
    );
  });

  test('remote-held 状态 → 停 dead timer + 切 idle', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    state.status = makeRemoteHeld({ token: 'remote' });
    drainOnDestroy(state, buildAbortError);
    expect(state.status.kind).toBe('idle');
  });

  test('unsubscribe 抛错 → logger.error 捕获', () => {
    const state = createFakeState();
    state.unsubscribe = () => {
      throw new Error('unsub-boom');
    };
    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unsubscribe threw'),
      expect.any(Error),
    );
  });

  test('channel.close 抛错 → logger.error 捕获', () => {
    const state = createFakeState();
    state.channel.close = () => {
      throw new Error('close-boom');
    };
    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
    expect(state.deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('channel.close threw'),
      expect.any(Error),
    );
  });

  test('unsubscribe=null → 跳过', () => {
    const state = createFakeState();
    state.unsubscribe = null;
    expect(() => drainOnDestroy(state, buildAbortError)).not.toThrow();
  });
});

describe('drivers/broadcast-state — startHeartbeat 定时器回调（通过 enterHolding 间接触发）', () => {
  test('正常分支：定时器到期 → 广播 heartbeat（released=false, destroyed=false）', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    enterHolding(state, 'me');
    // enterHolding 立即广播 1 次（kind=heartbeat）
    const sentBefore = (state.channel as FakeChannel).sent.length;

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    const sent = (state.channel as FakeChannel).sent;
    expect(sent.length).toBe(sentBefore + 1);
    expect(sent[sent.length - 1]).toMatchObject({ kind: 'heartbeat', token: 'me', senderId: 'sender-self' });
  });

  test('released=true 分支：定时器到期 → stopHeartbeat 早退', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    enterHolding(state, 'me');
    // 强制把 holding 标记为 released（模拟 release 已触发但 timer 仍未清的极端时序）
    (state.status as HoldingState).released = true;
    const sentBefore = (state.channel as FakeChannel).sent.length;

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    // 不再广播 heartbeat
    expect((state.channel as FakeChannel).sent.length).toBe(sentBefore);
    expect((state.status as HoldingState).heartbeatTimer).toBeNull();
  });

  test('destroyed=true 分支：定时器到期 → stopHeartbeat 早退', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    enterHolding(state, 'me');
    state.destroyed = true;
    const sentBefore = (state.channel as FakeChannel).sent.length;

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect((state.channel as FakeChannel).sent.length).toBe(sentBefore);
    expect((state.status as HoldingState).heartbeatTimer).toBeNull();
  });
});

describe('drivers/broadcast-state — resetDeadTimer 定时器回调（通过 enterRemoteHeld 间接触发）', () => {
  test('定时器到期 → 调 handleRemoteDead → status 回 idle', () => {
    vi.useFakeTimers();
    const state = createFakeState();
    enterRemoteHeld(state, 'remote', 100);

    vi.advanceTimersByTime(DEAD_THRESHOLD_MS);

    expect(state.status.kind).toBe('idle');
    expect(state.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('dead by heartbeat timeout'));
  });
});

describe('drivers/broadcast-state — handleMessage switch default（通过 mock isBroadcastMessage 让伪 kind 进入）', () => {
  test('未知 kind 通过 mock 守卫后 → switch default 早退', () => {
    const spy = vi.spyOn(broadcastProtocol, 'isBroadcastMessage').mockReturnValue(true);
    try {
      const state = createFakeState();
      const fakeMsg = { kind: 'unknown-kind', senderId: 'peer' } as unknown;
      expect(() => handleMessage(state, fakeMsg)).not.toThrow();
      // 未触发任何 handler，状态保持 idle
      expect(state.status.kind).toBe('idle');
      expect((state.channel as FakeChannel).sent).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('drivers/broadcast-state — pumpNextWaiter waiters.shift() 返回 falsy 边界', () => {
  test('waiters[0] === undefined → shift 后 next falsy → 早退', () => {
    const state = createFakeState();
    // 运行时构造一个非法的 waiters 数组：包含 undefined（绕过类型层）
    (state.waiters as unknown as Array<Waiter | undefined>).push(undefined);
    pumpNextWaiter(state);
    expect(state.pendingAnnounce).toBeNull();
    expect(state.status.kind).toBe('idle');
  });
});
