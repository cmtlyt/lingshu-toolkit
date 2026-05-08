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
 * **JSON-only 契约**：lock-data 的 draft 仅支持 JSON 安全类型（plain object / array /
 * string / number（不含 NaN/Infinity）/ boolean / null），故 mutation op 仅有
 * 普通对象属性的 `set` / `delete` 两种。Set / Map / Date / class 实例 等非 JSON
 * 类型在 `createDraftSession` 入口与每次写入处会被显式拒绝（抛 `TypeError`），
 * 详见 `core/draft.ts` 文件顶部「JSON-only 契约」说明。
 *
 * op 语义：
 * - `'set'`：属性写入 / 新增，`path` 指向被修改的属性，`value` 为新值
 * - `'delete'`：属性删除，`path` 指向被删除的属性，`value` 不携带
 */
type LockDataMutationOp = 'set' | 'delete';

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
  /**
   * 释放锁
   *
   * 返回值兼容 Promises/A+ 规范的最小 thenable（仅需实现 `.then`），
   * 实现侧通过 `Promise.resolve(...).catch(...)` 正规化后挂错误处理
   */
  release: () => void | PromiseLike<void>;
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

/**
 * 顶层数组类型禁止
 *
 * wrapper Proxy 方案下，顶层数组会触发 `Object.keys(view)` / `JSON.stringify(view)` 的
 * length invariant TypeError、`Array.isArray(view)` 永远返回 `false` 等不可调和的不变量冲突
 *
 * 编译期把 `T extends unknown[]` 排除为 `never`，运行时由 `core/entry.ts` 的 `Array.isArray(awaited)`
 * 双重 fail-fast 拒绝，保证用户面错误信息明确（`InvalidOptionsError`）
 *
 * 对应 RFC.md「顶层数组禁止」章节
 */
type LockDataValueShape<T> = T extends readonly unknown[] ? never : T;

/**
 * 所有环境依赖的统一注入入口
 *
 * 设计决策：采用工厂函数（`getXxx(ctx) => Adapter`）而非直接传实例，
 * 理由是锁 / 权威副本 / 通道这些依赖与 id 强绑定，工厂形态允许上层
 * 在首次创建 Entry 时按 id 组装；无 id 作用域的依赖（logger）直接传实例
 *
 * 注：本期不再提供 `clone` 适配器，所有快照派生使用 `JSON.parse(JSON.stringify(...))` 固化语义；
 * `getValue` resolve 后 + `actions.replace(next)` 入参由 `assertJsonSafe` fail-fast 校验，
 * 保证 `entry.dataRef.current` 永远只含 JSON 安全值
 */
interface LockDataAdapters<_T> {
  getLock?: (ctx: LockDriverContext) => Promise<LockDriverHandle> | LockDriverHandle;
  getAuthority?: (ctx: AuthorityAdapterContext) => AuthorityAdapter | null;
  getChannel?: (ctx: ChannelAdapterContext) => ChannelAdapter | null;
  getSessionStore?: (ctx: SessionStoreAdapterContext) => SessionStoreAdapter | null;
  logger?: LoggerAdapter;
}

/**
 * `lockData` 的顶层配置（**单参数 API**）
 *
 * - `getValue` 必传：数据来源唯一入口，返回值禁止为顶层数组（`LockDataValueShape<T>` 类型层排除）
 * - 同步 `getValue()` → `lockData()` 同步返回元组
 * - 异步 `getValue()` → `lockData()` 返回 Promise<元组>，resolve 后才把元组交付给调用方
 *
 * 对应 RFC.md「§3 核心语义」「§API 签名」章节
 */
interface LockDataOptions<T> {
  /**
   * 锁 id；未传时视为"纯本地只读锁"，不参与跨模块 / 跨 Tab 共享
   */
  id?: string;

  /**
   * 数据初始化器（**必传**）
   *
   * - 返回值在类型层被 `LockDataValueShape<T>` 限制：禁止顶层数组（`T extends readonly unknown[]` 排除为 `never`）
   * - 返回 `T` → `lockData` 同步返回元组
   * - 返回 `Promise<T>` → `lockData` 返回 Promise<元组>
   * - 同步 `getValue()` 抛错 → `lockData()` 调用栈直接抛 `LockDisposedError`（Entry 不构造）
   * - 异步 `getValue()` reject → `lockData()` 返回的 Promise reject `LockDisposedError`，`cause` 字段携带原因
   * - 运行时 `Array.isArray(awaited)` 双重 fail-fast 拒绝顶层数组（抛 `InvalidOptionsError`）
   * - resolve 后由 `assertJsonSafe` 校验 JSON 安全（非 JSON-safe 抛 `InvalidOptionsError`）
   */
  getValue: () => LockDataValueShape<T> | Promise<LockDataValueShape<T>>;

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

  /** 整体替换；等价于一次隐式 update 事务；入参由 `assertJsonSafe` fail-fast 校验 */
  replace: (next: T, callOptions?: ActionCallOptions) => Promise<void>;

  /**
   * 不抢锁的快照读取
   *
   * 返回 `JSON.parse(JSON.stringify(entry.dataRef.current))` 产出的全新对象，
   * 与内部 `dataRef.current` 完全隔离；调用方对返回值的任何 mutate 都不会影响内部状态
   *
   * 对应 RFC.md「actions.snapshot()」章节
   */
  snapshot: () => T;

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
 *
 * 内部视角类型（第一个元素为裸 T），用于 `core/entry.ts` 及其调用链的实现；
 * 对外公开契约请使用 `LockDataTuple<T>`（第一个元素为 `ReadonlyView<T>`）
 */
type LockDataResult<T extends object> = readonly [T, LockDataActions<T>];

/**
 * 深只读视图
 *
 * - 函数类型透传不递归（避免破坏 this / 参数类型）
 * - 对象类型递归加 readonly，所有属性只读
 * - 其他类型（primitive / symbol）原样透传
 *
 * 运行时由 `core/readonly-view.ts::createReadonlyView` 返回深只读 Proxy 保证；
 * 用户通过 `lockData()` 返回的 tuple 第一个元素拿到的即为 `ReadonlyView<T>` 实例
 *
 * 对应 RFC.md「ReadonlyView\<T\>」章节
 *
 * 注：`(...args: any[]) => any` 是 RFC 合同语义（匹配任意函数签名的透传），
 * 无法用 `unknown[]` / `unknown` 替代（否则 `keyof` 分发到函数类型会得出 `never`）
 */
type ReadonlyView<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyView<T[K]> }
    : T;

/**
 * lockData 公开契约的返回元组类型
 *
 * 与内部 `LockDataResult<T>` 的区别：第一个元素类型为 `ReadonlyView<T>`（深只读代理），
 * 明确向用户传达"读句柄只读、写操作必须经 `actions.update/replace`"的设计意图
 *
 * 对应 RFC.md「签名」章节
 */
type LockDataTuple<T extends object> = readonly [ReadonlyView<T>, LockDataActions<T>];

/**
 * lockData 返回值类型推断（**单签名 + 条件类型自动推断**）
 *
 * 设计动机：避免 `LockDataTuple<T> | Promise<LockDataTuple<T>>` 联合类型在调用点强迫
 * 用户用 `as` 断言或 `instanceof Promise` 分支判断；类型层直接镜像运行时判定优先级，
 * 让 `lockData({ getValue: () => ({}) })` 直接得到元组、`lockData({ getValue: () => Promise.resolve({}) })`
 * 直接得到 Promise，无需 `await` / 断言
 *
 * 判定优先级（与 `core/entry.ts` 运行时分支严格对齐）：
 * 1. `O extends { syncMode: 'storage-authority' }`
 *    a. 若 `O extends { id: string }` → `Promise<LockDataTuple<T>>`
 *    b. 若 `O` 缺 `id` 字段 → `never`（**最严格类型层校验**：`syncMode='storage-authority'`
 *       要求必须传 `id`，否则 authority 无法绑定作用域；编译期 fail-fast 让这种非法组合
 *       在调用点直接类型报错，避免运行时静默 fallback 到 `'none'`）
 * 2. 否则若 `ReturnType<O['getValue']> extends Promise<unknown>` → `Promise<LockDataTuple<T>>`
 * 3. 否则 → `LockDataTuple<T>`
 *
 * 注：判定 1.b 用 `LockDataReturnNeverWithoutId` 做条件分支，避免 `O extends { id: string }`
 * 在 `O` 是宽泛类型（如 `LockDataOptions<T>`）时被推断为 `true` 而绕过校验；
 * 必须严格匹配 `O` 类型字面量中的 `id` 字段
 *
 * 注：第二个泛型参数 `O` 的约束放宽为 `object` 而非 `LockDataOptions<X>`，
 * 是 TypeScript 条件类型推断的**标准协变兜底用法**：
 * - `LockDataOptions<T>` 在 `T` 上是双向不变（`listeners.onCommit` 等回调字段使 `T` 既出现在
 *   协变位置又出现在逆变位置）
 * - 调用 `lockData<const O extends LockDataOptions<LockDataValueShape<LockDataInfer<O>>>>(options: O)`
 *   后，把 `O` 传给 `LockDataReturn<T, O>` 时若约束写成 `LockDataOptions<X>`（无论 `X` 是
 *   `T` / `any` / `unknown`），都会因双向不变而拒绝（参见 tsc TS2344）
 * - 条件分支只关心 `O` 是否包含 `syncMode` / `id` / `getValue` 字段，不需要 `O` 是
 *   `LockDataOptions` 的子类型；约束放到 `object` 即可（公开签名 `lockData` 的 `O` 约束
 *   已保证调用方传入合法 `LockDataOptions<X>`，类型层条件分支无需重复约束）
 *
 * 对应 RFC.md「§签名」章节 + 决策 #33 §A
 */
type LockDataReturn<T extends object, O extends object> = O extends { syncMode: 'storage-authority' }
  ? O extends { id: string }
    ? Promise<LockDataTuple<T>>
    : never
  : O extends { getValue: () => infer R }
    ? R extends Promise<unknown>
      ? Promise<LockDataTuple<T>>
      : LockDataTuple<T>
    : LockDataTuple<T>;

export type {
  ActionCallOptions,
  AuthorityAdapter,
  AuthorityAdapterContext,
  ChannelAdapter,
  ChannelAdapterContext,
  CommitEvent,
  CommitSource,
  LockDataActions,
  LockDataAdapters,
  LockDataListeners,
  LockDataMutation,
  LockDataMutationOp,
  LockDataOptions,
  LockDataResult,
  LockDataReturn,
  LockDataTuple,
  LockDataValueShape,
  LockDriverContext,
  LockDriverHandle,
  LockMode,
  LockPhase,
  LockStateChangeEvent,
  LoggerAdapter,
  Persistence,
  ReadonlyView,
  RevokeEvent,
  RevokeReason,
  SessionStoreAdapter,
  SessionStoreAdapterContext,
  SyncEvent,
  SyncMode,
  SyncSource,
  TimeoutValue,
};
