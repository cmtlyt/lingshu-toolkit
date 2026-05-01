/**
 * BroadcastDriver 状态层：状态机定义、消息处理、竞选流程、drain
 *
 * 本文件不对外暴露 API；`broadcast.ts` 作为工厂聚合层消费此处导出的内部符号。
 *
 * ## 本地状态机
 *   - `idle`：无人持锁；可直接 announce
 *   - `holding`：本 Tab 持锁；周期广播 heartbeat
 *   - `remote-held`：远端持锁；监测心跳过期（DEAD_THRESHOLD 未收到 heartbeat → 回 idle）
 *
 * ## 竞选协议（非 force）
 *   1. 广播 `announce`，启动 `REJECT_WINDOW` 窗口
 *   2. 期间规则：
 *      - 收到 `reject(requestId 匹配)` → abandonPendingAnnounce，waiter 回队等待
 *      - 收到他方 `announce` → 按 (ts, requestId) 字典序仲裁；对方更早则本方 abandon
 *      - 收到 `heartbeat` → 存在持有者，本方 abandon 并切 remote-held
 *   3. 窗口到期无拒绝 → enterHolding
 *
 * ## force 协议（BC-1 修复：异步等待对端 revoke 完成）
 *   1. 广播 `force`，启动 `FORCE_ARBITRATION_WINDOW` 窗口
 *   2. 期间收到他方 `force` → 按 (ts, token) 字典序仲裁；对方更早则本方 abandon
 *   3. 窗口到期后 enterHolding；对端持有者收到 force 时立即 revoke('force')
 *
 * ## 持锁期间冲突检测（BC-2 修复）
 *   - `holding` 状态收到 `reject(holderToken != 自己)` → 双持冲突，revoke 自己
 *   - `holding` 状态收到 `heartbeat(token != 自己)` → 双持冲突，revoke 自己
 */
/** biome-ignore-all lint/nursery/noExcessiveLinesPerFile: ignore */

import { isFunction } from '@/shared/utils/verify';
import type { ChannelAdapter, LockDriverHandle } from '../types';
import {
  type AnnounceMessage,
  DEAD_THRESHOLD,
  FORCE_ARBITRATION_WINDOW,
  type ForceMessage,
  genId,
  HEARTBEAT_INTERVAL,
  type HeartbeatMessage,
  isBroadcastMessage,
  isEarlier,
  REJECT_WINDOW,
  type RejectMessage,
  type ReleaseMessage,
} from './broadcast-protocol';
import type { LockDriverDeps } from './types';

// -----------------------------------------------------------------------------
// 状态机类型
// -----------------------------------------------------------------------------

interface HoldingState {
  readonly kind: 'holding';
  readonly token: string;
  readonly grantedAt: number;
  released: boolean;
  revokeCallback: ((reason: 'force' | 'timeout') => void) | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

interface RemoteHeldState {
  readonly kind: 'remote-held';
  token: string;
  peerTs: number;
  lastHeartbeat: number;
  deadTimer: ReturnType<typeof setTimeout> | null;
}

interface IdleState {
  readonly kind: 'idle';
}

type DriverState = IdleState | HoldingState | RemoteHeldState;

interface Waiter {
  readonly token: string;
  readonly resolve: (handle: LockDriverHandle) => void;
  readonly reject: (error: Error) => void;
  readonly abort: (error: Error) => void;
}

interface PendingAnnounce {
  readonly requestId: string;
  readonly ts: number;
  readonly waiter: Waiter;
  abandoned: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface PendingForce {
  readonly token: string;
  readonly ts: number;
  readonly waiter: Waiter;
  abandoned: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface BroadcastDriverState {
  readonly deps: LockDriverDeps;
  readonly channel: ChannelAdapter;
  readonly senderId: string;
  status: DriverState;
  readonly waiters: Waiter[];
  pendingAnnounce: PendingAnnounce | null;
  pendingForce: PendingForce | null;
  destroyed: boolean;
  unsubscribe: (() => void) | null;
}

// -----------------------------------------------------------------------------
// timer 生命周期
// -----------------------------------------------------------------------------

function stopHeartbeat(holding: HoldingState): void {
  if (holding.heartbeatTimer !== null) {
    clearInterval(holding.heartbeatTimer);
    holding.heartbeatTimer = null;
  }
}

function stopDeadTimer(remoteHeld: RemoteHeldState): void {
  if (remoteHeld.deadTimer !== null) {
    clearTimeout(remoteHeld.deadTimer);
    remoteHeld.deadTimer = null;
  }
}

function startHeartbeat(state: BroadcastDriverState, holding: HoldingState): void {
  holding.heartbeatTimer = setInterval(() => {
    if (holding.released || state.destroyed) {
      stopHeartbeat(holding);
      return;
    }
    state.channel.postMessage({
      kind: 'heartbeat',
      senderId: state.senderId,
      token: holding.token,
      ts: Date.now(),
    } satisfies HeartbeatMessage);
  }, HEARTBEAT_INTERVAL);
}

function resetDeadTimer(state: BroadcastDriverState, remoteHeld: RemoteHeldState): void {
  stopDeadTimer(remoteHeld);
  remoteHeld.deadTimer = setTimeout(() => {
    handleRemoteDead(state, remoteHeld.token);
  }, DEAD_THRESHOLD);
}

function handleRemoteDead(state: BroadcastDriverState, deadToken: string): void {
  const { name, logger } = state.deps;
  if (state.status.kind !== 'remote-held' || state.status.token !== deadToken) {
    return;
  }
  stopDeadTimer(state.status);
  logger.warn(`[${name}] broadcast driver: remote holder token=${deadToken} dead by heartbeat timeout`);
  state.status = { kind: 'idle' };
  pumpNextWaiter(state);
}

// -----------------------------------------------------------------------------
// 状态切换：进入 holding / remote-held / revoke
// -----------------------------------------------------------------------------

function revokeHolding(state: BroadcastDriverState, reason: 'force' | 'timeout'): void {
  if (state.status.kind !== 'holding') {
    return;
  }
  const holding = state.status;
  if (holding.released) {
    return;
  }
  holding.released = true;
  stopHeartbeat(holding);
  state.status = { kind: 'idle' };

  const { name, logger } = state.deps;
  logger.debug(`[${name}] broadcast driver: revoked token=${holding.token} reason=${reason}`);

  const cb = holding.revokeCallback;
  if (isFunction(cb)) {
    try {
      cb(reason);
    } catch (error) {
      logger.error(`[${name}] broadcast driver: revoke callback threw`, error);
    }
  }

  pumpNextWaiter(state);
}

function enterHolding(state: BroadcastDriverState, token: string): LockDriverHandle {
  const holding: HoldingState = {
    kind: 'holding',
    token,
    grantedAt: Date.now(),
    released: false,
    revokeCallback: null,
    heartbeatTimer: null,
  };
  state.status = holding;
  startHeartbeat(state, holding);
  // 立即广播一次 heartbeat，加快其他 Tab 切入 remote-held
  state.channel.postMessage({
    kind: 'heartbeat',
    senderId: state.senderId,
    token,
    ts: holding.grantedAt,
  } satisfies HeartbeatMessage);
  return buildHandle(state, token);
}

function enterRemoteHeld(state: BroadcastDriverState, token: string, peerTs: number): void {
  if (state.status.kind === 'remote-held') {
    stopDeadTimer(state.status);
  }
  const remoteHeld: RemoteHeldState = {
    kind: 'remote-held',
    token,
    peerTs,
    lastHeartbeat: Date.now(),
    deadTimer: null,
  };
  state.status = remoteHeld;
  resetDeadTimer(state, remoteHeld);
}

// -----------------------------------------------------------------------------
// pendingAnnounce / pendingForce 生命周期
// -----------------------------------------------------------------------------

function abandonPendingAnnounce(state: BroadcastDriverState, reason: string): void {
  const pending = state.pendingAnnounce;
  if (pending === null || pending.abandoned) {
    return;
  }
  pending.abandoned = true;
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  state.pendingAnnounce = null;
  const { name, logger } = state.deps;
  logger.debug(`[${name}] broadcast driver: abandon pendingAnnounce reason=${reason} token=${pending.waiter.token}`);
  // 放回队尾保持 FIFO 公平（BC-4 / BC-7 修复）
  state.waiters.push(pending.waiter);
}

function abandonPendingForce(state: BroadcastDriverState, reason: string): void {
  const pending = state.pendingForce;
  if (pending === null || pending.abandoned) {
    return;
  }
  pending.abandoned = true;
  if (pending.timer !== null) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  state.pendingForce = null;
  const { name, logger } = state.deps;
  logger.debug(`[${name}] broadcast driver: abandon pendingForce reason=${reason} token=${pending.token}`);
  // force 丢仲裁 → 降级为普通等待，回队尾
  state.waiters.push(pending.waiter);
}

// -----------------------------------------------------------------------------
// 消息处理
// -----------------------------------------------------------------------------

/**
 * 收到他方 announce：
 *   - 本方 holding（token 不同）→ 广播 reject；对方 handleReject 触发 abandonPendingAnnounce
 *   - 本方有 pendingAnnounce → 按 (ts, requestId) 字典序仲裁：
 *     - 我方更早 → 保持；对方在其本地也会执行相同仲裁并 abandon 自己
 *     - 对方更早 → 本方 abandon，回队等待
 *   - 本方 idle / remote-held（且无 pending）→ 不响应，让对方 announce 自然走完窗口
 */
function handleAnnounce(state: BroadcastDriverState, msg: AnnounceMessage): void {
  if (msg.senderId === state.senderId) {
    return;
  }

  if (state.status.kind === 'holding' && !state.status.released) {
    const holding = state.status;
    state.channel.postMessage({
      kind: 'reject',
      senderId: state.senderId,
      requestId: msg.requestId,
      holderToken: holding.token,
      holderTs: holding.grantedAt,
    } satisfies RejectMessage);
    return;
  }

  // 并发 announce 仲裁（BC-3）
  const pending = state.pendingAnnounce;
  if (pending !== null && !pending.abandoned) {
    if (isEarlier(pending.ts, pending.requestId, msg.ts, msg.requestId)) {
      return;
    }
    abandonPendingAnnounce(state, 'arbitration-loss');
  }
}

function handleReject(state: BroadcastDriverState, msg: RejectMessage): void {
  if (msg.senderId === state.senderId) {
    return;
  }

  // BC-2：holding 下收到他人 reject（holderToken != 自己）→ 双持冲突，revoke 自己
  if (state.status.kind === 'holding' && !state.status.released && state.status.token !== msg.holderToken) {
    const { name, logger } = state.deps;
    logger.warn(
      `[${name}] broadcast driver: double-hold detected (own=${state.status.token}, remote=${msg.holderToken}); revoking self`,
    );
    revokeHolding(state, 'force');
    enterRemoteHeld(state, msg.holderToken, msg.holderTs);
    return;
  }

  // pendingAnnounce 被明确拒绝
  const pending = state.pendingAnnounce;
  if (pending !== null && !pending.abandoned && pending.requestId === msg.requestId) {
    abandonPendingAnnounce(state, 'rejected');
  }

  // 切 / 更新 remote-held
  if (state.status.kind === 'idle' || state.status.kind === 'remote-held') {
    enterRemoteHeld(state, msg.holderToken, msg.holderTs);
  }
}

function handleHeartbeat(state: BroadcastDriverState, msg: HeartbeatMessage): void {
  if (msg.senderId === state.senderId) {
    return;
  }
  if (state.status.kind === 'holding' && state.status.token === msg.token) {
    return;
  }

  // BC-2 扩展：holding 下收到他人 heartbeat（token 不同）→ 双持冲突，revoke 自己
  if (state.status.kind === 'holding' && !state.status.released) {
    const { name, logger } = state.deps;
    logger.warn(
      `[${name}] broadcast driver: double-hold detected via heartbeat (own=${state.status.token}, remote=${msg.token}); revoking self`,
    );
    revokeHolding(state, 'force');
    enterRemoteHeld(state, msg.token, msg.ts);
    return;
  }

  // 收到 heartbeat 时若本方有 pendingAnnounce，放弃（有持有者）
  if (state.pendingAnnounce !== null && !state.pendingAnnounce.abandoned) {
    abandonPendingAnnounce(state, 'heartbeat-detected');
  }
  enterRemoteHeld(state, msg.token, msg.ts);
}

function handleRelease(state: BroadcastDriverState, msg: ReleaseMessage): void {
  if (msg.senderId === state.senderId) {
    return;
  }
  if (state.status.kind === 'remote-held' && state.status.token === msg.token) {
    stopDeadTimer(state.status);
    state.status = { kind: 'idle' };
    pumpNextWaiter(state);
  }
}

/**
 * 收到他方 force：
 *   - 本方 pendingForce → 按 (ts, token) 字典序仲裁；败方 abandon
 *   - 本方 holding（token 不同）→ 立即 revoke('force')
 *   - 切 / 刷新 remote-held
 */
function handleForce(state: BroadcastDriverState, msg: ForceMessage): void {
  if (msg.senderId === state.senderId) {
    return;
  }

  const pending = state.pendingForce;
  if (pending !== null && !pending.abandoned) {
    if (isEarlier(pending.ts, pending.token, msg.ts, msg.token)) {
      // 我方更早：保持竞选；注意本方 startForceCampaign 已提前 revoke 过自己的 holding，
      // 此时本方处于"等待窗口到期 enterHolding"状态，不需要再处理 holding
      return;
    }
    abandonPendingForce(state, 'arbitration-loss');
  }

  if (state.status.kind === 'holding' && !state.status.released && state.status.token !== msg.token) {
    revokeHolding(state, 'force');
  }
  enterRemoteHeld(state, msg.token, msg.ts);
}

function handleMessage(state: BroadcastDriverState, raw: unknown): void {
  if (!isBroadcastMessage(raw)) {
    return;
  }
  switch (raw.kind) {
    case 'announce':
      handleAnnounce(state, raw);
      return;
    case 'reject':
      handleReject(state, raw);
      return;
    case 'heartbeat':
      handleHeartbeat(state, raw);
      return;
    case 'release':
      handleRelease(state, raw);
      return;
    case 'force':
      handleForce(state, raw);
      return;
    default:
      // biome useDefaultSwitchClause：穷尽后兜底；isBroadcastMessage 已保证不可达
      return;
  }
}

// -----------------------------------------------------------------------------
// 队列推进 + handle 构造
// -----------------------------------------------------------------------------

function removeWaiter(waiters: Waiter[], target: Waiter): void {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i] === target) {
      waiters.splice(i, 1);
      return;
    }
  }
}

function pumpNextWaiter(state: BroadcastDriverState): void {
  if (state.destroyed || state.status.kind !== 'idle' || state.waiters.length === 0) {
    return;
  }
  if (state.pendingAnnounce !== null || state.pendingForce !== null) {
    return;
  }
  const next = state.waiters.shift();
  if (!next) {
    return;
  }
  startAnnounceCampaign(state, next);
}

function buildHandle(state: BroadcastDriverState, token: string): LockDriverHandle {
  const { name, logger } = state.deps;

  return {
    release: () => {
      if (state.status.kind !== 'holding' || state.status.token !== token || state.status.released) {
        return;
      }
      const holding = state.status;
      holding.released = true;
      stopHeartbeat(holding);
      state.status = { kind: 'idle' };
      logger.debug(`[${name}] broadcast driver: release token=${token}`);
      state.channel.postMessage({
        kind: 'release',
        senderId: state.senderId,
        token,
      } satisfies ReleaseMessage);
      pumpNextWaiter(state);
    },
    /**
     * 契约：若注册时本方已不是该 token 的持有者（已 revoke / release / 非当前 holding），
     * 回调不会被触发；driver 不补发历史事件
     */
    onRevokedByDriver: (callback) => {
      if (state.status.kind === 'holding' && state.status.token === token && !state.status.released) {
        state.status.revokeCallback = callback;
      }
    },
  };
}

// -----------------------------------------------------------------------------
// 竞选流程：announce / force
// -----------------------------------------------------------------------------

/**
 * 启动 announce 竞选
 *
 * 前置条件（由调用方 pumpNextWaiter / acquireBroadcastLock 保证）：
 *   - state.destroyed === false
 *   - state.status.kind === 'idle'
 *   - state.pendingAnnounce === null && state.pendingForce === null
 *
 * 若违反前置条件视为 driver 内部 bug，logger.error 记录后把 waiter 回队兜底
 * （而非静默死等 —— BC-K 修复）
 */
function startAnnounceCampaign(state: BroadcastDriverState, waiter: Waiter): void {
  const { name, logger } = state.deps;

  if (state.destroyed) {
    logger.error(`[${name}] broadcast driver: startAnnounceCampaign called after destroyed`);
    // destroy 路径会统一 abort；此处直接返回避免竞态
    return;
  }
  if (state.status.kind !== 'idle' || state.pendingAnnounce !== null || state.pendingForce !== null) {
    logger.error(
      `[${name}] broadcast driver: startAnnounceCampaign precondition violated (status=${state.status.kind}, pendingAnnounce=${state.pendingAnnounce !== null}, pendingForce=${state.pendingForce !== null})`,
    );
    // 把 waiter 回队，下一次状态回 idle 时 pumpNextWaiter 会重新触发
    state.waiters.push(waiter);
    return;
  }

  const requestId = genId('req');
  const ts = Date.now();

  const pending: PendingAnnounce = {
    requestId,
    ts,
    waiter,
    abandoned: false,
    timer: null,
  };
  state.pendingAnnounce = pending;

  state.channel.postMessage({
    kind: 'announce',
    senderId: state.senderId,
    requestId,
    token: waiter.token,
    ts,
    force: false,
  } satisfies AnnounceMessage);
  logger.debug(`[${name}] broadcast driver: announce token=${waiter.token} reqId=${requestId}`);

  pending.timer = setTimeout(() => {
    pending.timer = null;
    if (pending.abandoned || state.destroyed) {
      return;
    }
    state.pendingAnnounce = null;
    const handle = enterHolding(state, waiter.token);
    logger.debug(`[${name}] broadcast driver: grant token=${waiter.token}`);
    waiter.resolve(handle);
  }, REJECT_WINDOW);
}

function startForceCampaign(state: BroadcastDriverState, waiter: Waiter): void {
  const { name, logger } = state.deps;

  if (state.destroyed) {
    logger.error(`[${name}] broadcast driver: startForceCampaign called after destroyed`);
    return;
  }

  // 若本方恰好是 holder（同实例极端并发），先 revoke 自己再抢
  if (state.status.kind === 'holding' && !state.status.released) {
    revokeHolding(state, 'force');
  }

  const ts = Date.now();
  const pending: PendingForce = {
    token: waiter.token,
    ts,
    waiter,
    abandoned: false,
    timer: null,
  };
  state.pendingForce = pending;

  state.channel.postMessage({
    kind: 'force',
    senderId: state.senderId,
    token: waiter.token,
    ts,
  } satisfies ForceMessage);
  logger.debug(`[${name}] broadcast driver: force-announce token=${waiter.token} ts=${ts}`);

  pending.timer = setTimeout(() => {
    pending.timer = null;
    if (pending.abandoned || state.destroyed) {
      return;
    }
    state.pendingForce = null;
    const handle = enterHolding(state, waiter.token);
    logger.debug(`[${name}] broadcast driver: grant (force) token=${waiter.token}`);
    waiter.resolve(handle);
  }, FORCE_ARBITRATION_WINDOW);
}

// -----------------------------------------------------------------------------
// drainOnDestroy（BC-J 修复：pending.waiter 也要 abort，避免泄漏）
// -----------------------------------------------------------------------------

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ignore
function drainOnDestroy(state: BroadcastDriverState, buildAbortError: (token: string) => Error): void {
  const { deps, waiters } = state;
  const { name, logger } = deps;
  logger.debug(
    `[${name}] broadcast driver: destroy (waiters=${waiters.length}, status=${state.status.kind}, pendingAnnounce=${state.pendingAnnounce !== null}, pendingForce=${state.pendingForce !== null})`,
  );

  // 收集所有需要 abort 的 waiter —— pending 里的 waiter 也要（BC-J）
  const toAbort: Waiter[] = [];

  if (state.pendingAnnounce !== null) {
    const { pendingAnnounce } = state;
    pendingAnnounce.abandoned = true;
    if (pendingAnnounce.timer !== null) {
      clearTimeout(pendingAnnounce.timer);
    }
    state.pendingAnnounce = null;
    toAbort.push(pendingAnnounce.waiter);
  }

  if (state.pendingForce !== null) {
    const { pendingForce } = state;
    pendingForce.abandoned = true;
    if (pendingForce.timer !== null) {
      clearTimeout(pendingForce.timer);
    }
    state.pendingForce = null;
    toAbort.push(pendingForce.waiter);
  }

  // 队列中的普通 waiter
  for (let i = 0; i < waiters.length; i++) {
    toAbort.push(waiters[i]);
  }
  waiters.length = 0;

  // 当前持有者：停心跳 + 广播 release
  if (state.status.kind === 'holding') {
    const holding = state.status;
    stopHeartbeat(holding);
    holding.released = true;
    try {
      state.channel.postMessage({
        kind: 'release',
        senderId: state.senderId,
        token: holding.token,
      } satisfies ReleaseMessage);
    } catch (error) {
      logger.error(`[${name}] broadcast driver: release broadcast failed during destroy`, error);
    }
  } else if (state.status.kind === 'remote-held') {
    stopDeadTimer(state.status);
  }
  state.status = { kind: 'idle' };

  for (let i = 0; i < toAbort.length; i++) {
    toAbort[i].abort(buildAbortError(toAbort[i].token));
  }

  if (state.unsubscribe !== null) {
    try {
      state.unsubscribe();
    } catch (error) {
      logger.error(`[${name}] broadcast driver: unsubscribe threw`, error);
    }
    state.unsubscribe = null;
  }
  try {
    state.channel.close();
  } catch (error) {
    logger.error(`[${name}] broadcast driver: channel.close threw`, error);
  }
}

export type { BroadcastDriverState, Waiter };
export { drainOnDestroy, handleMessage, pumpNextWaiter, removeWaiter, startAnnounceCampaign, startForceCampaign };
