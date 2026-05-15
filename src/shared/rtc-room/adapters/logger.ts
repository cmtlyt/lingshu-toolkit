/**
 * rtc-room 模块的 logger adapter 薄包装
 *
 * 核心逻辑已抽离至 `@/shared/logger`，此文件仅负责绑定 rtc-room 的 ERROR_FN_NAME
 */

import type { LoggerAdapter, ResolvedLoggerAdapter } from '@/shared/logger';
import {
  createDefaultLogger as createDefaultLoggerBase,
  resolveLoggerAdapter as resolveLoggerAdapterBase,
} from '@/shared/logger';
import { ERROR_FN_NAME } from '../constants';

function createDefaultLogger(): ResolvedLoggerAdapter {
  return createDefaultLoggerBase(ERROR_FN_NAME);
}

function resolveLoggerAdapter(userLogger?: LoggerAdapter): ResolvedLoggerAdapter {
  return resolveLoggerAdapterBase(ERROR_FN_NAME, userLogger);
}

export type { ResolvedLoggerAdapter } from '@/shared/logger';
export { createDefaultLogger, resolveLoggerAdapter };
