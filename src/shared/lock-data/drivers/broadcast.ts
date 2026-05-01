/**
 * BroadcastDriver：基于 BroadcastChannel 的跨 Tab 互斥锁
 *
 * 适用场景（由 pickDriver 决定）：
 * - 浏览器环境但不支持 `navigator.locks`（Safari < 15.4 / 老版 Firefox）
 * - 支持 `BroadcastChannel`（否则继续降级到 StorageDriver）
 *
 * 本文件是工厂聚合层，只负责：
 * - 前置依赖校验（getChannel / id 必须提供）
 * - 构造 state 容器并订阅 channel
 * - 暴露 acquire / destroy
 *
 * 协议细节、状态机、消息处理、竞选流程、drain 逻辑分别放在：
 * - `./broadcast-protocol`：消息类型 + 常量 + 校验 + 仲裁工具
 * - `./broadcast-state`：状态机 + 消息处理 + 竞选流程 + drainOnDestroy
 *
 * 前置条件：`deps.getChannel` 必须提供且返回非 null（由 pickDriver 保证）；否则构造期抛错
 */

import { throwError } from '@/shared/throw-error';
import { isFunction, isNumber, isString } from '@/shared/utils/verify';
import { ERROR_FN_NAME } from '../constants';
import { LockAbortedError, LockTimeoutError } from '../errors';
import type { ChannelAdapter, LockDriverContext, LockDriverHandle } from '../types';
import { genId } from './broadcast-protocol';
import {
  type BroadcastDriverState,
  drainOnDestroy,
  handleMessage,
  pumpNextWaiter,
  removeWaiter,
  startAnnounceCampaign,
  startForceCampaign,
  type Waiter,
} from './broadcast-state';
import type { LockDriver, LockDriverDeps } from './types';

/**
 * 构造一个 waiter 并绑定 signal / timeout 的 abort 生命周期
 *
 * 职责：
 * - `settled` 标志保证 resolve / reject / abort 互斥，只有第一次生效
 * - `cleanup`：清理 timeout + signal listener
 * - `abort`：把 waiter 从队列 / pending 中移除后，走 reject 兜底
 */
function buildWaiter(
  ctx: LockDriverContext,
  state: BroadcastDriverState,
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
      // 若自己是 pendingAnnounce / pendingForce 的 waiter，标记放弃并清理 timer，
      // 但不走 abandonPendingXxx（那会把 waiter 回队）—— 这里直接 reject 终结
      if (state.pendingAnnounce !== null && state.pendingAnnounce.waiter === waiter) {
        const pending = state.pendingAnnounce;
        pending.abandoned = true;
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        state.pendingAnnounce = null;
      }
      if (state.pendingForce !== null && state.pendingForce.waiter === waiter) {
        const pending = state.pendingForce;
        pending.abandoned = true;
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
          pending.timer = null;
        }
        state.pendingForce = null;
      }
      waiter.reject(error);
      // 此时本方状态回 idle（若此前就是 idle / pending；pending 清空等价）；
      // 需要触发 pump 让队列后续 waiter 能被服务
      pumpNextWaiter(state);
    },
  };

  function onSignalAbort(): void {
    waiter.abort(
      new LockAbortedError(`[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: acquire aborted (token=${ctx.token})`),
    );
  }

  // 外部 signal 已 abort：microtask 触发 abort（保持 acquire 返回 Promise 的异步语义）
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

function acquireBroadcastLock(state: BroadcastDriverState, ctx: LockDriverContext): Promise<LockDriverHandle> {
  // driver.acquire 的返回类型是 Promise —— destroyed 必须以 rejection 形式返回，
  // 不能同步 throw（破坏 Promise 契约，调用方 .catch 拿不到）
  if (state.destroyed) {
    return Promise.reject(
      new LockAbortedError(
        `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: broadcast driver has been destroyed (token=${ctx.token})`,
      ),
    );
  }

  return new Promise<LockDriverHandle>((resolve, reject) => {
    const waiter = buildWaiter(ctx, state, resolve, reject);

    if (ctx.force) {
      startForceCampaign(state, waiter);
      return;
    }

    if (state.status.kind === 'idle' && state.pendingAnnounce === null && state.pendingForce === null) {
      startAnnounceCampaign(state, waiter);
      return;
    }

    state.waiters.push(waiter);
    const { name, logger } = state.deps;
    logger.debug(
      `[${name}] broadcast driver: enqueue token=${ctx.token}, queue=${state.waiters.length}, status=${state.status.kind}`,
    );
  });
}

/**
 * 创建 BroadcastDriver 实例
 */
function createBroadcastDriver(deps: LockDriverDeps): LockDriver {
  const { id, getChannel } = deps;

  if (!isFunction(getChannel)) {
    throwError(ERROR_FN_NAME, 'broadcast driver requires getChannel factory', TypeError);
  }
  if (!isString(id) || id.length === 0) {
    throwError(ERROR_FN_NAME, 'broadcast driver requires a non-empty id', TypeError);
  }

  const channel = (getChannel as NonNullable<LockDriverDeps['getChannel']>)({ id, channel: 'custom' });
  if (channel === null) {
    throwError(ERROR_FN_NAME, 'broadcast driver getChannel returned null', TypeError);
  }
  const resolvedChannel = channel as ChannelAdapter;

  const state: BroadcastDriverState = {
    deps,
    channel: resolvedChannel,
    senderId: genId('sender'),
    status: { kind: 'idle' },
    waiters: [],
    pendingAnnounce: null,
    pendingForce: null,
    destroyed: false,
    unsubscribe: null,
  };

  state.unsubscribe = resolvedChannel.subscribe((raw) => handleMessage(state, raw));

  function buildAbortError(token: string): Error {
    return new LockAbortedError(
      `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: broadcast driver destroyed (token=${token})`,
    );
  }

  return {
    acquire: (ctx) => acquireBroadcastLock(state, ctx),
    destroy: () => {
      if (state.destroyed) {
        return;
      }
      state.destroyed = true;
      drainOnDestroy(state, buildAbortError);
    },
  };
}

export { createBroadcastDriver };
