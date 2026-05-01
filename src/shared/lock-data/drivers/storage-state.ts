/**
 * StorageDriver 状态层：状态机 + CAS 读写 + 队列操作 + 心跳 + drain
 *
 * ## CAS 模式（ST-1 修复）
 * 读取 → 判定（idle / dead-holder / queue-head-ready）→ 生成新 holder（带 nonce）→
 * 写入 → 再读回 verify（token + nonce 必须都匹配）。verify 失败 → 随机退避 → 重试；
 * 超过 WRITE_RETRY_MAX 次 → 放弃本次尝试，等 storage 事件 / polling 触发下一轮
 *
 * ## 状态机
 *   - `idle`：无人持锁（本 Tab 视角）
 *   - `holding`：本 Tab 持锁；周期心跳 + 读 verify（发现被覆盖 → revoke('force')）
 *
 * 注意：storage driver **不维护 remote-held 状态**，因为 storage 是"随时可读的权威"；
 * 需要知道远端持有者状态时直接 readStorage()，比内存状态机更可靠
 *
 * ## 队列（ST-5 修复）
 * 本地队列 `state.waiters`（driver 内存）+ storage 队列 `value.queue`（跨 Tab 持久化）
 * 两者通过 waiter.token 关联；入队 / 出队均走 CAS 重试（最多 WRITE_RETRY_MAX 次）
 */

import { isFunction } from '@/shared/utils/verify';
import type { LockDriverHandle } from '../types';
import {
  EMPTY_VALUE,
  genNonce,
  HEARTBEAT_INTERVAL,
  isHolderDead,
  isStorageLockValue,
  nextRetryJitter,
  POLL_INTERVAL,
  type StorageLockValue,
  WRITE_RETRY_MAX,
} from './storage-protocol';
import type { LockDriverDeps } from './types';

// -----------------------------------------------------------------------------
// 状态机类型
// -----------------------------------------------------------------------------

interface HoldingState {
  readonly kind: 'holding';
  readonly token: string;
  /** 本 Tab 写入 holder 时生成的 nonce；CAS verify 依据 */
  readonly nonce: string;
  released: boolean;
  revokeCallback: ((reason: 'force' | 'timeout') => void) | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

interface IdleState {
  readonly kind: 'idle';
}

type DriverLocalState = IdleState | HoldingState;

interface Waiter {
  readonly token: string;
  readonly resolve: (handle: LockDriverHandle) => void;
  readonly reject: (error: Error) => void;
  readonly abort: (error: Error) => void;
  /**
   * 查询 waiter 是否已 settled（resolve / reject / abort 任一）
   *
   * pump / force 路径需要在拿到 grant 后 resolve 前检查：若已 settled 说明 waiter
   * 已被 abort / timeout / signal 终结，此时抢到的 storage 锁应立即释放，避免泄漏（S-4 修复）
   */
  readonly isSettled: () => boolean;
}

interface StorageDriverState {
  readonly deps: LockDriverDeps;
  readonly storage: Storage;
  readonly key: string;
  status: DriverLocalState;
  readonly waiters: Waiter[];
  destroyed: boolean;
  /** 并发保护：pumpNextWaiter 进行中；避免 storage 事件 + polling 同时触发多路 tryAcquire */
  pumping: boolean;
  unsubscribeStorageEvent: (() => void) | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}

// -----------------------------------------------------------------------------
// 基础读写
// -----------------------------------------------------------------------------

function readStorage(state: StorageDriverState): StorageLockValue {
  const { storage, key, deps } = state;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    deps.logger.warn(`[${deps.name}] storage driver: getItem failed at key=${key}`, error);
    return EMPTY_VALUE;
  }
  if (raw === null || raw === '') {
    return EMPTY_VALUE;
  }
  try {
    const parsed = JSON.parse(raw);
    if (isStorageLockValue(parsed)) {
      return parsed;
    }
    deps.logger.warn(`[${deps.name}] storage driver: malformed value at key=${key}; treating as empty`);
    return EMPTY_VALUE;
  } catch (error) {
    deps.logger.warn(`[${deps.name}] storage driver: JSON.parse failed at key=${key}`, error);
    return EMPTY_VALUE;
  }
}

/**
 * 写入 storage
 *
 * 返回值语义：
 *   - `'success'`：写入成功
 *   - `'abort'`：`setItem` 抛错（QuotaExceededError / SecurityError）；重试也是徒劳，
 *     调用方应直接放弃本次尝试（SS-8 修复），走心跳超时 / force 兜底自愈路径
 */
type WriteResult = 'success' | 'abort';

function writeStorage(state: StorageDriverState, value: StorageLockValue): WriteResult {
  const { storage, key, deps } = state;
  try {
    storage.setItem(key, JSON.stringify(value));
    return 'success';
  } catch (error) {
    deps.logger.warn(`[${deps.name}] storage driver: setItem failed`, error);
    return 'abort';
  }
}

/**
 * 退避重试的包装
 *
 * attempt 函数返回：
 *   - `'success'`：成功，立即返回
 *   - `'retry'`：失败需重试
 *   - `'abort'`：失败但不应重试（如 destroyed / setItem 抛错）
 *
 * 重试前随机退避 0~WRITE_RETRY_JITTER_MAX ms；若超过 WRITE_RETRY_MAX 次仍失败返回 false
 */
type AttemptResult = 'success' | 'retry' | 'abort';

function withCasRetry(attempt: () => AttemptResult): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let tries = 0;
    const run = (): void => {
      const result = attempt();
      if (result === 'success') {
        resolve(true);
        return;
      }
      if (result === 'abort') {
        resolve(false);
        return;
      }
      tries++;
      if (tries >= WRITE_RETRY_MAX) {
        resolve(false);
        return;
      }
      setTimeout(run, nextRetryJitter());
    };
    run();
  });
}

// -----------------------------------------------------------------------------
// 队列 CAS 操作（ST-5 修复）
// -----------------------------------------------------------------------------

function enqueueInStorageOnce(state: StorageDriverState, token: string): AttemptResult {
  if (state.destroyed) {
    return 'abort';
  }
  const current = readStorage(state);
  // 幂等：已在队列 → 直接成功
  for (let i = 0; i < current.queue.length; i++) {
    if (current.queue[i].token === token) {
      return 'success';
    }
  }
  const next: StorageLockValue = {
    holder: current.holder,
    queue: [...current.queue, { token, ts: Date.now() }],
    rev: current.rev + 1,
  };
  const writeResult = writeStorage(state, next);
  if (writeResult === 'abort') {
    return 'abort';
  }
  // verify：读回看自己是否仍在队列
  const verify = readStorage(state);
  for (let i = 0; i < verify.queue.length; i++) {
    if (verify.queue[i].token === token) {
      return 'success';
    }
  }
  return 'retry';
}

function enqueueInStorage(state: StorageDriverState, token: string): Promise<boolean> {
  return withCasRetry(() => enqueueInStorageOnce(state, token));
}

// -----------------------------------------------------------------------------
// 抢锁 CAS：尝试把自己写成 holder（ST-1 修复：writerNonce 双重校验）
// -----------------------------------------------------------------------------

interface AcquireGrant {
  readonly token: string;
  readonly nonce: string;
}

/**
 * 单次抢锁尝试
 *
 * 判定是否可以抢：
 *   - holder === null → 可抢
 *   - holder 已崩溃（heartbeat 超阈值）→ 可抢
 *   - 否则 → 不可抢
 *
 * 抢到后还需等"本 waiter 在队首 OR 抢锁是 force"，保持 FIFO
 *
 * 成功路径：写入 holder（含新 nonce）→ 读回 verify（token + nonce 双重匹配）
 */
function tryAcquireOnce(
  state: StorageDriverState,
  token: string,
  force: boolean,
): AcquireGrant | 'retry' | 'cannot-acquire' | 'abort' {
  if (state.destroyed) {
    return 'abort';
  }
  const current = readStorage(state);
  const { holder, queue } = current;

  if (holder !== null && !isHolderDead(holder)) {
    if (!force) {
      return 'cannot-acquire';
    }
    // force：覆盖 holder（即使仍活着）
  }

  // 非 force 场景：如果队列非空，必须本 token 在队首才可抢（FIFO）
  if (!force && queue.length > 0 && queue[0].token !== token) {
    return 'cannot-acquire';
  }

  const newNonce = genNonce();
  const now = Date.now();
  // 写入 holder；若 force 则清空队列自己（保持 FIFO 契约）；非 force 则从队列移除自己
  const filteredQueue = queue.filter((entry) => entry.token !== token);
  const next: StorageLockValue = {
    holder: { token, heartbeat: now, nonce: newNonce },
    queue: filteredQueue,
    rev: current.rev + 1,
  };
  const writeResult = writeStorage(state, next);
  if (writeResult === 'abort') {
    return 'abort';
  }
  // verify
  const verify = readStorage(state);
  if (verify.holder === null || verify.holder.token !== token || verify.holder.nonce !== newNonce) {
    // 被其他 Tab 覆盖（token 或 nonce 不匹配）→ 重试
    return 'retry';
  }
  return { token, nonce: newNonce };
}

function tryAcquire(state: StorageDriverState, token: string, force: boolean): Promise<AcquireGrant | null> {
  return new Promise<AcquireGrant | null>((resolve) => {
    let tries = 0;
    const run = (): void => {
      const result = tryAcquireOnce(state, token, force);
      if (result === 'abort' || result === 'cannot-acquire') {
        resolve(null);
        return;
      }
      if (result !== 'retry') {
        resolve(result);
        return;
      }
      tries++;
      if (tries >= WRITE_RETRY_MAX) {
        resolve(null);
        return;
      }
      setTimeout(run, nextRetryJitter());
    };
    run();
  });
}

// -----------------------------------------------------------------------------
// 状态机 + 心跳
// -----------------------------------------------------------------------------

function stopHeartbeat(holding: HoldingState): void {
  if (holding.heartbeatTimer !== null) {
    clearInterval(holding.heartbeatTimer);
    holding.heartbeatTimer = null;
  }
}

function startHeartbeat(state: StorageDriverState, holding: HoldingState): void {
  holding.heartbeatTimer = setInterval(() => {
    if (holding.released || state.destroyed) {
      stopHeartbeat(holding);
      return;
    }
    const current = readStorage(state);
    // ST-1：若 holder 已被他方覆盖（token 或 nonce 不匹配）→ 触发 revoke('force')
    if (current.holder === null || current.holder.token !== holding.token || current.holder.nonce !== holding.nonce) {
      revokeHolding(state, 'force');
      return;
    }
    // 更新 heartbeat（保持 nonce 不变 —— 同一持有者的连续心跳）
    const nextValue: StorageLockValue = {
      holder: { token: holding.token, heartbeat: Date.now(), nonce: holding.nonce },
      queue: current.queue,
      rev: current.rev + 1,
    };
    writeStorage(state, nextValue);
  }, HEARTBEAT_INTERVAL);
}

function revokeHolding(state: StorageDriverState, reason: 'force' | 'timeout'): void {
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
  logger.debug(`[${name}] storage driver: revoked token=${holding.token} reason=${reason}`);

  const cb = holding.revokeCallback;
  if (isFunction(cb)) {
    try {
      cb(reason);
    } catch (error) {
      logger.error(`[${name}] storage driver: revoke callback threw`, error);
    }
  }

  pumpNextWaiter(state);
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

/**
 * 尝试推进队首 waiter
 *
 * SS-1 修复：加 `state.pumping` 并发保护 —— storage 事件 + polling 可能并发触发，
 * 必须保证同一时刻只有一个 `tryAcquire` 流程在跑
 */
function pumpNextWaiter(state: StorageDriverState): void {
  if (state.destroyed || state.pumping) {
    return;
  }
  if (state.status.kind !== 'idle' || state.waiters.length === 0) {
    return;
  }
  const [next] = state.waiters;
  state.pumping = true;
  void tryAcquire(state, next.token, false).then((grant) => {
    state.pumping = false;
    if (grant === null) {
      // 抢不到 —— 保持排队，等 storage 事件 / polling / heartbeat timeout 下次 pump
      return;
    }
    if (state.destroyed) {
      // 极端：抢到后立刻被 destroy；释放刚抢到的 holder，避免 storage 残留
      releaseHolderInStorage(state, next.token, grant.nonce);
      removeWaiter(state.waiters, next);
      return;
    }
    if (state.status.kind !== 'idle') {
      // 已有其他路径抢到锁（理论由 pumping 保护杜绝，但保留防御性兜底）
      releaseHolderInStorage(state, next.token, grant.nonce);
      return;
    }
    // 确认 waiter 仍在队列中（可能被 abort 了）
    const [head] = state.waiters;
    if (head !== next) {
      releaseHolderInStorage(state, next.token, grant.nonce);
      return;
    }
    // S-4：即便 waiter 仍在队首，也可能在本 tick 之前被 abort 但还没从队列移除
    // （settled 的 waiter 若残留在队列，会让锁抢到后无人消费 → 泄漏）
    if (next.isSettled()) {
      state.waiters.shift();
      releaseHolderInStorage(state, next.token, grant.nonce);
      return;
    }
    state.waiters.shift();
    const handle = enterHolding(state, next.token, grant.nonce);
    state.deps.logger.debug(`[${state.deps.name}] storage driver: grant token=${next.token}`);
    next.resolve(handle);
  });
}

/**
 * 在 storage 中释放 holder（幂等；仅当 token + nonce 匹配才真释放）
 */
function releaseHolderInStorage(state: StorageDriverState, token: string, nonce: string): void {
  const current = readStorage(state);
  if (current.holder === null || current.holder.token !== token || current.holder.nonce !== nonce) {
    return;
  }
  const next: StorageLockValue = {
    holder: null,
    queue: current.queue,
    rev: current.rev + 1,
  };
  writeStorage(state, next);
}

function enterHolding(state: StorageDriverState, token: string, nonce: string): LockDriverHandle {
  const holding: HoldingState = {
    kind: 'holding',
    token,
    nonce,
    released: false,
    revokeCallback: null,
    heartbeatTimer: null,
  };
  state.status = holding;
  startHeartbeat(state, holding);
  return buildHandle(state, token, nonce);
}

function buildHandle(state: StorageDriverState, token: string, nonce: string): LockDriverHandle {
  const { name, logger } = state.deps;
  return {
    release: () => {
      if (
        state.status.kind !== 'holding' ||
        state.status.token !== token ||
        state.status.nonce !== nonce ||
        state.status.released
      ) {
        return;
      }
      const holding = state.status;
      holding.released = true;
      stopHeartbeat(holding);
      state.status = { kind: 'idle' };
      logger.debug(`[${name}] storage driver: release token=${token}`);
      releaseHolderInStorage(state, token, nonce);
      pumpNextWaiter(state);
    },
    onRevokedByDriver: (callback) => {
      if (
        state.status.kind === 'holding' &&
        state.status.token === token &&
        state.status.nonce === nonce &&
        !state.status.released
      ) {
        state.status.revokeCallback = callback;
      }
    },
  };
}

// -----------------------------------------------------------------------------
// 外部变更感知：storage 事件 + polling
// -----------------------------------------------------------------------------

/**
 * 当 storage 发生外部变更（其他 Tab 写入 / polling 检测到 holder 崩溃）时触发
 *
 * 职责：
 *   1. 若本 Tab holding 且 holder 在 storage 中已被覆盖 → revoke('force')
 *   2. 若本 Tab idle 且有 waiter → 尝试 pump
 */
function handleExternalChange(state: StorageDriverState): void {
  if (state.destroyed) {
    return;
  }
  const current = readStorage(state);

  // 本 Tab holding：检查自己是否仍是 holder
  if (state.status.kind === 'holding' && !state.status.released) {
    if (
      current.holder === null ||
      current.holder.token !== state.status.token ||
      current.holder.nonce !== state.status.nonce
    ) {
      revokeHolding(state, 'force');
    }
    return;
  }

  // 本 Tab idle：若 storage 的 holder 已不存在（被释放）或已崩溃 → 尝试 pump
  if (state.status.kind === 'idle' && state.waiters.length > 0) {
    if (current.holder === null || isHolderDead(current.holder)) {
      pumpNextWaiter(state);
    }
  }
}

/**
 * 订阅 window 的 storage 事件（跨 Tab 通知）
 *
 * 注意：storage 事件不跨同 Tab 触发，同 Tab 多实例需 polling 兜底（见 startPolling）
 */
function subscribeStorageEvent(state: StorageDriverState): (() => void) | null {
  const target = globalThis as {
    addEventListener?: (type: 'storage', handler: (event: StorageEvent) => void) => void;
    removeEventListener?: (type: 'storage', handler: (event: StorageEvent) => void) => void;
  };
  if (!isFunction(target.addEventListener)) {
    state.deps.logger.warn(
      `[${state.deps.name}] storage driver: globalThis.addEventListener unavailable; cross-tab notification disabled`,
    );
    return null;
  }
  const handler = (event: StorageEvent): void => {
    if (event.storageArea !== state.storage) {
      return;
    }
    if (event.key !== state.key && event.key !== null) {
      // key === null：storage.clear()，也要触发重算
      return;
    }
    try {
      handleExternalChange(state);
    } catch (error) {
      state.deps.logger.error(`[${state.deps.name}] storage driver: handleExternalChange threw`, error);
    }
  };
  target.addEventListener('storage', handler);
  return () => {
    target.removeEventListener?.('storage', handler);
  };
}

function startPolling(state: StorageDriverState): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      handleExternalChange(state);
    } catch (error) {
      state.deps.logger.error(`[${state.deps.name}] storage driver: polling threw`, error);
    }
  }, POLL_INTERVAL);
}

// -----------------------------------------------------------------------------
// 判定辅助
// -----------------------------------------------------------------------------

/**
 * 判断当前是否应立即尝试抢锁（快路径，避开入队 → 等事件 → pump 的流程）
 *
 * 条件：本 Tab idle + 无其他本地 waiter + (storage 无 holder 或 holder 已崩溃) + 队列空
 */
function canFastAcquire(state: StorageDriverState): boolean {
  if (state.status.kind !== 'idle' || state.waiters.length > 0) {
    return false;
  }
  const current = readStorage(state);
  if (current.queue.length > 0) {
    return false;
  }
  return current.holder === null || isHolderDead(current.holder);
}

// -----------------------------------------------------------------------------
// drainOnDestroy（BC-J 同等：pending waiter 也要 abort）
// -----------------------------------------------------------------------------

function drainOnDestroy(state: StorageDriverState, buildAbortError: (token: string) => Error): void {
  const { deps, waiters } = state;
  const { name, logger } = deps;
  logger.debug(`[${name}] storage driver: destroy (waiters=${waiters.length}, status=${state.status.kind})`);

  // 停止 polling + 解除 storage 事件订阅
  if (state.pollTimer !== null) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.unsubscribeStorageEvent !== null) {
    try {
      state.unsubscribeStorageEvent();
    } catch (error) {
      logger.error(`[${name}] storage driver: unsubscribe storage event threw`, error);
    }
    state.unsubscribeStorageEvent = null;
  }

  // 当前持有者：停心跳 + 写 null 清空 storage 中的 holder
  if (state.status.kind === 'holding') {
    const holding = state.status;
    stopHeartbeat(holding);
    holding.released = true;
    releaseHolderInStorage(state, holding.token, holding.nonce);
  }
  state.status = { kind: 'idle' };

  // 清空 waiter（同时尝试从 storage 队列一次性批量移除；SS-2 修复：destroy 是同步语义，
  // 不跑异步重试，一次 CAS 尽力而为即可，失败交给远端 heartbeat 超时自愈）
  const pending = waiters.slice();
  waiters.length = 0;

  if (pending.length > 0) {
    try {
      const current = readStorage(state);
      const pendingTokens = new Set<string>();
      for (let i = 0; i < pending.length; i++) {
        pendingTokens.add(pending[i].token);
      }
      const filtered = current.queue.filter((entry) => !pendingTokens.has(entry.token));
      if (filtered.length !== current.queue.length) {
        writeStorage(state, {
          holder: current.holder,
          queue: filtered,
          rev: current.rev + 1,
        });
      }
    } catch (error) {
      logger.error(`[${name}] storage driver: batch dequeue failed during destroy`, error);
    }
  }

  for (let i = 0; i < pending.length; i++) {
    pending[i].abort(buildAbortError(pending[i].token));
  }
}

export type { AcquireGrant, StorageDriverState, Waiter };
export {
  canFastAcquire,
  drainOnDestroy,
  enqueueInStorage,
  enterHolding,
  handleExternalChange,
  pumpNextWaiter,
  releaseHolderInStorage,
  removeWaiter,
  revokeHolding,
  startPolling,
  subscribeStorageEvent,
  tryAcquire,
};
