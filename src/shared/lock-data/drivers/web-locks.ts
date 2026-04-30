/**
 * WebLocksDriver：基于 `navigator.locks` 的跨 Tab 互斥锁实现（首选 driver）
 *
 * 适用场景（由 pickDriver 决定）：
 * - `mode === 'auto'` 且运行时检测到 `navigator.locks`（现代浏览器 / Chromium 内核环境）
 * - `mode === 'web-locks'` 强制指定
 *
 * 实现要点（对应 RFC.md「WebLocksDriver（首选）」）：
 * - 核心 API：`navigator.locks.request(name, { mode: 'exclusive', steal, signal }, callback)`
 * - `callback` 持锁期间必须返回一个 Promise；锁会一直持有直到该 Promise settle
 *   → 这里构造一个外部可 resolve 的 `holdPromise`，`LockHandle.release` 就是 resolve 它
 * - `force: true` → `steal: true`；原持有者的 callback 会以 `AbortError` reject，
 *   捕获后把原 handle 的 `onRevokedByDriver('force')` 触发
 * - `acquireTimeout` → `AbortController.abort()`；`navigator.locks.request` 会 reject
 *   `AbortError`（注意需要与 steal 场景区分：本 handle 还没拿到锁就 abort，而非被抢）
 * - `signal.aborted`（外部 signal）同 `acquireTimeout` 通过合并 AbortController 统一处理
 * - `destroy`：对所有仍持有锁的 handle 调用 release；等待中的 acquire 由各自的 signal
 *   负责清理（destroy 会广播 abort 给内部 controller）
 *
 * 与其他 driver 的关键差异：
 * - 互斥语义由浏览器保证（跨 Tab），无需自研排队协议
 * - `release` 是**同步**触发（resolve holdPromise），但底层 navigator.locks 的清理
 *   是微任务队列，所以上层看到的 release Promise 下一轮 tick 才 settle
 */

import { throwError } from '@/shared/throw-error';
import { isFunction, isNumber, isObject } from '@/shared/utils/verify';
import { withResolvers } from '@/shared/with-resolvers';
import { ERROR_FN_NAME } from '../constants';
import { LockAbortedError, LockTimeoutError } from '../errors';
import type { LockDriverContext, LockDriverHandle } from '../types';
import type { LockDriver, LockDriverDeps } from './types';

/**
 * Web Locks API 的最小化类型定义
 *
 * 为什么不直接用 `lib.dom` 内置 types：
 * - TypeScript 4.x / 早期 5.x 的 lib.dom 对 `LockManager` 的定义不完整
 *   （缺 `steal` / `ifAvailable` 字段）；本地定义保证 strict 下可编译
 * - 仅声明 driver 内部实际用到的子集，不追求全面
 */
interface WebLockRequestOptions {
  mode?: 'exclusive' | 'shared';
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

interface WebLockManager {
  readonly request: <T>(
    name: string,
    options: WebLockRequestOptions,
    callback: (lock: unknown) => Promise<T> | T,
  ) => Promise<T>;
}

/**
 * 从运行时获取 `navigator.locks`；不存在则返回 null
 *
 * 正常路径下 pickDriver 会在选中本 driver 前做能力检测，本函数兜底覆盖两种边缘场景：
 * 1. 上层绕过 pickDriver 直接实例化本 driver（如单元测试）
 * 2. 运行时 `navigator` 对象缺失（非浏览器环境 + Node 22+ 的部分运行时）
 * 返回 null 时由 `createWebLocksDriver` 构造期抛错，不会静默降级
 */
function getWebLockManager(): WebLockManager | null {
  if (typeof navigator === 'undefined') {
    return null;
  }
  const { locks } = navigator as unknown as { locks?: WebLockManager };
  return locks || null;
}

/**
 * 内部持有态：一次成功 acquire 产生一条
 *
 * - `holdPromise`：callback 期间返回给 navigator.locks 的 Promise；resolve 时锁释放
 * - `resolveHold`：从外部 resolve holdPromise 的闭包引用，`release` 调用它
 * - `revokeCallback`：用户（actions 层）通过 `onRevokedByDriver` 注册的回调
 * - `released`：幂等开关
 */
interface WebLockHolding {
  readonly token: string;
  readonly holdPromise: Promise<void>;
  readonly resolveHold: () => void;
  revokeCallback: ((reason: 'force' | 'timeout') => void) | null;
  released: boolean;
}

/**
 * 把 `ctx.signal` 与 `acquireTimeout` 合并为单一 AbortSignal 传给 navigator.locks
 *
 * 为什么需要合并：
 * - navigator.locks.request 只接受单个 signal 作为"放弃抢锁"的开关
 * - 需要同时响应"外部 signal abort"与"acquireTimeout 到期"两条路径
 * - 用 `AbortController` 手动合并比 `AbortSignal.any` 兼容面更广
 *
 * 返回的 cleanup 必须在 `navigator.locks.request` settle 后调用，清理 timer + listener
 */
function mergeSignalWithTimeout(
  externalSignal: AbortSignal,
  acquireTimeout: LockDriverContext['acquireTimeout'],
  token: string,
): { signal: AbortSignal; cleanup: () => void; getTimeoutFired: () => boolean } {
  const controller = new AbortController();
  let timeoutFired = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (externalSignal.aborted) {
    controller.abort(externalSignal.reason);
    return {
      signal: controller.signal,
      cleanup: () => undefined,
      getTimeoutFired: () => timeoutFired,
    };
  }

  function onExternalAbort(): void {
    controller.abort(externalSignal.reason);
  }
  externalSignal.addEventListener('abort', onExternalAbort, { once: true });

  if (isNumber(acquireTimeout) && acquireTimeout > 0) {
    timeoutId = setTimeout(() => {
      timeoutFired = true;
      controller.abort(
        new LockTimeoutError(
          `[@cmtlyt/lingshu-toolkit#${ERROR_FN_NAME}]: acquire timed out after ${acquireTimeout}ms (token=${token})`,
        ),
      );
    }, acquireTimeout);
  }

  function cleanup(): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    externalSignal.removeEventListener('abort', onExternalAbort);
  }

  return {
    signal: controller.signal,
    cleanup,
    getTimeoutFired: () => timeoutFired,
  };
}

/** 判定错误是否属于 navigator.locks abort 类型（DOMException 'AbortError'） */
function isAbortLikeError(error: unknown): boolean {
  if (!isObject(error)) {
    return false;
  }
  const { name: errorName } = error as { name?: unknown };
  return errorName === 'AbortError';
}

/** 顶层辅助函数共享的 driver 级依赖容器 */
interface DriverScope {
  readonly holdings: Set<WebLockHolding>;
  readonly logger: LockDriverDeps['logger'];
  readonly driverName: string;
}

/**
 * 已拿到锁后被 steal / force 驱逐的处理路径
 *
 * W3C 规范：原持有者的 `navigator.locks.request` 返回 Promise 以 AbortError reject；
 * 必须显式 `resolveHold()` 避免 callback 里的 holdPromise 永远挂起（虽然 navigator.locks
 * 此时已释放锁，但不 resolve 会造成本地 Promise 泄漏 + 后续 release 的幂等判定失效）
 *
 * 提至模块顶层，通过 `scope` 容器传入 driver 级依赖，降低 `createWebLocksDriver` 的
 * linesPerFunction（biome noExcessiveLinesPerFunction = 100）
 */
function handleStealRejection(seized: WebLockHolding, scope: DriverScope): void {
  if (seized.released) {
    return;
  }
  const { holdings, logger, driverName } = scope;
  seized.released = true;
  holdings.delete(seized);
  seized.resolveHold();
  logger.debug(`[${driverName}] web-locks driver: revoked by steal token=${seized.token}`);
  if (isFunction(seized.revokeCallback)) {
    try {
      seized.revokeCallback('force');
    } catch (cbError) {
      logger.error(`[${driverName}] web-locks driver: revoke callback threw`, cbError);
    }
  }
}

/**
 * 处理 navigator.locks.request 的 settle —— 分三种情况：
 *   1. resolve 路径（正常 release）→ 兜底清理 holding
 *   2. reject + 已持有 → steal 路径，触发 onRevokedByDriver('force')
 *   3. reject + 未持有 → 未拿到锁就被 abort / 非法参数等，把错误传给 acquire 入口
 */
function wireRequestSettle(
  requestPromise: Promise<unknown>,
  getHolding: () => WebLockHolding | null,
  rejectGranted: (error: unknown) => void,
  scope: DriverScope,
): void {
  const { holdings } = scope;
  requestPromise
    .then(() => {
      const current = getHolding();
      if (current && !current.released) {
        current.released = true;
        holdings.delete(current);
      }
    })
    .catch((error: unknown) => {
      const current = getHolding();
      if (current) {
        handleStealRejection(current, scope);
        return;
      }
      rejectGranted(error);
    });
}

function createWebLocksDriver(deps: LockDriverDeps): LockDriver {
  const { name, logger } = deps;
  const manager = getWebLockManager();

  if (!manager) {
    throwError(ERROR_FN_NAME, 'web-locks driver requires navigator.locks; use auto mode or fallback driver', TypeError);
  }
  const lockManager = manager as WebLockManager;

  /** 当前 driver 实例下所有仍在持有锁的 handle；destroy 时统一 release */
  const holdings = new Set<WebLockHolding>();
  let destroyed = false;

  async function acquire(ctx: LockDriverContext): Promise<LockDriverHandle> {
    if (destroyed) {
      throwError(ERROR_FN_NAME, 'web-locks driver has been destroyed', LockAbortedError as unknown as ErrorConstructor);
    }

    const { signal, cleanup, getTimeoutFired } = mergeSignalWithTimeout(ctx.signal, ctx.acquireTimeout, ctx.token);

    // 构造 holdPromise —— callback 里 return 它，锁才会一直持有；`release` 通过
    // `hold.resolve()` 释放锁（navigator.locks 观察到 callback 返回的 Promise settle 即放锁）
    const hold = withResolvers<void>();

    // holding 对象在 callback 首次被调用（即真正拿到锁）时生成并 push 到 `holdings`
    let holding: WebLockHolding | null = null;

    // 把"已拿到锁"这件事从 callback 通过 Promise 传到外部的 acquire await 点
    // - `granted.resolve(holding)`：callback 首次被调用时触发（即真正拿到锁）
    // - `granted.reject(error)`：request 在 callback 被调用**之前**就 reject（abort / 非法参数等）
    const granted = withResolvers<WebLockHolding>();

    // 启动 navigator.locks.request —— 不 await 它本身，只 await grantedPromise
    // 理由：request 的返回 Promise 在 callback 内的 holdPromise resolve 后才完成，
    // 而 acquire 需要在"callback 首次被调用"时就返回给上层（即 granted）
    //
    // W3C 规范：`steal` 与 `signal` 互斥不能同时传入（LockManager 会抛 NotSupportedError）
    // - force=true → 走 steal 路径（立即抢占，navigator.locks 内部同步决断，无需 signal 取消）
    // - force=false → 走 signal 路径（用合并 signal 统一承载 timeout / 外部 abort 的取消语义）
    const requestOptions: WebLockRequestOptions =
      ctx.force === true ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', signal };
    const requestPromise = lockManager.request(name, requestOptions, () => {
      // callback 首次被调用即表示"已拿到锁"
      holding = {
        token: ctx.token,
        holdPromise: hold.promise,
        resolveHold: hold.resolve,
        revokeCallback: null,
        released: false,
      };
      holdings.add(holding);
      logger.debug(`[${name}] web-locks driver: grant token=${ctx.token} steal=${ctx.force === true}`);
      granted.resolve(holding);
      // 返回 hold.promise 让 navigator.locks 持续持有锁，直到 release 显式 resolve
      return hold.promise;
    });

    wireRequestSettle(requestPromise, () => holding, granted.reject, { holdings, logger, driverName: name });

    try {
      const settled = await granted.promise;
      cleanup();
      return buildHandleFor(settled);
    } catch (error) {
      cleanup();
      // navigator.locks 在 signal abort 时抛 DOMException('AbortError')
      // 这里映射为我们自己的错误类型，保持所有 driver 的错误语义一致
      if (getTimeoutFired()) {
        throwError(
          ERROR_FN_NAME,
          `acquire timed out after ${String(ctx.acquireTimeout)}ms (token=${ctx.token})`,
          LockTimeoutError as unknown as ErrorConstructor,
          { cause: error },
        );
      }
      if (isAbortLikeError(error) || ctx.signal.aborted) {
        throwError(
          ERROR_FN_NAME,
          `acquire aborted (token=${ctx.token})`,
          LockAbortedError as unknown as ErrorConstructor,
          { cause: error },
        );
      }
      logger.error(`[${name}] web-locks driver: request failed (token=${ctx.token})`, error);
      throw error;
    }
  }

  /**
   * 给指定 holding 构造用户向 handle
   *
   * release 职责：
   *   - 幂等（通过 holding.released 判定）
   *   - resolve holdPromise → navigator.locks 释放锁
   *   - 从 `holdings` 集合移除
   *   - 不直接清理 revokeCallback（已驱逐场景下 callback 已调用过一次；防御性重复调用由 released 开关拦截）
   */
  function buildHandleFor(holding: WebLockHolding): LockDriverHandle {
    return {
      release: () => {
        if (holding.released) {
          return;
        }
        holding.released = true;
        holdings.delete(holding);
        holding.resolveHold();
        logger.debug(`[${name}] web-locks driver: release token=${holding.token}`);
      },
      onRevokedByDriver: (callback) => {
        holding.revokeCallback = callback;
      },
    };
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    logger.debug(`[${name}] web-locks driver: destroy (active holdings=${holdings.size})`);
    // 复制一份再遍历，避免 resolveHold 触发的副作用修改 `holdings`
    // 用 Array.from 代替 forEach —— biome.useIterableCallbackReturn 禁止 forEach 回调有返回值
    const snapshot = Array.from(holdings);
    for (let i = 0; i < snapshot.length; i++) {
      const holding = snapshot[i];
      if (!holding.released) {
        holding.released = true;
        holdings.delete(holding);
        holding.resolveHold();
      }
    }
  }

  return { acquire, destroy };
}

export { createWebLocksDriver };
