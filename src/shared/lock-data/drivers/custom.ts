/**
 * CustomDriver：包装用户注入的 `adapters.getLock` 为统一 `LockDriver` 接口
 *
 * 适用场景：`adapters.getLock` 存在时由 pickDriver 直接选中；`mode` 字段被忽略
 * （对应 RFC.md「能力检测与降级」「CustomDriver」章节）
 *
 * 职责范围：
 * - 透传 `name` / `token` / `force` / `source` / 超时 / 合并 signal 到用户工厂
 * - 把 `acquireTimeout` 统一映射为 signal abort，让用户工厂只需监听 `ctx.signal`
 *   即可同时响应"超时"与"外部取消"两条路径
 * - 把用户返回的 `LockDriverHandle`（可能是 Promise）规范化为"同步 handle"返回给上层
 * - `destroy` 不碰用户资源（用户 handle 由 actions 的 release 路径负责释放）；仅
 *   清理本 driver 内部持有的合并 controller / 订阅（当前无）
 *
 * 与其他 driver 的关键差异：
 * - 不维护排队 / 心跳 / storage 订阅；完全信任用户实现的互斥语义
 * - 不拒绝"用户工厂返回的 handle 缺失 onRevokedByDriver"的情况（Phase 5 状态机会
 *   在 force / timeout 触发时自发广播，不强依赖 driver 上报）
 */

import { throwError } from '@/shared/throw-error';
import { isFunction, isNumber, isPromiseLike } from '@/shared/utils/verify';
import { ERROR_FN_NAME } from '../constants';
import { LockAbortedError, LockTimeoutError } from '../errors';
import type { LockDataAdapters, LockDriverContext, LockDriverHandle } from '../types';
import type { LockDriver, LockDriverDeps } from './types';

/**
 * 合并 `ctx.signal` 与 `acquireTimeout`：
 *
 * - 返回一个新的 `AbortSignal`，其 `aborted` 当且仅当以下任一发生：
 *   1. 外部 `ctx.signal.aborted`（dispose / revoked / 用户 actionCallOptions.signal）
 *   2. `acquireTimeout` 到期
 * - 返回 `cleanup` 函数，用于在 `acquire` resolve / reject 后清理 timer + listener
 *
 * 为什么不用 `AbortSignal.any`：
 * - `AbortSignal.any` 仅 Safari 17+ / Chrome 116+ / Node 20+ 支持，兼容面较新
 * - 本函数在纯 Node / Jest 环境同样可用（只依赖 `AbortController`），且能把"超时"
 *   作为原因写入 abort reason，后续透传给 LockTimeoutError.cause
 */
function mergeSignalWithTimeout(
  externalSignal: AbortSignal,
  acquireTimeout: LockDriverContext['acquireTimeout'],
  token: string,
): { signal: AbortSignal; cleanup: () => void; getTimeoutFired: () => boolean } {
  const controller = new AbortController();
  let timeoutFired = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  // 外部 signal 已 abort：直接透传给合并 controller
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

  // 仅当有限超时时才注册 timer
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

/**
 * 把用户返回的 handle 规范化：
 *
 * - `release`：包裹一层，保证返回值始终是 `void | Promise<void>`，并捕获异常
 *   避免用户 release 抛错中断上层 release 链（错误仅日志）
 * - `onRevokedByDriver`：**按用户是否提供决定字段是否存在**
 *   - 用户提供 → 绑定用户 handle 的 this 后透传，actions 层注册的回调会收到 driver 侧的 force / timeout 事件
 *   - 用户未提供 → 字段保留 `undefined`；actions 层会检测到并退回到"本端自发"语义：
 *     force / timeout 由本端状态机主动触发，但**无法感知对端驱逐**（该限制由 RFC 附录 A
 *     的 `LockHandle.onRevokedByDriver: optional` 契约允许）
 *   用户若需完整的跨端驱逐感知，必须在自定义 `adapters.getLock` 中实现 `onRevokedByDriver`
 */
function wrapUserHandle(handle: LockDriverHandle, deps: LockDriverDeps, token: string): LockDriverHandle {
  const { name, logger } = deps;
  const userRelease = handle.release;
  const userOnRevoked = handle.onRevokedByDriver;

  const wrapped = {
    release: () => {
      let ret: void | PromiseLike<void>;
      try {
        // `.call(handle)` 保证用户 release 是普通方法（非箭头函数）时 this 指向用户 handle 本体；
        // 箭头函数下 .call 的 thisArg 被忽略，两种形态均安全
        ret = userRelease.call(handle);
      } catch (error) {
        logger.error(`[${name}] custom driver: user release threw (token=${token})`, error);
        return;
      }
      if (!isPromiseLike(ret)) {
        return;
      }
      // 返回用户的 Promise 并附带 error 兜底；上层 Entry.release 会 await 这个返回值
      // 把 rejection 吞掉（仅日志）是为了不让用户 release 抛错中断 Entry 的引用计数推进
      return Promise.resolve(ret).catch((error: unknown) => {
        logger.error(`[${name}] custom driver: user release rejected (token=${token})`, error);
      });
    },
  } as LockDriverHandle;

  if (isFunction(userOnRevoked)) {
    wrapped.onRevokedByDriver = userOnRevoked.bind(handle);
  }

  return wrapped;
}

/**
 * 创建 CustomDriver 实例
 *
 * 前置条件：`deps.userGetLock` 必须已提供（由 pickDriver 保证）；否则构造期抛错
 */
function createCustomLockDriver(deps: LockDriverDeps): LockDriver {
  const { name, logger, userGetLock } = deps;

  if (!isFunction(userGetLock)) {
    throwError(ERROR_FN_NAME, 'custom driver requires adapters.getLock to be a function', TypeError);
  }

  // userGetLock 经上面 guard 后已确定为 function；缓存到局部变量消除 ts 非空断言
  const getLock = userGetLock as NonNullable<LockDataAdapters<unknown>['getLock']>;
  let destroyed = false;

  async function acquire(ctx: LockDriverContext): Promise<LockDriverHandle> {
    if (destroyed) {
      throwError(ERROR_FN_NAME, 'custom driver has been destroyed', LockAbortedError as unknown as ErrorConstructor);
    }

    // 合并 signal —— 让用户工厂只需监听一个 signal 就能同时响应 timeout 与外部取消
    const { signal, cleanup, getTimeoutFired } = mergeSignalWithTimeout(ctx.signal, ctx.acquireTimeout, ctx.token);

    // 构造传给用户工厂的 ctx；不直接透传 `ctx.signal`，改传合并后的 signal
    const userCtx: LockDriverContext = {
      name,
      token: ctx.token,
      force: ctx.force,
      acquireTimeout: ctx.acquireTimeout,
      holdTimeout: ctx.holdTimeout,
      signal,
    };

    try {
      const result = getLock(userCtx);
      const handle = await Promise.resolve(result);
      cleanup();
      logger.debug(`[${name}] custom driver: grant token=${ctx.token}`);
      return wrapUserHandle(handle, deps, ctx.token);
    } catch (error) {
      cleanup();
      // 优先识别"因超时触发的 abort" —— 用户工厂通常会把 signal reject 透传出来；
      // 这里统一映射为 LockTimeoutError，保证上层拿到的错误类型与其他 driver 一致
      if (getTimeoutFired()) {
        throwError(
          ERROR_FN_NAME,
          `acquire timed out after ${String(ctx.acquireTimeout)}ms (token=${ctx.token})`,
          LockTimeoutError as unknown as ErrorConstructor,
          { cause: error },
        );
      }
      // 外部 signal abort —— 映射为 LockAbortedError
      if (ctx.signal.aborted) {
        throwError(
          ERROR_FN_NAME,
          `acquire aborted (token=${ctx.token})`,
          LockAbortedError as unknown as ErrorConstructor,
          { cause: error },
        );
      }
      // 用户工厂自身抛错 —— 原样透传（logger.error 方便定位）
      logger.error(`[${name}] custom driver: user getLock rejected (token=${ctx.token})`, error);
      throw error;
    }
  }

  function destroy(): void {
    if (destroyed) {
      return;
    }
    destroyed = true;
    logger.debug(`[${name}] custom driver: destroy`);
    // 用户 handle 由 actions 层 release 负责释放；本 driver 无内部长生命周期资源需要清理
  }

  return { acquire, destroy };
}

export { createCustomLockDriver };
