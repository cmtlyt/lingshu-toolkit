/**
 * rtc-controller 模块的 logger adapter 薄包装
 *
 * 核心逻辑已抽离至 `@/shared/logger`，此文件仅负责绑定 rtc-controller 的 ERROR_FN_NAME，
 * 保持下游 import 路径不变
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
