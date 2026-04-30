/**
 * StorageDriver：基于 localStorage 的跨 Tab 互斥锁
 *
 * 适用场景（由 pickDriver 决定）：
 * - 浏览器环境但既不支持 `navigator.locks`，也不支持 `BroadcastChannel`
 * - 显式 `mode='storage'` 强制指定
 *
 * 本文件是工厂聚合层：
 * - 前置依赖校验（id 必传 / localStorage 可用）
 * - 构造 state 容器 + 订阅 storage 事件 + 启动 polling
 * - 暴露 acquire / destroy
 *
 * 协议细节、状态机、CAS 读写、队列操作、drain 逻辑分别放在：
 * - `./storage-protocol`：存储格式 + 常量 + 校验 + nonce 生成
 * - `./storage-state`：状态机 + CAS 读写 + 队列 + 心跳 + drain
 */

import { throwError } from '@/shared/throw-error';
import { isNumber, isString } from '@/shared/utils/verify';
import { ERROR_FN_NAME, LOCK_PREFIX } from '../constants';
import { LockAbortedError, LockTimeoutError } from '../errors';
import type { LockDriverContext, LockDriverHandle } from '../types';
import {
  canFastAcquire,
  drainOnDestroy,
  enqueueInStorage,
  enterHolding,
  pumpNextWaiter,
  releaseHolderInStorage,
  removeWaiter,
  revokeHolding,
  type StorageDriverState,
  startPolling,
  subscribeStorageEvent,
  tryAcquire,
  type Waiter,
} from './storage-state';
import type { LockDriver, LockDriverDeps } from './types';

/**
 * 能力探测：localStorage 是否可实际读写
 *
 * 与 adapters/authority 的探测同构；pickDriver 已做一次但保留防御性兜底，
 * 覆盖单元测试直接实例化的场景
 */
function hasUsableLocalStorage(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) {
      return false;
    }
    const probeKey = `${LOCK_PREFIX}:__storage_driver_probe__`;
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

function buildLockKey(id: string): string {
  return `${LOCK_PREFIX}:${id}:driver-lock`;
}

/**
 * 构造 waiter 并绑定 signal / timeout 的 abort 生命周期
 *
 * 与 broadcast driver 的 buildWaiter 同构；主要差异：
 * - 没有 pendingAnnounce / pendingForce 分支（storage driver 的抢锁是 CAS 直接决断，
 *   没有"进行中的竞选"需要清理）
 * - abort 时需要 removeWaiter + pumpNextWaiter，让下一个 waiter 继续抢
 */
function buildWaiter(
  ctx: LockDriverContext,
  state: StorageDriverState,
  resolve: (handle: LockDriverHandle) => void,
  reject: (error: Error) => void,
): Waiter {
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  function cleanup(): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    ctx.signal.removeEventListener('abort', onSignalAbort);
  }

  const waiter: Waiter = {
    token: ctx.token,
    resolve: (handle) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(handle);
    },
    reject: (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    },
    abort: (error) => {
      if (settled) {
        return;
      }
      removeWaiter(state.waiters, waiter);
      waiter.reject(error);
      // waiter 被 abort 后，队列可能已变；触发 pump 让下一个 waiter 继续抢
      pumpNextWaiter(state);
    },
    isSettled: () => settled,
  };

  function onSignalAbort(): void {
    waiter.abort(
      new LockAbortedError(`[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: acquire aborted (token=${ctx.token})`),
    );
  }

  if (ctx.signal.aborted) {
    queueMicrotask(() => onSignalAbort());
    return waiter;
  }
  ctx.signal.addEventListener('abort', onSignalAbort, { once: true });

  if (isNumber(ctx.acquireTimeout) && ctx.acquireTimeout > 0) {
    const timeoutMs = ctx.acquireTimeout;
    timeoutId = setTimeout(() => {
      waiter.abort(
        new LockTimeoutError(
          `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: acquire timed out after ${timeoutMs}ms (token=${ctx.token})`,
        ),
      );
    }, timeoutMs);
  }

  return waiter;
}

/**
 * force 路径的专用入队 + 抢锁流程
 *
 * force 不走 FIFO 队列 —— 直接 CAS 覆盖 holder；成功即进入 holding，失败交由 abort 处理
 */
function acquireForceLock(state: StorageDriverState, waiter: Waiter): void {
  const { name, logger } = state.deps;
  void tryAcquire(state, waiter.token, true).then((grant) => {
    if (grant === null) {
      waiter.abort(
        new LockAbortedError(
          `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: force acquire failed after retries (token=${waiter.token})`,
        ),
      );
      return;
    }
    if (state.destroyed) {
      releaseHolderInStorage(state, waiter.token, grant.nonce);
      waiter.abort(
        new LockAbortedError(
          `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: storage driver destroyed during force acquire (token=${waiter.token})`,
        ),
      );
      return;
    }
    // S-4：waiter 已在等待 tryAcquire 期间被 abort —— 抢到的锁必须立即释放，避免泄漏
    if (waiter.isSettled()) {
      releaseHolderInStorage(state, waiter.token, grant.nonce);
      return;
    }
    // S-1：本 Tab 当前是 holding（同 driver 实例内 force 覆盖自己的旧持有）→ 必须完整
    // 清理旧 holding（停心跳 + 切 idle + 触发 revoke 回调），再 enterHolding 授予新锁
    if (state.status.kind === 'holding' && !state.status.released) {
      revokeHolding(state, 'force');
    }
    const handle = enterHolding(state, waiter.token, grant.nonce);
    logger.debug(`[${name}] storage driver: grant (force) token=${waiter.token}`);
    waiter.resolve(handle);
  });
}

/**
 * 快路径抢锁成功时的后处理
 *
 * 把 `acquireNonForceLock` 的快路径 `.then` 回调拆出为独立函数，
 * 降低外层函数圈复杂度；职责不变 —— 根据 destroyed / settled / status 决定：
 *   - 直接授予 handle
 *   - 释放刚抢到的锁并 abort waiter
 *   - 释放刚抢到的锁并降级到慢路径入队
 */
function handleFastPathGrant(state: StorageDriverState, waiter: Waiter, grantNonce: string): void {
  const { name, logger } = state.deps;

  if (state.destroyed) {
    releaseHolderInStorage(state, waiter.token, grantNonce);
    waiter.abort(
      new LockAbortedError(
        `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: storage driver destroyed during fast acquire (token=${waiter.token})`,
      ),
    );
    return;
  }
  // S-4：waiter 在 tryAcquire 期间被 abort —— 抢到的锁立即释放
  if (waiter.isSettled()) {
    releaseHolderInStorage(state, waiter.token, grantNonce);
    return;
  }
  if (state.status.kind !== 'idle') {
    // 极端并发：本方状态已被另一路径改变；把抢到的锁释放，走慢路径
    releaseHolderInStorage(state, waiter.token, grantNonce);
    enqueueSlowPath(state, waiter);
    return;
  }
  const handle = enterHolding(state, waiter.token, grantNonce);
  logger.debug(`[${name}] storage driver: grant (fast-path) token=${waiter.token}`);
  waiter.resolve(handle);
}

/**
 * 非 force 路径的抢锁流程
 *
 * 1. 快路径：本地 idle + 无其他 waiter + storage 可直接抢 → tryAcquire 一次，成功即返回
 * 2. 慢路径：入 storage 队列 + 本地队列 → 等 pumpNextWaiter（由 storage 事件 / polling / release 触发）
 */
function acquireNonForceLock(state: StorageDriverState, waiter: Waiter): void {
  if (!canFastAcquire(state)) {
    enqueueSlowPath(state, waiter);
    return;
  }
  void tryAcquire(state, waiter.token, false).then((grant) => {
    if (grant !== null) {
      handleFastPathGrant(state, waiter, grant.nonce);
      return;
    }
    // 快路径 CAS 失败 → 走慢路径入队（已 settled 的不再重复入队）
    if (!waiter.isSettled()) {
      enqueueSlowPath(state, waiter);
    }
  });
}

/**
 * 把 waiter 加入 storage 队列 + 本地队列
 *
 * storage 入队失败（quota / 写冲突重试耗尽）不阻塞 —— 让 waiter 本地排队等 polling / heartbeat
 * 超时触发 pump；最坏情况下会触发 acquireTimeout
 */
function enqueueSlowPath(state: StorageDriverState, waiter: Waiter): void {
  const { name, logger } = state.deps;
  state.waiters.push(waiter);
  logger.debug(`[${name}] storage driver: enqueue token=${waiter.token}, queue=${state.waiters.length}`);
  void enqueueInStorage(state, waiter.token).then((ok) => {
    if (!ok) {
      logger.warn(
        `[${name}] storage driver: enqueueInStorage failed after retries (token=${waiter.token}); relying on timeout/polling`,
      );
    }
    // 无论 storage 入队是否成功，都尝试 pump 一次
    pumpNextWaiter(state);
  });
}

function acquireStorageLock(state: StorageDriverState, ctx: LockDriverContext): Promise<LockDriverHandle> {
  // driver.acquire 的返回类型是 Promise —— destroyed 必须以 rejection 形式返回，
  // 不能同步 throw（破坏 Promise 契约，调用方 .catch 拿不到）
  if (state.destroyed) {
    return Promise.reject(
      new LockAbortedError(
        `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: storage driver has been destroyed (token=${ctx.token})`,
      ),
    );
  }

  return new Promise<LockDriverHandle>((resolve, reject) => {
    const waiter = buildWaiter(ctx, state, resolve, reject);

    if (ctx.force) {
      acquireForceLock(state, waiter);
      return;
    }

    acquireNonForceLock(state, waiter);
  });
}

/**
 * 创建 StorageDriver 实例
 */
function createStorageDriver(deps: LockDriverDeps): LockDriver {
  const { id } = deps;

  if (!isString(id) || id.length === 0) {
    throwError(ERROR_FN_NAME, 'storage driver requires a non-empty id', TypeError);
  }
  if (!hasUsableLocalStorage()) {
    throwError(ERROR_FN_NAME, 'storage driver requires a usable localStorage', TypeError);
  }

  // hasUsableLocalStorage 已保证 localStorage 存在且可写
  const storage = (globalThis as { localStorage: Storage }).localStorage;

  const state: StorageDriverState = {
    deps,
    storage,
    key: buildLockKey(id),
    status: { kind: 'idle' },
    waiters: [],
    destroyed: false,
    pumping: false,
    unsubscribeStorageEvent: null,
    pollTimer: null,
  };

  state.unsubscribeStorageEvent = subscribeStorageEvent(state);
  state.pollTimer = startPolling(state);

  function buildAbortError(token: string): Error {
    return new LockAbortedError(
      `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: storage driver destroyed (token=${token})`,
    );
  }

  return {
    acquire: (ctx) => acquireStorageLock(state, ctx),
    destroy: () => {
      if (state.destroyed) {
        return;
      }
      state.destroyed = true;
      drainOnDestroy(state, buildAbortError);
    },
  };
}

export { createStorageDriver };
