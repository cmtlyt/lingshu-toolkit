/**
 * StorageDriver 协议层：存储格式定义、常量、校验、nonce 生成
 *
 * ## 存储格式（对应 RFC.md「StorageDriver 协议」）
 * key：`${LOCK_PREFIX}:${id}:driver-lock`
 * value：JSON
 * ```
 * {
 *   "holder": { "token": string, "heartbeat": number, "nonce": string } | null,
 *   "queue": Array<{ "token": string, "ts": number }>,
 *   "rev": number
 * }
 * ```
 *
 * ## 关键字段
 * - `holder.nonce`：每次 holder 写入生成一次的随机值；CAS verify 时用 token + nonce
 *   双重匹配（ST-1 修复）。两个 Tab 并发写入时，后写者覆盖先写者；先写者读回验证发现
 *   token 相同但 nonce 不同 → 判定竞争失败，退避重试
 * - `queue`：本地 FIFO 等待队列的持久化视图；所有 Tab 共享，入队 / 出队均走 CAS 重试
 * - `rev`：每次写入递增，辅助调试丢更新问题；storage 事件可能在 rev 相同时也触发
 *
 * ## 时间常量
 * - HEARTBEAT_INTERVAL=500ms：下调自 1000ms，缩短 force 抢占被原持有者发现的最大延迟（ST-6）
 * - DEAD_THRESHOLD=2500ms：>= 4 个心跳周期，避免系统短时停顿误判崩溃
 * - POLL_INTERVAL=250ms：同 Tab 多实例场景下 storage 事件不触发，用 polling 兜底
 * - WRITE_RETRY_MAX=3：CAS / 入队 / 出队的最大重试次数（ST-5）
 * - WRITE_RETRY_JITTER_MAX=20ms：重试前随机退避 0~20ms，分散并发写者
 */

import { isArray, isNumber, isObject, isString } from '@/shared/utils/verify';

/** 心跳周期（ms）；持有者每此毫秒更新一次 holder.heartbeat */
const HEARTBEAT_INTERVAL = 500;
/** 崩溃阈值（ms）；`now - holder.heartbeat > 此值` 视为远端崩溃 */
const DEAD_THRESHOLD = 2500;
/** 同 Tab 多实例的 polling 兜底周期（storage 事件不跨同 Tab 触发） */
const POLL_INTERVAL = 250;
/** CAS / 入队 / 出队的最大重试次数 */
const WRITE_RETRY_MAX = 3;
/** 重试前随机退避的最大值（ms），0~此值之间取随机数 */
const WRITE_RETRY_JITTER_MAX = 20;

interface StorageHolder {
  readonly token: string;
  readonly heartbeat: number;
  /** 随机 nonce；CAS verify 时用 token + nonce 双重匹配 */
  readonly nonce: string;
}

interface StorageQueueEntry {
  readonly token: string;
  readonly ts: number;
}

interface StorageLockValue {
  readonly holder: StorageHolder | null;
  readonly queue: readonly StorageQueueEntry[];
  readonly rev: number;
}

const EMPTY_VALUE: StorageLockValue = { holder: null, queue: [], rev: 0 };

/**
 * 有限数字判定 —— 排除 NaN / Infinity / -Infinity
 *
 * `isPlainNumber` 已排除 NaN，但不排除 Infinity；存储/消息场景下 Infinity 无意义，
 * 组合 `Number.isFinite` 补齐
 */
function isFiniteNumber(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value);
}

function isStorageHolder(value: unknown): value is StorageHolder {
  if (!isObject(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return isString(obj.token) && isFiniteNumber(obj.heartbeat) && isString(obj.nonce);
}

function isStorageQueueEntry(value: unknown): value is StorageQueueEntry {
  if (!isObject(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return isString(obj.token) && isFiniteNumber(obj.ts);
}

function isStorageLockValue(value: unknown): value is StorageLockValue {
  if (!isObject(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!isFiniteNumber(obj.rev)) {
    return false;
  }
  if (!isArray(obj.queue)) {
    return false;
  }
  // queue 每项也要校验（storage 中数据可能被其他代码污染）
  for (let i = 0; i < obj.queue.length; i++) {
    if (!isStorageQueueEntry(obj.queue[i])) {
      return false;
    }
  }
  if (obj.holder !== null && !isStorageHolder(obj.holder)) {
    return false;
  }
  return true;
}

/**
 * 生成 holder 的随机 nonce
 *
 * 同 `broadcast-protocol.genId`：不依赖 crypto.randomUUID，保持广兼容
 */
function genNonce(): string {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 生成 waiter token（driver 内部排队用，与用户传入的 ctx.token 区分） */
function genWaiterId(): string {
  return `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 计算下一次重试的退避时长（0~WRITE_RETRY_JITTER_MAX ms 的随机数） */
function nextRetryJitter(): number {
  return Math.floor(Math.random() * WRITE_RETRY_JITTER_MAX);
}

/** 判定 holder 是否已崩溃（heartbeat 超过阈值未更新） */
function isHolderDead(holder: StorageHolder): boolean {
  return Date.now() - holder.heartbeat > DEAD_THRESHOLD;
}

export type { StorageHolder, StorageLockValue, StorageQueueEntry };
export {
  DEAD_THRESHOLD,
  EMPTY_VALUE,
  genNonce,
  genWaiterId,
  HEARTBEAT_INTERVAL,
  isHolderDead,
  isStorageLockValue,
  nextRetryJitter,
  POLL_INTERVAL,
  WRITE_RETRY_MAX,
};
