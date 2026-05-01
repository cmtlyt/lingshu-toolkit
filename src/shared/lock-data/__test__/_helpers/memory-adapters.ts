/**
 * 测试专用：全内存的 Authority / Channel / SessionStore 适配器工厂
 *
 * 设计目的：
 * - 在 Node 环境下模拟"多 Tab 共享浏览器存储 + BroadcastChannel"的完整链路
 * - 7.2 集成测试（`__test__/integration/memory-adapters.node.test.ts`）复用此工厂验证 lockData 全链路
 * - 7.3 合规性测试套件（`__test__/adapters/memory-integration.node.test.ts`）复用此工厂作为"参考实现"
 *
 * 共享语义对齐（与默认 localStorage / BroadcastChannel / sessionStorage 实现完全一致）：
 * - `storage`：跨 Tab 共享的 key-value 存储（模拟 localStorage）
 * - `bus`：跨 Tab 共享的消息总线（模拟 BroadcastChannel，按 channel name 分桶）
 * - `sessionScope`：每个 Tab 独立的 session 存储（模拟 sessionStorage，不跨 Tab）
 *
 * 关键契约对齐（对齐 `src/shared/lock-data/adapters/*.ts` 的真实实现）：
 * - `AuthorityAdapter.subscribe`：仅响应"跨 Tab"的 write 通知；本 Tab 自己 write 不触发自己的 subscribe 回调
 *   （对齐原生 storage 事件：发起 write 的那个 document 不会收到自己的 storage 事件）
 * - `ChannelAdapter.postMessage`：发送方不会收到自己 postMessage 的消息
 *   （对齐原生 BroadcastChannel 规范）
 * - 订阅回调异常走 `logger.error` 隔离，不会传播到发送方，也不会污染其他订阅者
 *
 * 参考：RFC.md「适配器合规测试套件」章节
 */

import type {
  AuthorityAdapter,
  AuthorityAdapterContext,
  ChannelAdapter,
  ChannelAdapterContext,
  LoggerAdapter,
  SessionStoreAdapter,
  SessionStoreAdapterContext,
} from '../../types';

// ---------------------------------------------------------------------------
// 共享环境
// ---------------------------------------------------------------------------

/**
 * storage 订阅者记录：每个订阅者同时携带其所属 Tab 标识 + 订阅者自己的 logger，
 * 用于：
 * 1. 模拟「本 Tab write 不触发本 Tab subscribe 回调」的原生 storage 事件语义
 * 2. 订阅者回调异常时用**订阅者自己**注入的 logger.error 记录（异常属于订阅者代码的责任）
 */
interface StorageSubscriber {
  readonly tabId: symbol;
  readonly logger: LoggerAdapter | undefined;
  readonly onExternalUpdate: (newValue: string | null) => void;
}

/**
 * 跨 Tab 共享的"浏览器环境"：authority storage + channel bus
 *
 * 注意：每个 Tab 的 sessionScope 独立（sessionStorage 语义），故由 `createMemoryAdapters`
 * 内部维护，不在 env 里共享
 */
interface SharedMemoryEnv {
  /** 跨 Tab 共享的 key-value 存储（模拟 localStorage） */
  readonly storage: Map<string, string>;
  /** 跨 Tab 共享的消息总线；key 为 channel name，value 为该 channel 上所有订阅者 */
  readonly bus: Map<string, Set<ChannelSubscriber>>;
  /** storage 订阅者按 key 分桶（AuthorityAdapter.subscribe 语义：仅订阅指定 key） */
  readonly storageSubscribers: Map<string, Set<StorageSubscriber>>;
}

/**
 * channel 订阅者记录：同样携带 Tab 标识用于模拟「postMessage 发送方不收自己消息」，
 * 并携带订阅者自己的 logger 以便异常日志归属正确
 */
interface ChannelSubscriber {
  readonly tabId: symbol;
  readonly logger: LoggerAdapter | undefined;
  readonly onMessage: (message: unknown) => void;
}

/**
 * 创建一个"多 Tab 共享浏览器环境"的空白容器；随后调用 `createMemoryAdapters(env)`
 * 创建每个 Tab 独立的 adapter 工厂集合即可
 */
function createSharedMemoryEnv(): SharedMemoryEnv {
  return {
    storage: new Map(),
    bus: new Map(),
    storageSubscribers: new Map(),
  };
}

// ---------------------------------------------------------------------------
// 单 Tab adapter 工厂集合
// ---------------------------------------------------------------------------

/**
 * 单 Tab 的三件套 adapter 工厂集合
 *
 * 与 `LockDataAdapters<T>` 的 `getAuthority` / `getChannel` / `getSessionStore` 字段一一对应，
 * 可直接作为 `lockData({ adapters: { ...memoryAdapters, logger } })` 注入
 */
interface MemoryAdapters {
  readonly getAuthority: (ctx: AuthorityAdapterContext) => AuthorityAdapter;
  readonly getChannel: (ctx: ChannelAdapterContext) => ChannelAdapter;
  readonly getSessionStore: (ctx: SessionStoreAdapterContext) => SessionStoreAdapter;
}

/**
 * 可选的 logger 注入：用于验证「回调异常走 logger.error 隔离」的合规测试
 *
 * 未提供时内部 silently swallow 异常（保持接口契约不向上抛）
 */
interface CreateMemoryAdaptersOptions {
  readonly logger?: LoggerAdapter;
}

/**
 * 创建"某一个 Tab"的内存 adapter 工厂集合
 *
 * 同一 env 下多次调用 `createMemoryAdapters(env)` 即模拟多 Tab：
 * - 各 Tab 的 authority / channel 自然通过 env 共享
 * - 各 Tab 的 sessionScope 由工厂闭包内部维护，互不可见
 *
 * 每次调用会生成一个新的 `tabId` symbol 作为订阅者归属标识，用于：
 * - authority.subscribe：过滤"本 Tab write 触发的自通知"
 * - channel.postMessage：过滤"发送方自己订阅的回调"
 */
function createMemoryAdapters(env: SharedMemoryEnv, options: CreateMemoryAdaptersOptions = {}): MemoryAdapters {
  const tabId = Symbol('lock-data.memory-adapters.tab');
  const sessionScope = new Map<string, string>();
  const { logger } = options;

  return {
    getAuthority: (ctx) => createAuthorityAdapter(env, tabId, ctx, logger),
    getChannel: (ctx) => createChannelAdapter(env, tabId, ctx, logger),
    getSessionStore: (ctx) => createSessionStoreAdapter(sessionScope, ctx),
  };
}

// ---------------------------------------------------------------------------
// AuthorityAdapter
// ---------------------------------------------------------------------------

/**
 * 构造 authority 在共享 storage 里的完整 key
 *
 * 命名仅用于 helper 内部隔离（不同 adapter 互不串扰），不需要与默认
 * `${LOCK_PREFIX}:${id}:latest` 对齐 —— 因为 memory env 是 helper 自管的
 */
function buildAuthorityStorageKey(id: string): string {
  return `authority:${id}`;
}

function createAuthorityAdapter(
  env: SharedMemoryEnv,
  tabId: symbol,
  ctx: AuthorityAdapterContext,
  logger: LoggerAdapter | undefined,
): AuthorityAdapter {
  const key = buildAuthorityStorageKey(ctx.id);

  return {
    read(): string | null {
      return env.storage.get(key) ?? null;
    },

    write(raw: string): void {
      env.storage.set(key, raw);
      // 关键契约：仅通知"其他 Tab"的订阅者；本 Tab 自己的订阅者被 tabId 过滤掉
      // 对齐原生 storage 事件语义：发起 write 的 document 不会收到自己的 storage 事件
      notifyStorageSubscribers(env, key, raw, tabId);
    },

    remove(): void {
      env.storage.delete(key);
      notifyStorageSubscribers(env, key, null, tabId);
    },

    subscribe(onExternalUpdate: (newValue: string | null) => void): () => void {
      const subscriber: StorageSubscriber = { tabId, logger, onExternalUpdate };
      const subscribers = env.storageSubscribers.get(key) ?? new Set<StorageSubscriber>();
      subscribers.add(subscriber);
      env.storageSubscribers.set(key, subscribers);
      return (): void => {
        subscribers.delete(subscriber);
      };
    },
  };
}

/**
 * 通知 storage 指定 key 的跨 Tab 订阅者
 *
 * 契约：
 * - 仅通知 tabId 与 writerTabId 不同的订阅者（跨 Tab 语义）
 * - 订阅者之间异常隔离：一个订阅者抛错不影响其他订阅者
 * - 订阅者异常走**订阅者自己**注入的 logger.error（异常属于订阅者代码的责任，
 *   与 writer 无关；writer 可能根本没注入 logger）
 */
function notifyStorageSubscribers(
  env: SharedMemoryEnv,
  key: string,
  newValue: string | null,
  writerTabId: symbol,
): void {
  const subscribers = env.storageSubscribers.get(key);
  if (!subscribers) {
    return;
  }
  // 快照一份，避免回调内部解绑时迭代器失效
  const snapshot = Array.from(subscribers);
  for (const subscriber of snapshot) {
    if (subscriber.tabId === writerTabId) {
      continue;
    }
    try {
      subscriber.onExternalUpdate(newValue);
    } catch (error) {
      subscriber.logger?.error('[memory-adapters] authority subscriber threw', error);
    }
  }
}

// ---------------------------------------------------------------------------
// ChannelAdapter
// ---------------------------------------------------------------------------

/**
 * 构造 channel 在共享 bus 里的完整 name
 *
 * 同一 id 下 `session` / `custom` 两个通道互不干扰（对齐默认 `buildChannelName` 的
 * `${LOCK_PREFIX}:${id}:${channel}` 分段逻辑）
 */
function buildChannelBusName(id: string, channel: ChannelAdapterContext['channel']): string {
  return `${id}:${channel}`;
}

function createChannelAdapter(
  env: SharedMemoryEnv,
  tabId: symbol,
  ctx: ChannelAdapterContext,
  logger: LoggerAdapter | undefined,
): ChannelAdapter {
  const name = buildChannelBusName(ctx.id, ctx.channel);
  // 本 Tab 在该 channel 上的订阅者记录，close 时一次性解绑
  const localSubscribers = new Set<ChannelSubscriber>();
  let closed = false;

  return {
    postMessage(message: unknown): void {
      if (closed) {
        return;
      }
      const subscribers = env.bus.get(name);
      if (!subscribers) {
        return;
      }
      // 快照一份，避免回调内部订阅 / 解绑时迭代器失效
      const snapshot = Array.from(subscribers);
      for (const subscriber of snapshot) {
        // 关键契约：BroadcastChannel 规范 —— 发送方不会收到自己 postMessage 的消息
        if (subscriber.tabId === tabId) {
          continue;
        }
        try {
          subscriber.onMessage(message);
        } catch (error) {
          // 订阅者异常走**订阅者自己**注入的 logger（异常属于订阅者代码的责任）
          subscriber.logger?.error('[memory-adapters] channel subscriber threw', error);
        }
      }
    },

    subscribe(onMessage: (message: unknown) => void): () => void {
      if (closed) {
        return (): void => {
          /* noop */
        };
      }
      const subscriber: ChannelSubscriber = { tabId, logger, onMessage };
      const subscribers = env.bus.get(name) ?? new Set<ChannelSubscriber>();
      subscribers.add(subscriber);
      env.bus.set(name, subscribers);
      localSubscribers.add(subscriber);
      return (): void => {
        subscribers.delete(subscriber);
        localSubscribers.delete(subscriber);
      };
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      const subscribers = env.bus.get(name);
      if (subscribers) {
        for (const subscriber of localSubscribers) {
          subscribers.delete(subscriber);
        }
      }
      localSubscribers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// SessionStoreAdapter
// ---------------------------------------------------------------------------

function buildSessionStoreKey(id: string): string {
  return `session:${id}`;
}

function createSessionStoreAdapter(
  sessionScope: Map<string, string>,
  ctx: SessionStoreAdapterContext,
): SessionStoreAdapter {
  const key = buildSessionStoreKey(ctx.id);
  return {
    read(): string | null {
      return sessionScope.get(key) ?? null;
    },
    write(value: string): void {
      sessionScope.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export type { CreateMemoryAdaptersOptions, MemoryAdapters, SharedMemoryEnv };
export { createMemoryAdapters, createSharedMemoryEnv };
