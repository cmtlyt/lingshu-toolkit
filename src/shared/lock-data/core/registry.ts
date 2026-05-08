/**
 * InstanceRegistry：同 id 进程内单例池
 *
 * 对应 RFC.md「InstanceRegistry（同 id 进程内单例）」章节。
 *
 * 职责：
 * - 按 id 缓存 Entry；同 id 再次 lockData(...) 复用同一份 dataRef / driver / adapters / authority
 * - refCount 管理：每次 lockData(...) +1，actions.dispose() -1，归零时销毁 Entry
 * - listenersSet 管理：每实例独立保留一份 listeners，driver 事件向全部 fanout
 * - dataReadyPromise 共享：getValue 返回 Promise 时，同 id 多实例共享同一个就绪 Promise；
 *   resolve 后由外部 factory 调用 `entry.applyRemote(awaited)` 把 dataRef.current 重新赋值
 * - initOptions 冲突检查：非 listeners 字段与首次注册不一致时走 logger.warn，以首次为准
 *
 * 设计边界：
 * - 本模块**不感知** actions 状态机 / Draft / fanout / authority 的具体实现
 * - Entry 的构造（pickDriver / pickDefaultAdapters / 初始化 data）由外部 `EntryFactory` 完成
 * - Registry 通过 `EntryFactoryContext.registerTeardown` 把销毁回调通道注入给 factory；
 *   StorageAuthority / fanout 等模块通过此回调登记清理，Registry 在 refCount 归零时逆序运行
 * - 无 id 场景不进入本 Registry（由 entry.ts 直接构造独立 Entry）
 *
 * wrapper 方案契约（与旧契约的根本差异）：
 * - `Entry.dataRef` 引用本身在 Entry 生命周期内永不变更
 * - `Entry.dataRef.current` 在以下场景被重新赋值（`= JSON.parse(JSON.stringify(next))`）：
 *   ① 异步 getValue resolve 后；② commit 成功后；③ `entry.applyRemote(next)` 远程同步
 * - readonly view 通过 wrapper Proxy 跟随 `dataRef.current`，所有用户读取都看到最新值
 */

import { createError } from '@/shared/throw-error';
import { isFunction, isObject } from '@/shared/utils/verify';
import { withResolvers } from '@/shared/with-resolvers';
import type { ResolvedAdapters } from '../adapters/index';
import type { ResolvedLoggerAdapter } from '../adapters/logger';
import type { StorageAuthority } from '../authority/index';
import { ERROR_FN_NAME } from '../constants';
import type { LockDriver } from '../drivers/index';
import { LockDisposedError } from '../errors';
import type { LockDataListeners, LockDataOptions, LockMode, Persistence, SyncMode, TimeoutValue } from '../types';
import { assertJsonSafeInput, cloneByJson } from '../utils/json-safe';

/**
 * Entry 结构：同 id 共享的全部状态
 *
 * 字段说明对应 RFC「Entry 结构关键字段」表格。
 *
 * 引用稳定性（wrapper 方案）：
 * - `dataRef` 引用本身在 Entry 生命周期内永不变更
 * - `dataRef.current` 在 commit / `applyRemote` / 异步 getValue resolve 时被重新赋值
 * - readonly view 通过 wrapper Proxy（target = dataRef）跟随 `dataRef.current`
 */
interface Entry<T extends object> {
  /**
   * 锁的展示用 id；用于日志、错误消息、Registry slot key 等"对外稳定文本"输出
   *
   * - Registry 路径：等于真实 id（非空字符串）
   * - Standalone（无 id）路径：占位字符串 `'__local__'`
   *
   * **重要**：永远不要拿这个字段去做"是否有真实 id"的语义判定 —— standalone 路径
   * 它只是占位。语义判定请使用 `lockId` 字段（详见下方）
   */
  readonly id: string;
  /**
   * 真实锁 id；用于"是否启用跨 Tab 能力"的语义判定
   *
   * - Registry 路径：与 `id` 同值（必为非空字符串）
   * - Standalone（无 id）路径：`undefined`，由此驱动 `pickDriver` 走 LocalLockDriver、
   *   `syncMode='storage-authority'` 不启用 authority、driver acquire `name` 走本地占位
   *
   * 详见 `src/shared/lock-data/fixes/standalone-id-leak.md`
   */
  readonly lockId: string | undefined;
  /**
   * 共享数据 wrapper 引用
   *
   * - `dataRef` 引用本身在 Entry 生命周期内永不变更
   * - `dataRef.current` 在 commit / `applyRemote` / 异步 getValue resolve 时被重新赋值
   * - readonly view 通过 wrapper Proxy（target = dataRef）跟随 `dataRef.current`
   *
   * 不直接暴露 `T` 引用（而是包一层 `{ current: T }`）是为了让 wrapper Proxy 始终持有
   * 一个稳定的 target，commit / 远程同步只需替换 `dataRef.current`，无需重建 view
   */
  readonly dataRef: { current: T };
  /**
   * 远程同步入口：替换 `dataRef.current`
   *
   * 内部执行 `dataRef.current = JSON.parse(JSON.stringify(next))`，
   * 由 authority 远程 push / 异步 getValue resolve 等场景调用
   *
   * JSON 拷贝隔离契约：调用方传入的 `next` 对象与内部 `dataRef.current` 完全隔离，
   * 任一方的后续 mutate 都不会影响另一方
   */
  readonly applyRemote: (next: T) => void;
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
  /**
   * 异步初始化未就绪场景的等待依据
   *
   * - 同步路径下为 `null`（Entry 构造瞬间即已就绪）
   * - 异步路径下持有合成 Promise，resolve 时表示 `dataRef.current` 已被赋值为真实值
   *
   * 真实用途场景（详见 fixes/api-getvalue-only-redesign.md §14.3）：
   * ① 同 Tab 二次 lockData 调用方命中已存在 Entry 但首次调用尚未 resolve
   * ② authority.init 等待异步初始化完成后再做远程拉取
   * ③ 异步初始化期间 Entry 提前注册 + 二次调用方共享
   *
   * 异步初始化失败时 Promise reject，所有持有此 Entry 的同 Tab 调用方
   * 在 action 时通过 `ensureDataReady` 抛 `LockDisposedError`（cause 携带原始原因）
   */
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
 * 2. 按 `prepareEntryData` 准备 `dataRef` / `applyRemote` / `dataReadyPromise`
 *    （同步路径直接得到首值；异步路径下 Entry 构造延迟到 awaited resolve 之后）
 * 3. 把 `ctx.registerTeardown` 写入返回 Entry 的 `registerTeardown` 字段
 * 4. refCount 初始 1，listenersSet 含当次 options.listeners（若提供）
 * 5. 把入参 `id` 写入 `Entry.id`、`lockId` 写入 `Entry.lockId`
 *
 * 工厂抛错时 Registry 不会把条目放入 Map —— **partial 资源的清理由 factory 自己负责**
 * （factory 应当在内部用 try/catch 处理中途失败；例如已构造的 driver、已注册的订阅等）。
 * Registry 不介入 partial 构造链，避免在无 logger 可用的场景被迫使用 console 兜底
 *
 * 参数语义：
 * - `id`：展示用 id（必为非空字符串）；Registry 路径下 = 真实 id，
 *   standalone 路径下 = 占位 `'__local__'`
 * - `lockId`：真实 id；Registry 路径下与 `id` 同值，standalone 路径下为 `undefined`
 *   下游（pickDriver / attachAuthority / driver acquire name）必须基于此参数
 *   做"是否有真实 id"的语义判定，详见 `fixes/standalone-id-leak.md`
 */
type EntryFactory<T extends object> = (
  id: string,
  lockId: string | undefined,
  options: LockDataOptions<T>,
  ctx: EntryFactoryContext,
) => Entry<T>;

/** Registry 对外 API */
interface InstanceRegistry {
  /**
   * 获取或创建指定 id 的 Entry
   *
   * - 命中已存在 Entry：refCount++ + 加入 listenersSet + 冲突检查 + 返回
   * - 首次创建：调用 factory 构造 Entry 并注册
   *
   * 命中已存在 Entry 时**不会**等待 dataReadyPromise：Actions 层通过
   * `await entry.dataReadyPromise` 自行感知初始化失败，由 Actions 层抛 LockDisposedError
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

    // Registry 路径下 lockId 与 id 同值（id 已通过上方 length === 0 校验保证非空）
    const entry = factory(id, id, options, { registerTeardown });

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
// 初始化 data 的辅助工具（wrapper 方案）
// ----------------------------------------------------------------------------

/**
 * `prepareEntryData` 的产物；由 EntryFactory 用来组装 Entry 字段
 *
 * 字段语义：
 * - `firstValue`：进入 Entry 时 `dataRef.current` 的首个值（已经过 JSON 拷贝隔离）
 * - `dataReadyPromise`：异步路径下的就绪等待依据；同步路径下为 `null`
 *
 * 与旧版 `InitialDataPatch` 的差异：
 * - 不再返回引用稳定的 `data`（wrapper 方案下 `dataRef.current` 可被重新赋值，无需引用稳定）
 * - 不再返回 `dataReadyState` / `dataReadyError` 字段（这两个字段已删除）
 * - 同步抛错路径不返回 patch，而是直接抛 `LockDisposedError`（Entry 不构造）
 */
interface EntryInitialData<T extends object> {
  /**
   * 进入 Entry 时 `dataRef.current` 的初始值
   *
   * - **同步路径**：已经过 `assertJsonSafeInput` + `cloneByJson` 隔离，是真实首值
   * - **异步路径**：占位 `{} as T`；真实首值通过 `dataReadyPromise` resolve 时携带的值，
   *   由 EntryFactory 在 resolve 后调用 `entry.applyRemote(awaited)` 写入 `dataRef.current`
   */
  readonly firstValue: T;
  /**
   * 异步就绪通道（同步路径为 `null`）
   *
   * - 异步路径 resolve 时携带 awaited 真实首值（已经过 `assertJsonSafeInput` 校验）；
   *   EntryFactory 拿到该值后 `applyRemote(awaited)` 写入 `dataRef.current`
   * - 异步路径 reject 时携带 `LockDisposedError`（cause 字段保留原始 reject 原因）
   * - 同步路径下首值已写入 `firstValue`，无需异步通道
   *
   * 通道资源严禁外泄：仅 `EntryFactory` 内部使用；`Entry.dataReadyPromise` 是
   * 经过 `.then(() => undefined)` 抹平后的 `Promise<void>`，对外只暴露就绪与否
   */
  readonly dataReadyPromise: Promise<T> | null;
}

/**
 * 按 `options.getValue` 形态准备 Entry 的首值 + dataReadyPromise
 *
 * 两种形态（types 层已强制 `getValue` 必传）：
 *
 * 1. **同步路径**：`getValue()` 返回非 PromiseLike
 *    - 同步抛错 → 抛 `LockDisposedError`（Entry 不构造，不进 registry）
 *    - 顶层数组 / 非 JSON-safe 值 → 抛 `InvalidOptionsError` / `TypeError`（Entry 不构造）
 *    - 正常返回 → `firstValue = cloneByJson(returned)`，`dataReadyPromise = null`
 *
 * 2. **异步路径**：`getValue()` 返回 Promise / thenable
 *    - 占位 `firstValue = {} as T`；真实首值通过 `dataReadyPromise` resolve 时携带（仅一次 await）
 *    - resolve 后 `assertJsonSafeInput` 校验 awaited，校验失败 → reject `LockDisposedError`
 *    - 原始 Promise reject → reject `LockDisposedError`（cause 携带原始原因）
 *    - **Entry 构造延迟到 awaited resolve 之后**：调用方 `lockData()` 在 resolve 前不返回元组
 *
 * 校验闸单点收敛：所有进入 `dataRef.current` 的值（同步 / 异步）都在本函数内统一走
 * `assertJsonSafeInput`，调用方拿到 firstValue 时已是 JSON 安全状态
 */
function prepareEntryData<T extends object>(id: string, options: LockDataOptions<T>): EntryInitialData<T> {
  const { getValue } = options;
  // types 层已强制 getValue 必传，运行时再做一道保险（防御误用 / 类型擦除路径）
  if (!isFunction(getValue)) {
    throw createError(ERROR_FN_NAME, `lockData id=${id} requires options.getValue (function)`, TypeError);
  }

  // 同步路径：getValue 同步抛错直接 LockDisposedError，Entry 不构造
  let raw: T | PromiseLike<T>;
  try {
    raw = getValue() as T | PromiseLike<T>;
  } catch (cause) {
    throw createFailedInitError(id, cause);
  }

  // 同步返回值：assertJsonSafeInput 校验 → cloneByJson 隔离 → firstValue
  // 校验失败抛 InvalidOptionsError / TypeError（Entry 不构造，不进 registry）
  if (!isPromiseLikeValue(raw)) {
    assertJsonSafeInput(raw, 'lockData getValue() result');
    return {
      firstValue: cloneByJson(raw as T),
      dataReadyPromise: null,
    };
  }

  // 异步返回值：仅一次 await；resolve 后内部统一走 assertJsonSafeInput + 携带 awaited
  return buildPendingEntryData(id, raw);
}

/**
 * 异步路径辅助函数：合成 dataReadyPromise（携带 awaited 真实首值）+ 占位 firstValue
 *
 * **关键契约**：
 * 1. 仅一次 await `source` —— 用户的 `getValue` 不再被重复调用，无需"幂等"假设
 * 2. resolve 后内部走 `assertJsonSafeInput`：顶层数组 / 非 JSON-safe → reject `LockDisposedError`
 * 3. resolve 携带 awaited 真实首值；EntryFactory 在 resolve 后调用 `entry.applyRemote(awaited)`
 *    写入 `dataRef.current`
 * 4. 占位 `firstValue` 仅在 `dataReadyPromise` resolve 之前作为 `dataRef.current` 的填充值；
 *    调用方需在 await 之后才把元组对外暴露 —— 占位永不被用户访问
 */
function buildPendingEntryData<T extends object>(id: string, source: PromiseLike<T>): EntryInitialData<T> {
  const ready = withResolvers<T>();
  Promise.resolve(source).then(
    (awaited) => {
      // 在 resolve 通道内做 JSON 安全校验，校验失败转 reject（与原始 reject 同形态）
      try {
        assertJsonSafeInput(awaited, 'lockData getValue() result');
      } catch (validationError) {
        ready.reject(createFailedInitError(id, validationError));
        return;
      }
      ready.resolve(awaited);
    },
    (rejectReason) => {
      ready.reject(createFailedInitError(id, rejectReason));
    },
  );
  // attach no-op .catch 仅抑制 Node 的 UnhandledPromiseRejectionWarning；
  // 不影响原 Promise 的 reject 链（factory 层 await 仍能拿到错误）
  ready.promise.catch(suppressUnhandled);
  return {
    // 占位：dataRef.current 在 await 期间持有此值，但调用方在 resolve 前不会暴露 view
    // 给用户；resolve 后 applyRemote(awaited) 会立刻覆盖占位
    firstValue: {} as T,
    dataReadyPromise: ready.promise,
  };
}

/** PromiseLike 判定：避免引入 verify 的 isPromiseLike 依赖（已从 imports 删除） */
function isPromiseLikeValue<V>(value: V | PromiseLike<V>): value is PromiseLike<V> {
  return value !== null && typeof value === 'object' && typeof (value as PromiseLike<V>).then === 'function';
}

function suppressUnhandled(): void {
  /* no-op：抑制 Node UnhandledPromiseRejectionWarning，不影响原 Promise reject 传播 */
}

/**
 * 构造 LockDisposedError，cause 字段携带 getValue 原始 reject 原因
 *
 * 由本模块（同步抛错路径）+ Actions 层（异步 dataReadyPromise reject 路径）共同调用，
 * 对外统一抛 LockDisposedError。
 *
 * 放在本模块的理由：`LockDisposedError + cause` 的错误格式是 Registry 对外的数据契约
 * （RFC 规定"错误 cause 字段携带 getValue 原始 reject 原因"）—— 让同一处代码产出
 * 同步路径与异步路径下的 LockDisposedError，避免契约漂移
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

export type { Entry, EntryFactory, EntryFactoryContext, EntryInitialData, FrozenInitOptions, InstanceRegistry };
export { createFailedInitError, createInstanceRegistry, freezeInitOptions, prepareEntryData };
