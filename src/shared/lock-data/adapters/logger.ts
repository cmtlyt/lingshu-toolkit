/**
 * 默认 LoggerAdapter 实现 + 用户 logger 兜底合并
 *
 * 委托到 `@/shared/logger` 的全局 logger（console Proxy），
 * 负责把 `LoggerAdapter` 契约的 `(message, ...extras)` 形态
 * 适配为 `shared/logger` 的 `(fnName, ...args)` 形态。
 *
 * - fnName 固定为 `ERROR_FN_NAME`（`lockData`），保证错误消息前缀一致
 * - `globalThis.$lingshu$.disableLogger` 可全局关闭日志输出，无需在此额外处理
 *
 * 对应 RFC.md「默认实现」：默认 LoggerAdapter 委托到 shared/logger
 *
 * **logger 混合兜底契约（Phase 2 决策）**：
 * `LoggerAdapter` 的 `warn` / `error` 为必选、`debug` 为可选。为避免下游链路
 * 在调用 `logger.debug` 时需要反复 guard、且保证"用户覆盖 + 默认补全"的
 * 无缝混合，`resolveLoggerAdapter` 对用户 logger 做缺失方法补全：
 *   - 用户 logger 存在且已实现的方法 → 原样使用（保持用户日志目的地）
 *   - 用户 logger 未实现的方法 → 走默认 logger（仍带 `[lockData]` 前缀）
 * 输出永远是"三方法齐全"的 logger，`debug` 在下游可直接调用无需 optional chain
 */

import { logger as globalLogger } from '@/shared/logger';
import { ERROR_FN_NAME } from '../constants';
import type { LoggerAdapter } from '../types';

/**
 * 必选方法齐全的 logger 内部形态
 *
 * 与 `LoggerAdapter` 的差异：`debug` 由可选变为必选，`resolveLoggerAdapter`
 * 的产物一律满足此形态，供下游（clone / authority / channel / ...）直接调用
 */
interface ResolvedLoggerAdapter extends LoggerAdapter {
  debug: NonNullable<LoggerAdapter['debug']>;
}

/**
 * 创建默认的 LoggerAdapter（三方法齐全）
 *
 * 设计要点：
 * 1. 始终返回一个可用实例，不需要能力探测（console 在所有运行环境存在）
 * 2. `warn` / `error` / `debug` 均委托到全局 logger，统一加 `[@cmtlyt/lingshu-toolkit#lockData]` 前缀
 */
function createDefaultLogger(): ResolvedLoggerAdapter {
  return {
    warn(message: string, ...extras: unknown[]): void {
      globalLogger.warn(ERROR_FN_NAME, message, ...extras);
    },
    error(message: string, ...extras: unknown[]): void {
      globalLogger.error(ERROR_FN_NAME, message, ...extras);
    },
    debug(message: string, ...extras: unknown[]): void {
      globalLogger.debug(ERROR_FN_NAME, message, ...extras);
    },
  };
}

/**
 * 把"用户 logger（可能部分缺失）"与"默认 logger"混合为"三方法齐全"的 logger
 *
 * 合并规则（字段级）：
 * - `warn` / `error` / `debug` 每个方法独立判定：
 *   - 用户 logger 的该方法是 `function` → 用用户版本（保持日志目的地）
 *   - 否则 → 用默认 logger 的该方法（走 shared/logger 通道，带统一前缀）
 *
 * 为什么不直接 `{ ...defaultLogger, ...userLogger }`：
 * - 用户可能显式传 `debug: undefined`（例：从对象里 pick 字段），这会把默认
 *   的 `debug` 覆盖为 `undefined`；严格按方法类型判定才能避免此类陷阱
 *
 * @param userLogger 用户传入的 logger（未传或为 undefined 等价于"全部走默认"）
 * @returns 三方法齐全的 logger；下游可直接调用 `logger.debug(...)` 无需 guard
 */
function resolveLoggerAdapter(userLogger?: LoggerAdapter): ResolvedLoggerAdapter {
  const fallback = createDefaultLogger();
  // 参数兜底用 || —— logger 只可能是 undefined / 对象，不存在有意义的 falsy 变体
  // 显式 Partial 化：用户可能只实现了 warn / error，未实现 debug；字段访问需要
  // 在类型层允许缺省，底层运行时再用 typeof 判定函数性
  const user = (userLogger || {}) as Partial<LoggerAdapter>;
  return {
    warn: typeof user.warn === 'function' ? user.warn.bind(user) : fallback.warn,
    error: typeof user.error === 'function' ? user.error.bind(user) : fallback.error,
    debug: typeof user.debug === 'function' ? user.debug.bind(user) : fallback.debug,
  };
}

export type { ResolvedLoggerAdapter };
export { createDefaultLogger, resolveLoggerAdapter };
