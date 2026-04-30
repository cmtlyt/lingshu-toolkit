/**
 * 会话纪元（epoch）探测与解析
 *
 * 对应 RFC.md「会话级持久化与 epoch 探测」「resolveEpoch 协议」章节。
 *
 * epoch 的核心作用：解决 "localStorage 天然持久化 vs 用户期望的会话级协作" 语义冲突。
 *   - `persistence === 'persistent'`：常量 `'persistent'`，跨会话共享同一权威副本
 *   - `persistence === 'session'`：每个会话组（同源活跃 Tab 的最大存活期）独立 epoch；
 *     权威副本中 epoch 字段与本地 epoch 不一致时直接丢弃，等价"所有 Tab 关闭即重置"
 *
 * resolveEpoch 六分支协议（RFC L1262）：
 *
 *   | 分支 | 判定 | epoch 来源 | clearAuthority |
 *   | ---- | ---- | ---------- | -------------- |
 *   | A    | persistence === 'persistent' | 常量 'persistent' | 否 |
 *   | B    | session + !sessionStore      | 降级为 'persistent' | 否 (logger.warn) |
 *   | C    | sessionStore.read() 有值     | 直接继承（刷新/bfcache） | 否 |
 *   | D    | 首次 + !channel              | 生成新 UUID | 是 (logger.warn) |
 *   | E    | 首次 + 收到 session-reply     | 继承响应方 epoch | 否 |
 *   | F    | 首次 + 探测超时              | 生成新 UUID | 是 |
 *
 * 响应方（E 分支的对侧）：所有 storage-authority + session 的 Tab 在 channel 可用时
 * 常驻订阅 session-probe，若自己已有 epoch 则广播 session-reply；由 StorageAuthority
 * 生命周期管理订阅解绑（refCount === 0 时解绑）
 */

import { isObject, isString } from '@/shared/utils/verify';
import { withResolvers } from '@/shared/with-resolvers';
import { DEFAULT_SESSION_PROBE_TIMEOUT, PERSISTENT_EPOCH } from '../constants';
import type { ChannelAdapter, LoggerAdapter, Persistence, SessionStoreAdapter } from '../types';

/**
 * session-probe 消息：首次启动的 Tab 广播此消息询问 "当前是否有同会话组的 Tab"
 *
 * `probeId` 防止串扰：同一进程中可能同时有多个 id 的 StorageAuthority 发起 probe，
 * 响应方必须带上原 probeId，发起方用 probeId 过滤避免串扰
 */
interface SessionProbeMessage {
  readonly type: 'session-probe';
  readonly probeId: string;
}

/**
 * session-reply 消息：响应方在收到 probe 时广播自己的 epoch
 */
interface SessionReplyMessage {
  readonly type: 'session-reply';
  readonly probeId: string;
  readonly epoch: string;
}

/**
 * resolveEpoch 的输入上下文
 *
 * 刻意解耦于具体 Entry：Phase 5 的 registry 负责组装此 ctx 后调用 resolveEpoch
 */
interface ResolveEpochContext {
  readonly persistence: Persistence;
  /** sessionStorage adapter；null 表示能力不可用 */
  readonly sessionStore: SessionStoreAdapter | null;
  /** BroadcastChannel adapter；null 表示能力不可用 */
  readonly channel: ChannelAdapter | null;
  /** 权威副本 adapter；D/F 分支需要 `remove()` 清空残留；null 表示能力不可用 */
  readonly authority: { remove: () => void } | null;
  /** 探测窗口（ms）；未传用 `DEFAULT_SESSION_PROBE_TIMEOUT`（100ms） */
  readonly sessionProbeTimeout?: number;
  readonly logger: LoggerAdapter;
}

/**
 * resolveEpoch 的产物
 *
 * - `epoch`：最终决定的 epoch（常量 `'persistent'` 或 UUID）
 * - `effectivePersistence`：若 B 分支降级，此字段为 `'persistent'`；否则与输入一致
 * - `authorityCleared`：D/F 分支清空了权威副本（true 表示后续 initAuthority 不必再 pull）
 */
interface ResolveEpochResult {
  readonly epoch: string;
  readonly effectivePersistence: Persistence;
  readonly authorityCleared: boolean;
}

/**
 * 生成新 epoch
 *
 * 优先级：`crypto.randomUUID()` → `Math.random().toString(36) + Date.now()` fallback
 *
 * 不使用 `isObject(crypto)` + `isFunction(crypto.randomUUID)` 的完整守卫，
 * 而是 try-catch：`crypto` 变量在部分 SSR 环境是未定义的（读取即 ReferenceError），
 * 跟 navigator 一样必须用 typeof 守卫访问；try-catch 更简洁且能覆盖任何异常路径
 */
function generateUuid(): string {
  try {
    // globalThis.crypto 在主流环境均存在；try-catch 兜底任何异常访问
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      return cryptoObj.randomUUID();
    }
  } catch {
    // ReferenceError / SecurityError / 其他异常都走 fallback
  }
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * 构造 session-probe 消息 —— 集中写入保证消息形状一致
 */
function buildProbeMessage(probeId: string): SessionProbeMessage {
  return { type: 'session-probe', probeId };
}

/**
 * 构造 session-reply 消息
 */
function buildReplyMessage(probeId: string, epoch: string): SessionReplyMessage {
  return { type: 'session-reply', probeId, epoch };
}

/**
 * 判断消息是否为合法 session-probe
 *
 * 走 verify.ts 语义函数，对齐 `<code_style>` 类型判断规范
 */
function isSessionProbeMessage(message: unknown): message is SessionProbeMessage {
  if (!isObject(message)) {
    return false;
  }
  const obj = message as { type?: unknown; probeId?: unknown };
  return obj.type === 'session-probe' && isString(obj.probeId);
}

/**
 * 判断消息是否为合法 session-reply
 */
function isSessionReplyMessage(message: unknown): message is SessionReplyMessage {
  if (!isObject(message)) {
    return false;
  }
  const obj = message as { type?: unknown; probeId?: unknown; epoch?: unknown };
  return obj.type === 'session-reply' && isString(obj.probeId) && isString(obj.epoch);
}

/**
 * resolveEpoch：按六分支协议决定本 Tab 的 epoch
 *
 * 返回 `Promise<ResolveEpochResult>`，因为 E/F 分支需要异步等待 session-reply 或超时
 */
async function resolveEpoch(ctx: ResolveEpochContext): Promise<ResolveEpochResult> {
  // A 分支：persistent 策略，固定常量，不做任何探测
  if (ctx.persistence === 'persistent') {
    return { epoch: PERSISTENT_EPOCH, effectivePersistence: 'persistent', authorityCleared: false };
  }

  // B 分支：session 策略但 sessionStore 不可用，降级为 persistent
  if (!ctx.sessionStore) {
    ctx.logger.warn('[lockData] sessionStore adapter unavailable, persistence="session" falls back to "persistent"');
    return { epoch: PERSISTENT_EPOCH, effectivePersistence: 'persistent', authorityCleared: false };
  }

  // C 分支：sessionStorage 已有 epoch（刷新 / bfcache 恢复），直接继承
  const stored = ctx.sessionStore.read();
  if (isString(stored) && stored.length > 0) {
    return { epoch: stored, effectivePersistence: 'session', authorityCleared: false };
  }

  // 首次启动分支：需要判断 channel 是否可用
  // D 分支：channel 不可用，无法探测同会话组 Tab，直接按"首个 Tab"处理
  if (!ctx.channel) {
    ctx.logger.warn('[lockData] channel adapter unavailable, skip session-probe and treat as first tab');
    return freshEpoch(ctx);
  }

  // E/F 分支：广播 session-probe，等待 session-reply 或超时
  const resolvedEpoch = await probeForExistingSession(ctx);
  if (isString(resolvedEpoch)) {
    // E 分支：收到 reply，继承响应方 epoch，并写入 sessionStore 供本 Tab 后续刷新继承
    ctx.sessionStore.write(resolvedEpoch);
    return { epoch: resolvedEpoch, effectivePersistence: 'session', authorityCleared: false };
  }

  // F 分支：探测超时，按"首个 Tab"处理（生成新 UUID + 主动清空权威副本残留）
  return freshEpoch(ctx);
}

/**
 * 广播 session-probe 并等待 session-reply
 *
 * @returns 首个收到的 reply.epoch；超时返回 null
 */
function probeForExistingSession(ctx: ResolveEpochContext): Promise<string | null> {
  // 前置检查：resolveEpoch 在调用此函数前已保证 channel 非 null，这里纯防御（逻辑上不会触发）
  const { channel } = ctx;
  if (!channel) {
    return Promise.resolve(null);
  }

  const probeId = generateUuid();
  const timeout = ctx.sessionProbeTimeout || DEFAULT_SESSION_PROBE_TIMEOUT;
  const settle = withResolvers<string | null>();

  let settled = false;
  const unsubscribe = channel.subscribe((message) => {
    if (settled) {
      return;
    }
    if (!isSessionReplyMessage(message)) {
      return;
    }
    // probeId 过滤：同进程可能有多个 id 的 probe 共享 channel（不同 name），
    // 但同 name 的 channel 也可能被他人复用，probeId 是最可靠的来源标识
    if (message.probeId !== probeId) {
      return;
    }
    settled = true;
    settle.resolve(message.epoch);
  });

  const timeoutId = setTimeout(() => {
    if (settled) {
      return;
    }
    settled = true;
    settle.resolve(null);
  }, timeout);

  // 先订阅再广播：避免本消息被某些实现回环投递到自己却已错过订阅（原生 BroadcastChannel
  // 不回环，但自定义 adapter 可能有此行为，防御性编码更稳）
  channel.postMessage(buildProbeMessage(probeId));

  return settle.promise.finally(() => {
    clearTimeout(timeoutId);
    unsubscribe();
  });
}

/**
 * 生成新 epoch（D / F 分支共用）
 *
 * 副作用：
 *   - 写入 sessionStore（供本 Tab 后续刷新继承）
 *   - 调用 authority.remove()（主动清空上一会话组残留，避免 epoch 不一致的旧数据继续占用配额）
 */
function freshEpoch(ctx: ResolveEpochContext): ResolveEpochResult {
  const epoch = generateUuid();
  // sessionStore 必然存在（B 分支已前置拦截），这里不用再判空
  if (ctx.sessionStore) {
    ctx.sessionStore.write(epoch);
  }
  // 主动清空权威副本残留；authority 不可用时跳过（同时 syncMode 为 none 时 Entry.authority 也是 null）
  let authorityCleared = false;
  if (ctx.authority) {
    try {
      ctx.authority.remove();
      authorityCleared = true;
    } catch (error) {
      ctx.logger.warn('[lockData] authority.remove failed during freshEpoch', error);
    }
  }
  return { epoch, effectivePersistence: 'session', authorityCleared };
}

/**
 * 订阅 session-probe 消息并自动回复 session-reply
 *
 * 由 Phase 4.4 `initAuthority` 在 session 策略下调用；订阅常驻直到 Entry 销毁。
 *
 * @param channel 本 Tab 的 session 通道
 * @param getMyEpoch 返回当前 Tab 的 epoch（null 表示尚未 resolved，此时不回复）
 * @returns 解绑函数；refCount === 0 时由 initAuthority 调用
 */
function subscribeSessionProbe(channel: ChannelAdapter, getMyEpoch: () => string | null): () => void {
  const unsubscribe = channel.subscribe((message) => {
    if (!isSessionProbeMessage(message)) {
      return;
    }
    const myEpoch = getMyEpoch();
    // 尚未 resolved 的 Tab 不应该回复（回复 null 会污染对方的 E 分支判定）；
    // 另外 persistent 策略 Tab 也不应响应 session 策略的探测（但 persistent 策略不会
    // 订阅 session channel，此分支逻辑上不会触发）
    if (!isString(myEpoch) || myEpoch.length === 0) {
      return;
    }
    channel.postMessage(buildReplyMessage(message.probeId, myEpoch));
  });
  return unsubscribe;
}

export type { ResolveEpochContext, ResolveEpochResult, SessionProbeMessage, SessionReplyMessage };
export {
  buildProbeMessage,
  buildReplyMessage,
  generateUuid,
  isSessionProbeMessage,
  isSessionReplyMessage,
  resolveEpoch,
  subscribeSessionProbe,
};
