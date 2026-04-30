/**
 * InstanceRegistry：同 id 进程内单例池
 *
 * 对应 RFC.md「InstanceRegistry（同 id 进程内单例）」章节（L633-671）。
 *
 * 职责：
 * - 按 id 缓存 Entry；同 id 再次 lockData(...) 复用同一份 data / driver / adapters / authority
 * - refCount 管理：每次 lockData(...) +1，actions.dispose() -1，归零时销毁 Entry
 * - listenersSet 管理：每实例独立保留一份 listeners，driver 事件向全部 fanout
 * - dataReadyPromise 共享：getValue 返回 Promise 时，同 id 多实例共享同一个就绪 Promise；
 *   resolve 后把内容 in-place 写回 `entry.data`，保持引用稳定
 * - initOptions 冲突检查：非 listeners 字段与首次注册不一致时走 logger.warn，以首次为准
 *
 * 设计边界：
 * - 本模块**不感知** actions 状态机 / Draft / fanout / authority 的具体实现
 * - Entry 的构造（pickDriver / pickDefaultAdapters / 初始化 data）由外部 `EntryFactory` 完成
 * - Registry 通过 `EntryFactoryContext.registerTeardown` 把销毁回调通道注入给 factory；
 *   StorageAuthority / fanout 等模块通过此回调登记清理，Registry 在 refCount 归零时逆序运行
 * - 无 id 场景不进入本 Registry（由 entry.ts 直接构造独立 Entry）
 */

import { createError } from '@/shared/throw-error';
import { isFunction, isObject, isPromiseLike } from '@/shared/utils/verify';
import { withResolvers } from '@/shared/with-resolvers';
import type { ResolvedAdapters } from '../adapters/index';
import type { ResolvedLoggerAdapter } from '../adapters/logger';
import type { StorageAuthority } from '../authority/index';
import { ERROR_FN_NAME } from '../constants';
import type { LockDriver } from '../drivers/index';
import { LockDisposedError } from '../errors';
import type { LockDataListeners, LockDataOptions, LockMode, Persistence, SyncMode, TimeoutValue } from '../types';

/** Entry 数据就绪状态；对应 RFC「dataReadyState 状态转换」表 */
type DataReadyState = 'pending' | 'ready' | 'failed';

/**
 * Entry 结构：同 id 共享的全部状态
 *
 * 字段说明对应 RFC「Entry 结构关键字段」表格（L633-650）。
 *
 * 引用稳定性：`data` 字段在 Entry 生命周期内引用永不变更 —— 所有 "替换 data" 的场景
 * （getValue Promise resolve / authority applySnapshot）都是**原地修改内容**，
 * 保证基于此引用构造的 readonly view 无需重建
 */
interface Entry<T extends object> {
  /** 锁 id；无 id 场景不进入 Registry，此字段必为非空字符串 */
  readonly id: string;
  /** 共享底层对象引用；in-place 修改语义，引用不变 */
  readonly data: T;
  /** 共享锁驱动实例；由首次 pickDriver 产出，Entry 销毁时 destroy */
  readonly driver: LockDriver;
  /** 已解析适配器集合 */
  readonly adapters: ResolvedAdapters<T>;
  /**
   * 跨 Tab 权威副本（对应 RFC L646）
   *
   * - `syncMode === 'storage-authority'` 时由 factory 构造并注入
   * - 其他 syncMode / 无 id 场景下为 null
   *
   * 生命周期：factory 创建后通过 registerTeardown 注册 `authority.dispose`，
   * Entry 销毁时随 teardown 统一释放
   */
  readonly authority: StorageAuthority<T> | null;
  /** 每实例独立的 listeners；driver 事件向全部 fanout */
  readonly listenersSet: Set<LockDataListeners<T>>;
  /** 首次注册的冻结配置；用于后续同 id 实例的冲突检查 */
  readonly initOptions: FrozenInitOptions;
  /** getValue 异步初始化时共享的就绪 Promise；同步初始化为 null */
  readonly dataReadyPromise: Promise<void> | null;
  /**
   * 注册 Entry 销毁回调；refCount 归零时逆序调用
   *
   * 调用异常隔离：单个回调抛错通过 logger.warn 捕获，继续运行后续回调
   * Entry 已进入销毁流程后再调用本方法，回调被静默丢弃
   */
  readonly registerTeardown: (teardown: () => void) => void;
  /** 引用计数；每次 lockData(...) +1，actions.dispose() -1；归零销毁 Entry */
  refCount: number;
  /** 当前数据的权威单调序号；commit 成功 +1，初始 0 */
  rev: number;
  /** 最近一次应用 authority snapshot 的 rev；与 rev 分离用于去重 */
  lastAppliedRev: number;
  /** 当前 Tab 所属会话纪元；persistent 策略为 'persistent'，session 策略首次为 null */
  epoch: string | null;
  /** 数据就绪状态 */
  dataReadyState: DataReadyState;
  /** getValue 原始 reject 原因；dataReadyState === 'failed' 时存在 */
  dataReadyError: unknown;
}

/**
 * 首次注册冻结的配置子集，用于冲突检查
 *
 * 仅记录 RFC 要求"跨实例必须一致"的字段；listeners / signal / getValue / adapters 等
 * 每实例独立字段不参与冲突检查
 */
interface FrozenInitOptions {
  readonly timeout: TimeoutValue | undefined;
  readonly mode: LockMode | undefined;
  readonly syncMode: SyncMode | undefined;
  readonly persistence: Persistence | undefined;
  readonly sessionProbeTimeout: number | undefined;
}

/**
 * EntryFactory 调用上下文
 *
 * Registry 把生命周期通道（`registerTeardown`）通过此对象注入 factory；
 * factory 组装 Entry 时直接把 `registerTeardown` 写进 Entry 字段
 */
interface EntryFactoryContext {
  /** 供 factory 写进 Entry 的 `registerTeardown`；Registry 归零时使用这些回调 */
  readonly registerTeardown: (teardown: () => void) => void;
}

/**
 * Entry 构造工厂：由外部（entry.ts）注入，避免 Registry 直接依赖 driver / adapter 层
 *
 * 工厂契约：
 * 1. 解析 adapters（pickDefaultAdapters）→ 解析 driver（pickDriver）
 * 2. 按 `resolveInitialData` 准备初始 data / dataReadyPromise / dataReadyState
 * 3. 把 `ctx.registerTeardown` 写入返回 Entry 的 `registerTeardown` 字段
 * 4. refCount 初始 1，listenersSet 含当次 options.listeners（若提供）
 *
 * 工厂抛错时 Registry 不会把条目放入 Map —— **partial 资源的清理由 factory 自己负责**
 * （factory 应当在内部用 try/catch 处理中途失败；例如已构造的 driver、已注册的订阅等）。
 * Registry 不介入 partial 构造链，避免在无 logger 可用的场景被迫使用 console 兜底
 */
type EntryFactory<T extends object> = (id: string, options: LockDataOptions<T>, ctx: EntryFactoryContext) => Entry<T>;

/** Registry 对外 API */
interface InstanceRegistry {
  /**
   * 获取或创建指定 id 的 Entry
   *
   * - 命中已存在 Entry：refCount++ + 加入 listenersSet + 冲突检查 + 返回
   * - 首次创建：调用 factory 构造 Entry 并注册
   *
   * 命中已存在 Entry 时**不会**检查 dataReadyState：Actions 层通过 `entry.dataReadyState` /
   * await `entry.dataReadyPromise` 自行感知初始化失败，由 Actions 层抛 LockDisposedError
   *
   * @throws 仅在 id 为空字符串时抛错（其他参数合法性由调用方保证）
   */
  getOrCreateEntry: <T extends object>(id: string, options: LockDataOptions<T>, factory: EntryFactory<T>) => Entry<T>;

  /**
   * 释放指定实例对 Entry 的持有
   *
   * - 若传入 listeners 则从 listenersSet 移除（Set.delete 幂等）
   * - refCount--；归零时逆序运行 teardownCallbacks → driver.destroy() → registry.delete(id)
   * - 未命中 id / refCount 已为 0 时 no-op（幂等）
   */
  releaseEntry: <T extends object>(id: string, listeners: LockDataListeners<T> | undefined) => void;

  /** 仅用于测试 / 调试 */
  readonly peek: {
    has: (id: string) => boolean;
    size: () => number;
  };
}

/** 冻结 options 子集用于冲突检查 */
function freezeInitOptions<T extends object>(options: LockDataOptions<T>): FrozenInitOptions {
  return Object.freeze({
    timeout: options.timeout,
    mode: options.mode,
    syncMode: options.syncMode,
    persistence: options.persistence,
    sessionProbeTimeout: options.sessionProbeTimeout,
  });
}

/**
 * 对比两份 initOptions；不一致字段通过 logger.warn 提示，以首次为准（不抛错）
 *
 * RFC L605：同 id 配置轻微差异很常见，抛错会让调用方心智负担过重，故仅 warn
 */
function checkInitOptionsConflict(
  id: string,
  incoming: FrozenInitOptions,
  existing: FrozenInitOptions,
  logger: ResolvedLoggerAdapter,
): void {
  const keys: Array<keyof FrozenInitOptions> = ['timeout', 'mode', 'syncMode', 'persistence', 'sessionProbeTimeout'];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (incoming[key] !== existing[key]) {
      logger.warn(
        `[lockData] option conflict on id=${id} (field=${String(key)}, first=${String(existing[key])}, incoming=${String(incoming[key])}), using first registered value`,
      );
    }
  }
}

/**
 * 销毁 Entry：逆序运行 teardowns → driver.destroy；异常隔离
 *
 * teardowns 逆序执行：后注册的通常依赖先注册的资源，逆序可避免 use-after-free
 */
function teardownEntry<T extends object>(entry: Entry<T>, teardowns: Array<() => void>): void {
  const { driver, adapters, id } = entry;
  const { logger } = adapters;
  for (let i = teardowns.length - 1; i >= 0; i--) {
    try {
      teardowns[i]();
    } catch (error) {
      logger.warn(`[lockData] teardown callback threw on id=${id}`, error);
    }
  }
  try {
    driver.destroy();
  } catch (error) {
    logger.warn(`[lockData] driver.destroy threw on id=${id}`, error);
  }
}

/**
 * Registry 内部按 id 跟踪的完整状态
 *
 * 把 teardowns + alive 守卫聚合成一个 slot，避免两个 Map 之间的同步漂移
 */
interface RegistrySlot<T extends object> {
  readonly entry: Entry<T>;
  readonly teardowns: Array<() => void>;
  /** 生命周期守卫：Entry 销毁后置 false，使 registerTeardown 成为 no-op */
  readonly alive: { value: boolean };
}

/**
 * 创建一个独立的 InstanceRegistry
 *
 * 通常单进程只创建一个（由 entry.ts 持有模块级单例），但允许测试构造隔离实例
 */
function createInstanceRegistry(): InstanceRegistry {
  // Registry 内部按 RegistrySlot<object> 统一存储；对外 API 通过泛型参数恢复精确类型
  // 类型擦除的 `as unknown as` 强转全部收敛在本闭包内（registry.get / registry.set 两处），
  // 外部调用方全程享有类型安全
  const registry = new Map<string, RegistrySlot<object>>();

  const buildRegisterTeardown =
    (teardowns: Array<() => void>, alive: { value: boolean }) =>
    (teardown: () => void): void => {
      if (!isFunction(teardown)) {
        return;
      }
      if (!alive.value) {
        return;
      }
      teardowns.push(teardown);
    };

  const getOrCreateEntry = <T extends object>(
    id: string,
    options: LockDataOptions<T>,
    factory: EntryFactory<T>,
  ): Entry<T> => {
    if (id.length === 0) {
      throw createError(ERROR_FN_NAME, 'InstanceRegistry requires a non-empty id', TypeError);
    }

    const existing = registry.get(id) as RegistrySlot<T> | undefined;
    if (existing) {
      const { entry } = existing;
      entry.refCount++;
      const { listeners } = options;
      if (isObject(listeners)) {
        entry.listenersSet.add(listeners);
      }
      checkInitOptionsConflict(id, freezeInitOptions(options), entry.initOptions, entry.adapters.logger);
      return entry;
    }

    const teardowns: Array<() => void> = [];
    const alive = { value: true };
    const registerTeardown = buildRegisterTeardown(teardowns, alive);

    const entry = factory(id, options, { registerTeardown });

    registry.set(id, { entry, teardowns, alive } as unknown as RegistrySlot<object>);
    return entry;
  };

  const releaseEntry = <T extends object>(id: string, listeners: LockDataListeners<T> | undefined): void => {
    const slot = registry.get(id) as RegistrySlot<T> | undefined;
    if (!slot || slot.entry.refCount <= 0) {
      return;
    }
    const { entry, teardowns, alive } = slot;
    if (listeners !== undefined) {
      entry.listenersSet.delete(listeners);
    }
    entry.refCount--;
    if (entry.refCount > 0) {
      return;
    }
    // 先置 alive=false，再从 Map 删除 + 运行 teardowns：
    // 1. alive 翻转阻止 teardown 运行期间回调里登记的新 teardown 进入队列
    // 2. registry.delete 让后续 getOrCreateEntry 命中 miss 分支（而不是这个正在销毁的 slot）
    alive.value = false;
    registry.delete(id);
    teardownEntry(entry, teardowns);
  };

  return {
    getOrCreateEntry,
    releaseEntry,
    peek: {
      has: (id: string): boolean => registry.has(id),
      size: (): number => registry.size,
    },
  };
}

// ----------------------------------------------------------------------------
// 初始化 data 的辅助工具
// ----------------------------------------------------------------------------

/**
 * 初始化 data 的产物；由 EntryFactory 应用到 Entry 构造
 *
 * 所有字段均为"初始值"：
 * - `data`：引用在 Entry 生命周期内固定；内容可被 getValue resolve / authority 应用覆写
 * - `dataReadyPromise`：一旦创建不会替换；同步就绪为 null
 * - `dataReadyState` / `dataReadyError`：仅反映**初始**状态；后续由 `resolveInitialData`
 *   内部的 onStateChange 回调异步改写 Entry 字段（factory 把 Entry 引用捕获给 onStateChange）
 */
interface InitialDataPatch<T extends object> {
  readonly data: T;
  readonly dataReadyPromise: Promise<void> | null;
  readonly dataReadyState: DataReadyState;
  readonly dataReadyError: unknown;
}

/**
 * 原地替换 target 的内容为 source 的内容（保持 target 引用不变）
 *
 * 契约：target 与 source 必须**结构一致**（同为数组 或 同为普通对象）
 * 违反契约时抛 TypeError —— 违反者通常是 getValue 返回值与 initial 结构不匹配，
 * 尽早暴露比 "尽力处理" 产生混乱的半成品更安全
 *
 * 处理策略：
 * - 数组：截断 target 后 push source 的所有元素；target.length 自动跟随
 * - 对象：删除 target 的自有键（含 Symbol key），再拷贝 source 的自有键
 *   （Set/Map/Date 等作为**叶子值**随引用赋值即可，不做递归处理）
 *
 * 使用 `Reflect.ownKeys` 而非 `Object.keys`：前者覆盖 string + Symbol 全部自有键，
 * 后者遗漏 Symbol 会导致残留；getValue 返回值包含 Symbol key 的场景虽罕见但规范上合法
 */
function applyInPlace<T extends object>(target: T, source: T): void {
  const targetIsArray = Array.isArray(target);
  const sourceIsArray = Array.isArray(source);
  if (targetIsArray !== sourceIsArray) {
    throw createError(
      ERROR_FN_NAME,
      `applyInPlace structural mismatch: target is ${targetIsArray ? 'array' : 'object'} but source is ${sourceIsArray ? 'array' : 'object'}`,
      TypeError,
    );
  }
  if (targetIsArray) {
    const targetArray = target as unknown as unknown[];
    const sourceArray = source as unknown as unknown[];
    targetArray.length = 0;
    for (let i = 0; i < sourceArray.length; i++) {
      targetArray.push(sourceArray[i]);
    }
    return;
  }
  const targetKeys = Reflect.ownKeys(target);
  for (let i = 0; i < targetKeys.length; i++) {
    Reflect.deleteProperty(target, targetKeys[i]);
  }
  const sourceKeys = Reflect.ownKeys(source);
  for (let i = 0; i < sourceKeys.length; i++) {
    const key = sourceKeys[i];
    Reflect.set(target, key, Reflect.get(source, key));
  }
}

/**
 * 按 options.getValue 形态准备初始 data / dataReadyPromise / dataReadyState
 *
 * 三种形态：
 * 1. 未提供 getValue：使用 initial，状态 'ready'，Promise null
 * 2. getValue 返回同步值：以返回值为准（覆盖 initial），状态 'ready'，Promise null
 * 3. getValue 返回 Promise：
 *    - data 用占位对象：initial 存在则用 initial；否则用 `{}` 并 logger.warn
 *    - 状态 'pending'；Promise resolve 时内容 in-place 写回 data
 *    - Promise reject 时状态切为 'failed'，dataReadyError 记录原始错误
 *
 * getValue 同步抛错按 Promise.reject 等价处理（状态 'failed'）
 *
 * @param onStateChange Promise 完成后的状态回写回调；EntryFactory 闭包捕获 Entry 引用
 *                      把新状态写入 entry.dataReadyState / entry.dataReadyError
 */
function resolveInitialData<T extends object>(
  options: LockDataOptions<T>,
  initial: T | undefined,
  logger: ResolvedLoggerAdapter,
  onStateChange: (state: DataReadyState, error: unknown) => void,
): InitialDataPatch<T> {
  const { getValue } = options;

  // 分支 1：未提供 getValue
  if (!isFunction(getValue)) {
    const data = resolveSyncFallback(initial);
    return { data, dataReadyPromise: null, dataReadyState: 'ready', dataReadyError: undefined };
  }

  // getValue 同步抛错走 failed 分支
  let raw: T | PromiseLike<T>;
  try {
    raw = getValue();
  } catch (error) {
    return buildFailedInitialData(initial, logger, error, onStateChange);
  }

  // 分支 2：同步返回值（RFC L141：getValue 返回值优先于 initial 入参）
  if (!isPromiseLike(raw)) {
    return {
      data: raw as T,
      dataReadyPromise: null,
      dataReadyState: 'ready',
      dataReadyError: undefined,
    };
  }

  // 分支 3：Promise / thenable 返回值（RFC L141：getValue resolve 前 readonly 读到 initial 或 `{}`）
  return buildPendingInitialData(initial, logger, raw, onStateChange);
}

/**
 * 同步场景的 initial 校验
 *
 * RFC L664：`data === undefined` **仅允许**出现在"getValue 返回 Promise"的异步分支；
 * 同步分支（未提供 getValue / getValue 同步返回）初始 data 必须提供 —— 违反者属于
 * 参数校验漏网之鱼，这里显式抛错暴露问题而非静默兜底
 */
function resolveSyncFallback<T extends object>(initial: T | undefined): T {
  if (initial === undefined) {
    throw createError(ERROR_FN_NAME, 'initial data is required when getValue is not provided (sync branch)', TypeError);
  }
  return initial;
}

/**
 * 异步就绪场景的 data 占位
 *
 * RFC L664：首次注册 `data === undefined` 时初始 entry.data 为空对象 `{}` + logger.warn；
 * initial 存在时直接用 initial 作为占位，Promise resolve 后通过 applyInPlace 原地覆写
 */
function resolvePendingPlaceholder<T extends object>(initial: T | undefined, logger: ResolvedLoggerAdapter): T {
  if (initial === undefined) {
    logger.warn(
      '[lockData] initial data is undefined during async getValue; fallback to empty object {} and replace in-place on resolve',
    );
    return {} as T;
  }
  return initial;
}

function buildFailedInitialData<T extends object>(
  initial: T | undefined,
  logger: ResolvedLoggerAdapter,
  cause: unknown,
  onStateChange: (state: DataReadyState, error: unknown) => void,
): InitialDataPatch<T> {
  const data = resolvePendingPlaceholder(initial, logger);
  // 同步通知 Entry 切到 failed 态；之后所有 action 调用立刻 reject
  onStateChange('failed', cause);
  // 暴露已 reject 的 Promise；Actions 层显式 await 时拿到 reject 原因
  const rejected = Promise.reject(cause);
  // attach no-op .catch 仅抑制 Node 的 UnhandledPromiseRejectionWarning；
  // 不影响原 Promise 的 reject 链（.catch 返回新 Promise，Actions 层 await 原始 rejected 仍能拿到错误）
  rejected.catch(suppressUnhandled);
  return {
    data,
    dataReadyPromise: rejected,
    dataReadyState: 'failed',
    dataReadyError: cause,
  };
}

function buildPendingInitialData<T extends object>(
  initial: T | undefined,
  logger: ResolvedLoggerAdapter,
  source: PromiseLike<T>,
  onStateChange: (state: DataReadyState, error: unknown) => void,
): InitialDataPatch<T> {
  const data = resolvePendingPlaceholder(initial, logger);
  const ready = withResolvers<void>();
  source.then(
    (next) => {
      try {
        applyInPlace(data, next);
        onStateChange('ready', undefined);
        ready.resolve();
      } catch (applyError) {
        // applyInPlace 抛错（极少见，例如 target 被 freeze）按初始化失败处理
        logger.error('[lockData] failed to apply getValue result in-place', applyError);
        onStateChange('failed', applyError);
        ready.reject(applyError);
      }
    },
    (rejectReason) => {
      onStateChange('failed', rejectReason);
      ready.reject(rejectReason);
    },
  );
  ready.promise.catch(suppressUnhandled);
  return {
    data,
    dataReadyPromise: ready.promise,
    dataReadyState: 'pending',
    dataReadyError: undefined,
  };
}

function suppressUnhandled(): void {
  /* no-op：抑制 Node UnhandledPromiseRejectionWarning，不影响原 Promise reject 传播 */
}

/**
 * 构造 LockDisposedError，cause 字段携带 getValue 原始 reject 原因
 *
 * 由 Actions 层在 `dataReadyState === 'failed'` 时调用，对外统一抛 LockDisposedError。
 * 放在本模块的理由：`LockDisposedError + cause` 的错误格式是 Registry 对外的数据契约
 * （RFC L684 规定"错误 cause 字段携带 getValue 原始 reject 原因"），与 `dataReadyError`
 * 字段成对出现 —— 让同一处代码产出 dataReadyError 与对外错误，避免契约漂移
 */
function createFailedInitError(id: string, cause: unknown): Error {
  // `ErrorConstructor` 接口同时要求「可 new / 可直接调用」两种签名；class 语法子类不支持
  // 无 new 直接调用，在调用点做一次类型适配
  return createError(
    ERROR_FN_NAME,
    `lockData id=${id} initialization failed during getValue()`,
    LockDisposedError as unknown as ErrorConstructor,
    { cause },
  );
}

export type {
  DataReadyState,
  Entry,
  EntryFactory,
  EntryFactoryContext,
  FrozenInitOptions,
  InitialDataPatch,
  InstanceRegistry,
};
export { applyInPlace, createFailedInitError, createInstanceRegistry, freezeInitOptions, resolveInitialData };
