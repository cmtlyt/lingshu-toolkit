/**
 * BroadcastDriver 协议层：消息类型定义、常量、校验
 *
 * 消息类型（所有消息都带 `senderId`，接收方据此判定是否来自自己 —— BroadcastChannel 不
 * 回环，但用户可能替换为自定义 ChannelAdapter，因此本 driver 不依赖"不回环"假设）：
 *   - `announce`：抢锁请求广播（requestId + token + ts + force）
 *   - `reject`：持有者对 announce 的拒绝响应（带 holderToken + holderTs）
 *   - `release`：持有者主动释放
 *   - `force`：强制抢占通知（带 ts 仲裁字段）
 *   - `heartbeat`：持有者周期心跳
 *
 * 仲裁规则：`isEarlier(tsA, idA, tsB, idB)`；时间戳小者优先，时间戳相等时字典序小者优先；
 * 两端独立执行相同仲裁得出一致结果（基于消息内容是全局确定的：(ts, id) 一旦发出就不变）
 */

import { isBoolean, isNumber, isObject, isString } from '@/shared/utils/verify';

/** announce 的拒绝等待窗口（ms）；窗口内无 reject / 无更早的他方 announce → 拿锁 */
const REJECT_WINDOW = 50;
/** force 抢占的仲裁等待窗口（ms）；给对端时间响应 force 并可能反向广播 force 仲裁 */
const FORCE_ARBITRATION_WINDOW = 50;
/** 心跳周期（ms） */
const HEARTBEAT_INTERVAL = 1000;
/** 崩溃阈值（ms）；连续此毫秒未收到 heartbeat → 视为远端崩溃回 idle */
const DEAD_THRESHOLD = 3000;

interface AnnounceMessage {
  readonly kind: 'announce';
  readonly senderId: string;
  readonly requestId: string;
  readonly token: string;
  readonly ts: number;
  readonly force: boolean;
}

interface RejectMessage {
  readonly kind: 'reject';
  readonly senderId: string;
  readonly requestId: string;
  readonly holderToken: string;
  readonly holderTs: number;
}

interface ReleaseMessage {
  readonly kind: 'release';
  readonly senderId: string;
  readonly token: string;
}

interface ForceMessage {
  readonly kind: 'force';
  readonly senderId: string;
  readonly token: string;
  readonly ts: number;
}

interface HeartbeatMessage {
  readonly kind: 'heartbeat';
  readonly senderId: string;
  readonly token: string;
  readonly ts: number;
}

type BroadcastMessage = AnnounceMessage | RejectMessage | ReleaseMessage | ForceMessage | HeartbeatMessage;

/**
 * 有限数字判定 —— 排除 NaN / Infinity / -Infinity
 *
 * `isPlainNumber` 已排除 NaN，但不排除 Infinity；消息 ts 场景下 Infinity 无意义，
 * 组合 `Number.isFinite` 补齐
 */
function isFiniteNumber(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value);
}

/**
 * 严格校验每个 kind 的必需字段（BC-6 修复）
 *
 * 运行时消息可能来自任意源（错位的 channel / 用户误用 / 注入），必须 shape 校验后再 narrow
 */
function isBroadcastMessage(value: unknown): value is BroadcastMessage {
  if (!isObject(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!isString(obj.senderId)) {
    return false;
  }
  switch (obj.kind) {
    case 'announce':
      return isString(obj.requestId) && isString(obj.token) && isFiniteNumber(obj.ts) && isBoolean(obj.force);
    case 'reject':
      return isString(obj.requestId) && isString(obj.holderToken) && isFiniteNumber(obj.holderTs);
    case 'release':
      return isString(obj.token);
    case 'force':
      return isString(obj.token) && isFiniteNumber(obj.ts);
    case 'heartbeat':
      return isString(obj.token) && isFiniteNumber(obj.ts);
    default:
      return false;
  }
}

/** 生成请求 / sender 的唯一 id；不使用 `crypto.randomUUID()` 以保持广兼容 */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 仲裁：`(tsA, idA)` 是否严格先于 `(tsB, idB)`
 *
 * 时间戳小者优先；时间戳相等时字符串字典序小者优先。两端独立执行一致
 */
function isEarlier(tsA: number, idA: string, tsB: number, idB: string): boolean {
  if (tsA !== tsB) {
    return tsA < tsB;
  }
  return idA < idB;
}

export type { AnnounceMessage, BroadcastMessage, ForceMessage, HeartbeatMessage, RejectMessage, ReleaseMessage };
export {
  DEAD_THRESHOLD,
  FORCE_ARBITRATION_WINDOW,
  genId,
  HEARTBEAT_INTERVAL,
  isBroadcastMessage,
  isEarlier,
  REJECT_WINDOW,
};
