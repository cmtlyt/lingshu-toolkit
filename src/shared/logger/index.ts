type Logger = {
  [K in keyof Omit<Console, 'table'> as Console[K] extends (...args: any[]) => any ? K : never]: Console[K] extends (
    ...args: [any, ...infer AS]
  ) => infer R
    ? (fnName: string, ...args: AS) => R
    : never;
};

declare global {
  var $$lingshu$$: Partial<{
    disableLogger: boolean;
  }>;
}

export const logger = new Proxy(console, {
  get(target, prop, receiver) {
    if ((globalThis.$$lingshu$$ || {}).disableLogger) {
      return () => void 0;
    }
    const oldLog = Reflect.get(target, prop, receiver).bind(console);
    return (fnName: string, ...args: any) => {
      oldLog(`[@cmtlyt/lingshu-toolkit#${fnName}]:`, ...args);
    };
  },
}) as unknown as Logger;

// ── Logger Adapter ──────────────────────────────────────────

/** 用户可传入的 logger：warn / error 必选，debug 可选 */
export interface LoggerAdapter {
  warn: (message: string, ...extras: unknown[]) => void;
  error: (message: string, ...extras: unknown[]) => void;
  debug?: (message: string, ...extras: unknown[]) => void;
}

/** 三方法齐全的 logger 内部形态，由 resolveLoggerAdapter 产出 */
export interface ResolvedLoggerAdapter extends LoggerAdapter {
  debug: NonNullable<LoggerAdapter['debug']>;
}

/**
 * 创建默认的 LoggerAdapter（三方法齐全）
 *
 * 委托到全局 logger，统一加 `[@cmtlyt/lingshu-toolkit#fnName]` 前缀
 */
export function createDefaultLogger(fnName: string): ResolvedLoggerAdapter {
  return {
    warn(message: string, ...extras: unknown[]): void {
      logger.warn(fnName, message, ...extras);
    },
    error(message: string, ...extras: unknown[]): void {
      logger.error(fnName, message, ...extras);
    },
    debug(message: string, ...extras: unknown[]): void {
      logger.debug(fnName, message, ...extras);
    },
  };
}

/**
 * 把"用户 logger（可能部分缺失）"与"默认 logger"混合为"三方法齐全"的 logger
 *
 * 合并规则（字段级）：
 * - warn / error / debug 每个方法独立判定
 * - 用户 logger 的该方法是 function → 用用户版本（.bind 保证 this 正确）
 * - 否则 → 用默认 logger（走 shared/logger 通道，带统一前缀）
 */
export function resolveLoggerAdapter(fnName: string, userLogger?: LoggerAdapter): ResolvedLoggerAdapter {
  const fallback = createDefaultLogger(fnName);
  const user = (userLogger || {}) as Partial<LoggerAdapter>;
  return {
    warn: typeof user.warn === 'function' ? user.warn.bind(user) : fallback.warn,
    error: typeof user.error === 'function' ? user.error.bind(user) : fallback.error,
    debug: typeof user.debug === 'function' ? user.debug.bind(user) : fallback.debug,
  };
}
