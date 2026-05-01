/**
 * LocalLockDriver：进程内互斥锁
 *
 * 适用场景（由 pickDriver 决定）：
 * - 未传 id（纯本地只读锁）
 * - `mode` 显式指定为 'storage' 但环境完全不可用时的最终兜底
 *
 * 实现要点（对应 RFC.md「LocalLockDriver」「能力检测与降级」）：
 * - 同 driver 实例内维护一个 FIFO 等待队列；`acquire` 产生的 `LockHandle` 在 `release`
 *   调用时把下一个 waiter 从队首取出并 resolve
 * - `force: true` 立即抢占：当前持有者的 `onRevokedByDriver` 以 `'force'` 回调，
 *   新请求跳过队列直接持锁
 * - `acquireTimeout` 用本地 `setTimeout` 计时；signal.aborted 或 timeout 触发时把
 *   对应 waiter 从队列中移除并 reject
 * - `destroy`：把所有等待者 reject 为 `LockAbortedError`，并清空队列；当前持有者
 *   `onRevokedByDriver('force')` 并让 release 变成幂等 no-op
 *
 * **注意**：本 driver 与 id 无关；同一进程内如有多份 LocalLockDriver 实例，它们
 * 之间不互斥（由 InstanceRegistry 按 id 唯一化 driver 保证"同 id 共享同一 driver"）
 */

import { throwError } from '@/shared/throw-error';
import { isFunction, isNumber } from '@/shared/utils/verify';
import { ERROR_FN_NAME } from '../constants';
import { LockAbortedError, LockTimeoutError } from '../errors';
import type { LockDriverContext, LockDriverHandle } from '../types';
import type { LockDriver, LockDriverDeps } from './types';

/**
 * 队列中的等待者；每次 `acquire` 未立即拿到锁时会 push 一条
 *
 * `force: true` 的 acquire 走 seize 快路径不入队列，所以 waiter 永远是"普通等待者"
 *
 * - `resolve` / `reject`：完成该次 acquire 的 Promise
 * - `abort`：外部通知 waiter "放弃等待"（signal / timeout / destroy），需要解绑计时器
 *   + 从队列里移除自己，再把 promise reject
 * - `token`：用于日志与 debug
 */
interface LocalWaiter {
  readonly token: string;
  readonly resolve: (handle: LockDriverHandle) => void;
  readonly reject: (error: Error) => void;
  /** 外部请求中止等待（signal.aborted / timeout / destroy），返回时 waiter 已从队列移除 */
  readonly abort: (error: Error) => void;
}

/** 当前持有者；driver 内部维护，release / revoke 时清空 */
interface LocalHolder {
  readonly token: string;
  /** 通知持有者被驱逐；由 driver 在 force 抢占 / destroy 时调用 */
  readonly notifyRevoke: (reason: 'force' | 'timeout') => void;
  /** release 幂等开关；多次 release 只有第一次会推进队列 */
  released: boolean;
}

/**
 * driver 闭包共享的可变状态句柄；拆出来是为了把原 `createLocalLockDriver` 超长主体拆成独立工具函数
 *
 * 通过引用共享 holder 指针：每个工具函数都能读写同一个 holder / waiters / destroyed
 */
interface LocalDriverState {
  readonly name: string;
  readonly logger: LockDriverDeps['logger'];
  readonly waiters: LocalWaiter[];
  holder: LocalHolder | null;
  destroyed: boolean;
}

/**
 * 构造一个 handle；把 release / onRevokedByDriver 绑定到 driver 内部状态机
 *
 * release 职责：
 *   - 幂等：重复调用仅第一次生效
 *   - driver 层无异步 I/O，所以 release 同步完成（返回 void）
 *   - 推进队列：取队首 waiter → 授予锁（构造新 handle）→ 清理该 waiter
 */
function buildLocalHandle(
  state: LocalDriverState,
  token: string,
  onReleased: () => void,
): { handle: LockDriverHandle; notifyRevoke: LocalHolder['notifyRevoke'] } {
  const { name, logger } = state;
  // 持有者订阅的 revoke 回调；最多订阅一次（新回调覆盖旧回调，与 WebLocks/Broadcast 一致）
  let revokeCallback: ((reason: 'force' | 'timeout') => void) | null = null;

  const handle: LockDriverHandle = {
    release: () => {
      // 幂等：通过 holder.released 判定；非当前持有者时 no-op
      // - 被 force 抢占后原持有者再调 release 走此分支（holder.token 已变）
      // - 第二次调用 release 走 holder.released = true 分支
      const { holder } = state;
      if (!holder || holder.token !== token || holder.released) {
        return;
      }
      holder.released = true;
      state.holder = null;
      logger.debug(`[${name}] local driver: release by token=${token}`);
      onReleased();
    },
    onRevokedByDriver: (callback) => {
      revokeCallback = callback;
    },
  };

  return {
    handle,
    notifyRevoke: (reason) => {
      if (isFunction(revokeCallback)) {
        try {
          revokeCallback(reason);
        } catch (error) {
          // revoke 回调是用户 listeners 的上游触发路径；异常仅记日志，不影响 driver 流转
          logger.error(`[${name}] local driver: revoke callback threw`, error);
        }
      }
    },
  };
}

/**
 * 把队首 waiter 出队并授予锁；若队列为空则保持空闲
 *
 * 这里不做 signal 校验（waiter 进入队列时已注册监听器，signal.aborted 会自行出队）
 */
function pumpNextWaiter(state: LocalDriverState): void {
  const { name, logger, waiters } = state;
  if (state.holder || waiters.length === 0) {
    return;
  }
  // shift 出队首；此时 waiter 的 abort 不应再生效（resolve 后不再移队列）
  const next = waiters.shift();
  if (!next) {
    return;
  }
  const { handle, notifyRevoke } = buildLocalHandle(state, next.token, () => pumpNextWaiter(state));
  state.holder = { token: next.token, notifyRevoke, released: false };
  logger.debug(`[${name}] local driver: grant token=${next.token}`);
  next.resolve(handle);
}

/**
 * 从队列移除指定 waiter（waiter 放弃等待时调用）
 *
 * 使用索引 for 是因为 Array.findIndex + splice 对热路径的两次遍历并不划算
 */
function removeWaiter(waiters: LocalWaiter[], target: LocalWaiter): void {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i] === target) {
      waiters.splice(i, 1);
      return;
    }
  }
}

/**
 * 立即强制抢占；由 `force: true` 的 acquire 触发
 *
 * 语义：
 *   - 当前持有者若存在，回调 `onRevokedByDriver('force')` + 把 holder 清空
 *   - force waiter 不入队，直接拿锁
 *   - 原持有者后续调用 `release()` 会走幂等 no-op 路径（holder.token 已变）
 */
function seizeLock(state: LocalDriverState, token: string): LockDriverHandle {
  const { name, logger } = state;
  if (state.holder) {
    const prev = state.holder;
    prev.released = true; // 让原持有者的 release 变成幂等 no-op
    state.holder = null;
    logger.debug(`[${name}] local driver: force-seize from token=${prev.token} by token=${token}`);
    prev.notifyRevoke('force');
  }
  const { handle, notifyRevoke } = buildLocalHandle(state, token, () => pumpNextWaiter(state));
  state.holder = { token, notifyRevoke, released: false };
  logger.debug(`[${name}] local driver: grant (force) token=${token}`);
  return handle;
}

/**
 * 构造 waiter 并把它 enqueue 到队列；返回 Promise 在拿到锁 / abort 时 settle
 *
 * 拆分为独立函数是为了控制 `createLocalLockDriver` 的函数行数（biome noExcessiveLinesPerFunction）
 */
function enqueueWaiter(state: LocalDriverState, ctx: LockDriverContext): Promise<LockDriverHandle> {
  const { name, logger, waiters } = state;
  return new Promise<LockDriverHandle>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    function cleanup(): void {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      ctx.signal.removeEventListener('abort', onSignalAbort);
    }

    const waiter: LocalWaiter = {
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
        removeWaiter(waiters, waiter);
        waiter.reject(error);
      },
    };

    function onSignalAbort(): void {
      waiter.abort(
        new LockAbortedError(`[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: acquire aborted (token=${ctx.token})`),
      );
    }

    // 注册 timeout —— 仅当有限超时（正数）才注册；NEVER_TIMEOUT / 非法值跳过
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

    ctx.signal.addEventListener('abort', onSignalAbort, { once: true });

    waiters.push(waiter);
    logger.debug(`[${name}] local driver: enqueue token=${ctx.token}, queue size=${waiters.length}`);
  });
}

/** `acquire` 的主逻辑；`createLocalLockDriver` 只负责透传 */
async function acquireLocalLock(state: LocalDriverState, ctx: LockDriverContext): Promise<LockDriverHandle> {
  const { name, logger } = state;
  if (state.destroyed) {
    throwError(ERROR_FN_NAME, 'local driver has been destroyed', LockAbortedError as unknown as ErrorConstructor);
  }
  // 进入 acquire 前先做 signal 快路径检查，避免无谓的队列操作
  if (ctx.signal.aborted) {
    throwError(
      ERROR_FN_NAME,
      `acquire aborted before start (token=${ctx.token})`,
      LockAbortedError as unknown as ErrorConstructor,
    );
  }

  // force：立即抢占，不进队列、不参与 timeout 计时
  if (ctx.force) {
    return seizeLock(state, ctx.token);
  }

  // 锁空闲：立即拿到；无需构造 waiter
  if (!state.holder) {
    const { handle, notifyRevoke } = buildLocalHandle(state, ctx.token, () => pumpNextWaiter(state));
    state.holder = { token: ctx.token, notifyRevoke, released: false };
    logger.debug(`[${name}] local driver: grant (fast-path) token=${ctx.token}`);
    return handle;
  }

  // 进入排队：构造 waiter + 注册 signal / timeout 出队机制
  return enqueueWaiter(state, ctx);
}

/**
 * destroy 的清理动作；抽出为独立函数以控制 `createLocalLockDriver` 主体行数
 *
 * 清理顺序：
 * 1. 驱逐当前持有者（notifyRevoke('force') + 让 release 变幂等 no-op）
 * 2. 清空 waiter 队列（每个 waiter 的 abort 把自己 reject 为 LockAbortedError）
 *
 * 不在此函数内修改 `destroyed` 标记；由调用方统一设置，保证幂等语义由外层控制
 */
function drainOnDestroy(state: LocalDriverState): void {
  const { name, logger, waiters } = state;
  logger.debug(`[${name}] local driver: destroy (waiters=${waiters.length}, holding=${state.holder ? 'yes' : 'no'})`);

  if (state.holder) {
    const prev = state.holder;
    prev.released = true;
    state.holder = null;
    prev.notifyRevoke('force');
  }

  // 清空所有 waiter —— 直接 reject 为 LockAbortedError
  // 使用索引 for 遍历副本（abort 内部会修改原数组，避免并发修改）
  const pending = waiters.slice();
  waiters.length = 0;
  for (let i = 0; i < pending.length; i++) {
    pending[i].abort(
      new LockAbortedError(
        `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: local driver destroyed (token=${pending[i].token})`,
      ),
    );
  }
}

/**
 * 创建一个 LocalLockDriver 实例
 *
 * driver 为"按 id 单例"（由 InstanceRegistry 管理），本函数只负责实例化，
 * 不关心 id 是否存在（name 已由 pickDriver 拼好）
 */
function createLocalLockDriver(deps: LockDriverDeps): LockDriver {
  const { name, logger } = deps;

  const state: LocalDriverState = {
    name,
    logger,
    waiters: [],
    holder: null,
    destroyed: false,
  };

  return {
    acquire: (ctx) => acquireLocalLock(state, ctx),
    destroy: () => {
      if (state.destroyed) {
        return;
      }
      state.destroyed = true;
      drainOnDestroy(state);
    },
  };
}

export { createLocalLockDriver };
