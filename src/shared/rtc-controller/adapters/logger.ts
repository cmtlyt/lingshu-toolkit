/**
 * 默认 LoggerAdapter 实现 + 用户 logger 兜底合并
 *
 * 对应 RFC.md「logger 适配器」章节
 *
 * 委托到 `@/shared/logger` 的全局 logger（console Proxy），
 * fnName 固定为 'rtcController'，保证错误消息前缀一致。
 *
 * 合并规则（字段级）：
 * - warn / error / debug 每个方法独立判定
 * - 用户 logger 的该方法是 function → 用用户版本（.bind 保证 this 正确）
 * - 否则 → 用默认 logger（走 shared/logger 通道，带统一前缀）
 */

import { logger as globalLogger } from '@/shared/logger';
import { ERROR_FN_NAME } from '../constants';
import type { LoggerAdapter } from '../types';

/** 三方法齐全的 logger 内部形态，由 resolveLoggerAdapter 产出 */
interface ResolvedLoggerAdapter extends LoggerAdapter {
  debug: NonNullable<LoggerAdapter['debug']>;
}

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
 * @param userLogger 用户传入的 logger（未传或为 undefined 等价于"全部走默认"）
 * @returns 三方法齐全的 logger；下游可直接调用 logger.debug(...) 无需 guard
 */
function resolveLoggerAdapter(userLogger?: LoggerAdapter): ResolvedLoggerAdapter {
  const fallback = createDefaultLogger();
  const user = (userLogger || {}) as Partial<LoggerAdapter>;
  return {
    warn: typeof user.warn === 'function' ? user.warn.bind(user) : fallback.warn,
    error: typeof user.error === 'function' ? user.error.bind(user) : fallback.error,
    debug: typeof user.debug === 'function' ? user.debug.bind(user) : fallback.debug,
  };
}

export type { ResolvedLoggerAdapter };
export { createDefaultLogger, resolveLoggerAdapter };
