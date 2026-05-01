/**
 * drivers 层入口：能力检测 + 驱动选择 + barrel export
 *
 * 对应 RFC.md「能力检测与降级」：pickDriver 按以下优先级决策（首次创建 Entry 时调用一次）：
 *
 * 1. `adapters.getLock` 存在 → CustomDriver（最高优先级，覆盖 `mode`）
 * 2. `id` 未提供（纯本地只读锁）→ LocalLockDriver
 * 3. `mode` 显式指定（非 `'auto'`）→ 强制使用对应 driver；能力不可用时抛错
 * 4. `mode === 'auto'` 的降级链：web-locks → broadcast → storage；全不可用时抛错
 *
 * 能力探测：
 * - navigator.locks：Web Locks API，Safari >= 15.4 / Chromium 稳定支持
 * - BroadcastChannel：同源 Tab 间广播通道
 * - localStorage：最通用的同步存储，探测需做"实际读写一次"防隐私模式误判
 *
 * 本文件**不持久化探测结果**：pickDriver 的入参已决定单次构造的 driver；同 id 二次
 * 构造直接复用 registry 中的 driver 实例，不会走 pickDriver，所以无需缓存
 */

import { throwError } from '@/shared/throw-error';
import { isFunction, isObject, isString } from '@/shared/utils/verify';
import type { ResolvedAdapters } from '../adapters/index';
import { ERROR_FN_NAME, LOCK_PREFIX } from '../constants';
import type { LockDataOptions } from '../types';
import { createBroadcastDriver } from './broadcast';
import { createCustomLockDriver } from './custom';
import { createLocalLockDriver } from './local';
import { createStorageDriver } from './storage';
import type { LockDriver, LockDriverDeps } from './types';
import { createWebLocksDriver } from './web-locks';

/**
 * pickDriver 的参数容器
 *
 * 把"需要给 driver 的能力"从 `ResolvedAdapters` 中抽出单独字段，避免 driver 层依赖
 * adapters 层的完整类型（drivers 与 adapters 是平级关系，不应循环依赖）
 */
interface PickDriverArgs<T> {
  /** 已解析的 adapters（pickDefaultAdapters 产出） */
  readonly adapters: ResolvedAdapters<T>;
  /** lockData 原始 options —— 只读取 `mode` */
  readonly options: Pick<LockDataOptions<T>, 'mode'>;
  /** lockData 原始 id；未提供代表纯本地只读锁 */
  readonly id: string | undefined;
}

// -----------------------------------------------------------------------------
// 能力探测
// -----------------------------------------------------------------------------

/** navigator.locks 可用（Web Locks API） */
function hasNavigatorLocks(): boolean {
  const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  if (!isObject(nav)) {
    return false;
  }
  const { locks } = nav as { locks?: unknown };
  if (!isObject(locks)) {
    return false;
  }
  return isFunction((locks as { request?: unknown }).request);
}

/** BroadcastChannel 可实例化（探测构造不抛错） */
function hasBroadcastChannel(): boolean {
  // 保留原生 `typeof BroadcastChannel` —— 这是 TS 类型操作符（获取构造函数类型），非运行时 typeof
  const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!isFunction(Ctor)) {
    return false;
  }
  try {
    const probe = new Ctor(`${LOCK_PREFIX}:__pick_driver_probe__`);
    probe.close();
    return true;
  } catch {
    return false;
  }
}

/** localStorage 可实际读写（隐私模式 / quota 满时返回 false） */
function hasUsableLocalStorage(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) {
      return false;
    }
    const probeKey = `${LOCK_PREFIX}:__pick_driver_probe__`;
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// driver 构造辅助
// -----------------------------------------------------------------------------

/**
 * 为 driver 构造通用 deps
 *
 * - `name` 按 `${LOCK_PREFIX}:${id}` 规范拼接；无 id 时用 `__local__` 占位（LocalLockDriver
 *   不关心 name 跨 Tab 语义，仅用于日志）
 * - `logger` 从已解析 adapters 取
 * - `getChannel` / `userGetLock` 按 driver 需要选择性注入（避免 driver 层无谓依赖）
 */
function buildDriverDeps<T>(
  args: PickDriverArgs<T>,
  includeChannel: boolean,
  includeUserGetLock: boolean,
): LockDriverDeps {
  const { adapters, id } = args;
  const name = isString(id) && id.length > 0 ? `${LOCK_PREFIX}:${id}` : `${LOCK_PREFIX}:__local__`;
  return {
    name,
    id,
    logger: adapters.logger,
    getChannel: includeChannel ? adapters.getChannel : undefined,
    userGetLock: includeUserGetLock ? adapters.getLock : undefined,
  };
}

// -----------------------------------------------------------------------------
// 显式 mode 分支：强制使用对应 driver；能力不可用时抛错（不降级）
// -----------------------------------------------------------------------------

function createWebLocksOrThrow<T>(args: PickDriverArgs<T>): LockDriver {
  if (!hasNavigatorLocks()) {
    throwError(
      ERROR_FN_NAME,
      "mode='web-locks' requested but navigator.locks is unavailable in current environment",
      TypeError,
    );
  }
  return createWebLocksDriver(buildDriverDeps(args, false, false));
}

function createBroadcastOrThrow<T>(args: PickDriverArgs<T>): LockDriver {
  if (!hasBroadcastChannel()) {
    throwError(
      ERROR_FN_NAME,
      "mode='broadcast' requested but BroadcastChannel is unavailable in current environment",
      TypeError,
    );
  }
  return createBroadcastDriver(buildDriverDeps(args, true, false));
}

function createStorageOrThrow<T>(args: PickDriverArgs<T>): LockDriver {
  if (!hasUsableLocalStorage()) {
    throwError(
      ERROR_FN_NAME,
      "mode='storage' requested but localStorage is unavailable in current environment",
      TypeError,
    );
  }
  return createStorageDriver(buildDriverDeps(args, false, false));
}

// -----------------------------------------------------------------------------
// auto 模式降级链
// -----------------------------------------------------------------------------

/**
 * auto 模式的降级链：web-locks → broadcast → storage
 *
 * 三个能力全不可用时抛错 —— 上游调用方可选择降级到 local（但 auto 的语义是"跨 Tab 优先"，
 * 降级到 local 会破坏 force / 跨 Tab 互斥契约，所以 auto 必须有能力才能走 —— 抛错让
 * 使用者显式切换 mode='local' 或注入 adapters.getLock）
 *
 * **注意**：本分支只在 `id` 存在时进入；无 id 场景由 `pickDriver` 上层直接走 LocalLockDriver
 */
function createAutoDriver<T>(args: PickDriverArgs<T>): LockDriver {
  if (hasNavigatorLocks()) {
    return createWebLocksDriver(buildDriverDeps(args, false, false));
  }
  if (hasBroadcastChannel()) {
    return createBroadcastDriver(buildDriverDeps(args, true, false));
  }
  if (hasUsableLocalStorage()) {
    return createStorageDriver(buildDriverDeps(args, false, false));
  }
  throwError(
    ERROR_FN_NAME,
    "mode='auto' requires one of navigator.locks / BroadcastChannel / localStorage to be available; got none",
    TypeError,
  );
}

// -----------------------------------------------------------------------------
// pickDriver 主入口
// -----------------------------------------------------------------------------

/**
 * 根据能力 / mode / id 选择并构造 LockDriver
 *
 * 优先级（RFC.md:689-696）：
 * 1. `adapters.getLock` 存在 → CustomDriver（最高优先级，覆盖 mode）
 * 2. `id` 未提供 → LocalLockDriver
 * 3. 显式 `mode` → 强制使用，不降级（能力不可用抛错）
 * 4. `mode === 'auto'`（默认）→ web-locks → broadcast → storage
 */
function pickDriver<T>(args: PickDriverArgs<T>): LockDriver {
  const { adapters, options, id } = args;

  // 1. 用户自定义 driver 覆盖一切
  if (isFunction(adapters.getLock)) {
    return createCustomLockDriver(buildDriverDeps(args, false, true));
  }

  // 2. 无 id → 纯本地只读锁
  if (!isString(id) || id.length === 0) {
    return createLocalLockDriver(buildDriverDeps(args, false, false));
  }

  // 3 / 4. 按 mode 分派（undefined 视为 'auto'）
  const mode = options.mode || 'auto';
  switch (mode) {
    case 'web-locks':
      return createWebLocksOrThrow(args);
    case 'broadcast':
      return createBroadcastOrThrow(args);
    case 'storage':
      return createStorageOrThrow(args);
    case 'auto':
      return createAutoDriver(args);
    default: {
      // TypeScript 穷尽性检查；运行时兜底 —— 非法 mode 值抛错（参数校验层应该已拦截）
      const _exhaustive: never = mode;
      throwError(ERROR_FN_NAME, `unknown mode: ${String(_exhaustive)}`, TypeError);
    }
  }
}

// -----------------------------------------------------------------------------
// barrel export
// -----------------------------------------------------------------------------

export { createBroadcastDriver } from './broadcast';
export { createCustomLockDriver } from './custom';
export { createLocalLockDriver } from './local';
export { createStorageDriver } from './storage';
export type { LockDriver, LockDriverDeps } from './types';
export { createWebLocksDriver } from './web-locks';
export type { PickDriverArgs };
export { hasBroadcastChannel, hasNavigatorLocks, hasUsableLocalStorage, pickDriver };
