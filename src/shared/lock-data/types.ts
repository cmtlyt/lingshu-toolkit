/**
 * lock-data 模块的公开类型定义
 *
 * 仅包含 API 表面（options / actions / listeners / adapters 等），
 * 内部实现使用的类型（Entry / InstanceRegistry / DriverHandle 等）放在对应模块内部。
 *
 * 对应 RFC.md「附录 A：完整接口索引」章节。
 */

import type { NEVER_TIMEOUT } from './constants';

/**
 * 超时参数支持的形态：
 * - number：毫秒数（0 或负数非法，由参数校验层拦截）
 * - NEVER_TIMEOUT：永不超时（业务自控）
 */
type TimeoutValue = number | typeof NEVER_TIMEOUT;

/** 跨进程同步模式；本期仅 `'none'` 与 `'storage-authority'` */
type SyncMode = 'none' | 'storage-authority';

/**
 * 锁驱动选择模式
 *
 * 对应 RFC.md「能力检测与降级」；`adapters.getLock` 存在时本字段被忽略
 *
 * - `'auto'`（默认）：按能力降级链 web-locks → broadcast → storage
 * - `'web-locks'` / `'broadcast'` / `'storage'`：强制使用对应 driver；能力不可用时抛错
 */
type LockMode = 'auto' | 'web-locks' | 'broadcast' | 'storage';

/**
 * 持久化策略：
 * - `'session'`（默认）：所有 Tab 关闭后重置；协作期的天然语义
 * - `'persistent'`：跨浏览器重启保留；适合用户草稿 / 偏好
 */
type Persistence = 'session' | 'persistent';

/** `actions` 内部状态机的公开子集；用于 listeners.onLockStateChange 事件 */
type LockPhase = 'idle' | 'acquiring' | 'holding' | 'committing' | 'released' | 'revoked' | 'disposed';

/** revoke 触发原因 */
type RevokeReason = 'force' | 'timeout' | 'dispose';

/** `listeners.onSync` 的触发来源 */
type SyncSource = 'pull-on-acquire' | 'storage-event' | 'pageshow' | 'visibilitychange';

/** `listeners.onCommit` 的触发来源 */
type CommitSource = 'update' | 'replace';

/**
 * Draft 执行期间记录的最小路径变更
 *
 * 同时服务审计（listeners.onCommit）与回滚（revoke / abort 时反向应用）
 *
 * op 语义：
 * - `'set'` / `'delete'`：普通对象的属性写入 / 删除，`path` 指向被修改的属性
 * - `'map-set'` / `'map-delete'` / `'map-clear'`：Map 的 mutation；`path` 指向 Map 所在路径
 *   - `map-set` 的 `value = [key, newValue]`；`map-delete` 的 `value = key`；`map-clear` 无 value
 * - `'set-add'` / `'set-delete'` / `'set-clear'`：Set 的 mutation；`path` 指向 Set 所在路径
 *   - `set-add` / `set-delete` 的 `value = item`；`set-clear` 无 value
 */
type LockDataMutationOp =
  | 'set'
  | 'delete'
  | 'map-set'
  | 'map-delete'
  | 'map-clear'
  | 'set-add'
  | 'set-delete'
  | 'set-clear';

interface LockDataMutation {
  readonly path: readonly PropertyKey[];
  readonly op: LockDataMutationOp;
  readonly value?: unknown;
}

/** 状态流转事件 */
interface LockStateChangeEvent {
  readonly phase: LockPhase;
  readonly token: string;
}

/** revoke 事件 */
interface RevokeEvent {
  readonly reason: RevokeReason;
  readonly token: string;
}

/** commit 事件（仅 commit 成功时触发） */
interface CommitEvent<T> {
  readonly source: CommitSource;
  readonly token: string;
  readonly rev: number;
  readonly mutations: readonly LockDataMutation[];
  readonly snapshot: T;
}

/** sync 事件（仅 syncMode 非 none 时触发） */
interface SyncEvent<T> {
  readonly source: SyncSource;
  readonly rev: number;
  readonly snapshot: T;
}

/** 全部事件监听器；均为可选 */
interface LockDataListeners<T> {
  onLockStateChange?: (event: LockStateChangeEvent) => void;
  onRevoked?: (event: RevokeEvent) => void;
  onCommit?: (event: CommitEvent<T>) => void;
  onSync?: (event: SyncEvent<T>) => void;
}

/** 每次 action 调用级别的覆盖项 */
interface ActionCallOptions {
  /** 覆盖 options.timeout 中的抢锁部分 */
  acquireTimeout?: TimeoutValue;
  /** 覆盖 options.timeout 中的持锁部分 */
  holdTimeout?: TimeoutValue;
  /** 强制抢占当前持有者 */
  force?: boolean;
  /** 仅影响本次调用的取消信号 */
  signal?: AbortSignal;
}

/**
 * 驱动工厂上下文；用户注入自定义 `adapters.getLock` 时 RFC 约定的参数
 *
 * 命名字段与 RFC 「自定义锁驱动」示例对齐，不使用简写
 */
interface LockDriverContext {
  readonly name: string;
  readonly token: string;
  readonly force: boolean;
  readonly acquireTimeout: TimeoutValue;
  readonly holdTimeout: TimeoutValue;
  readonly signal: AbortSignal;
}

/** 锁驱动句柄；由 `adapters.getLock` 返回 */
interface LockDriverHandle {
  release: () => void | Promise<void>;
  onRevokedByDriver: (callback: (reason: 'force' | 'timeout') => void) => void;
}

/** `AuthorityAdapter` 工厂上下文 */
interface AuthorityAdapterContext {
  readonly id: string;
}

/** `ChannelAdapter` 工厂上下文 */
interface ChannelAdapterContext {
  readonly id: string;
  readonly channel: 'session' | 'custom';
}

/** `SessionStoreAdapter` 工厂上下文 */
interface SessionStoreAdapterContext {
  readonly id: string;
}

interface AuthorityAdapter {
  read: () => string | null;
  write: (raw: string) => void;
  remove: () => void;
  subscribe: (onExternalUpdate: (newValue: string | null) => void) => () => void;
}

interface ChannelAdapter {
  postMessage: (message: unknown) => void;
  subscribe: (onMessage: (message: unknown) => void) => () => void;
  close: () => void;
}

interface SessionStoreAdapter {
  read: () => string | null;
  write: (value: string) => void;
}

interface LoggerAdapter {
  warn: (message: string, ...extras: unknown[]) => void;
  error: (message: string, ...extras: unknown[]) => void;
  debug?: (message: string, ...extras: unknown[]) => void;
}

type CloneFn = <V>(value: V) => V;

/**
 * 所有环境依赖的统一注入入口
 *
 * 设计决策：采用工厂函数（`getXxx(ctx) => Adapter`）而非直接传实例，
 * 理由是锁 / 权威副本 / 通道这些依赖与 id 强绑定，工厂形态允许上层
 * 在首次创建 Entry 时按 id 组装；无 id 作用域的依赖（logger / clone）直接传实例
 */
interface LockDataAdapters<_T> {
  getLock?: (ctx: LockDriverContext) => Promise<LockDriverHandle> | LockDriverHandle;
  getAuthority?: (ctx: AuthorityAdapterContext) => AuthorityAdapter | null;
  getChannel?: (ctx: ChannelAdapterContext) => ChannelAdapter | null;
  getSessionStore?: (ctx: SessionStoreAdapterContext) => SessionStoreAdapter | null;
  logger?: LoggerAdapter;
  clone?: CloneFn;
}

/** `lockData` 的顶层配置 */
interface LockDataOptions<T> {
  /**
   * 锁 id；未传时视为"纯本地只读锁"，不参与跨模块 / 跨 Tab 共享
   */
  id?: string;

  /**
   * 同步 / 异步初始化器；返回 Promise 时 `lockData` 整体返回 Promise
   */
  getValue?: () => T | Promise<T>;

  /** 默认抢锁 + 持锁超时，可被 `ActionCallOptions` 覆盖 */
  timeout?: TimeoutValue;

  /**
   * 锁驱动选择；默认 `'auto'`
   *
   * `adapters.getLock` 存在时本字段被忽略（用户自定义 driver 优先级最高）
   */
  mode?: LockMode;

  /** 跨进程同步模式；默认 `'none'` */
  syncMode?: SyncMode;

  /** 持久化策略；默认 `'session'`（仅在 syncMode 非 none 时生效） */
  persistence?: Persistence;

  /** session-probe 等待窗口；默认 100ms */
  sessionProbeTimeout?: number;

  /** 实例级生命周期控制；abort 等价于 dispose() */
  signal?: AbortSignal;

  /** 全部事件监听器 */
  listeners?: LockDataListeners<T>;

  /** 所有环境依赖的注入入口 */
  adapters?: LockDataAdapters<T>;
}

/**
 * actions 对象的公开 API
 *
 * 每个方法的语义详见 RFC.md「Actions 实现要点」章节
 */
interface LockDataActions<T extends object> {
  /** 当前是否持有锁（释放 / revoke 后为 false） */
  readonly isHolding: boolean;

  /** 事务式写入；recipe 失败或被 revoke 时自动回滚 */
  update: (recipe: (draft: T) => void | Promise<void>, callOptions?: ActionCallOptions) => Promise<void>;

  /** 整体替换；等价于一次隐式 update 事务 */
  replace: (next: T, callOptions?: ActionCallOptions) => Promise<void>;

  /** 不抢锁的深克隆读取 */
  read: () => T;

  /** 手动抢锁；配合连续 update + release 实现多步事务 */
  getLock: (callOptions?: ActionCallOptions) => Promise<void>;

  /**
   * 只还锁，不销毁实例；actions 仍可继续使用
   *
   * 与 `dispose` 的区别：release 对应 getLock，dispose 对应 lockData
   */
  release: () => void;

  /** 还锁 + 销毁实例；调用后本 actions 进入 disposed 终态 */
  dispose: () => Promise<void>;
}

/**
 * lockData 返回值
 *
 * 同步初始化时为元组；异步初始化（getValue 返回 Promise 或 syncMode 非 none）时为 Promise<元组>
 */
type LockDataResult<T extends object> = readonly [T, LockDataActions<T>];

export type {
  ActionCallOptions,
  AuthorityAdapter,
  AuthorityAdapterContext,
  ChannelAdapter,
  ChannelAdapterContext,
  CloneFn,
  CommitEvent,
  CommitSource,
  LockDataActions,
  LockDataAdapters,
  LockDataListeners,
  LockDataMutation,
  LockDataMutationOp,
  LockDataOptions,
  LockDataResult,
  LockDriverContext,
  LockDriverHandle,
  LockMode,
  LockPhase,
  LockStateChangeEvent,
  LoggerAdapter,
  Persistence,
  RevokeEvent,
  RevokeReason,
  SessionStoreAdapter,
  SessionStoreAdapterContext,
  SyncEvent,
  SyncMode,
  SyncSource,
  TimeoutValue,
};
