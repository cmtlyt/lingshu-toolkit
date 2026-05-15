/**
 * lockData 主入口：组装 Registry / Adapters / Driver / Authority / Actions / ReadonlyView
 *
 * 对应 RFC.md「架构分层」「InstanceRegistry」「能力检测与降级」章节。
 *
 * 流程总览（wrapper 方案 + 单参数 API）：
 *   lockData(options)
 *     ├─ 顶层数组运行时拒绝（assertNotTopLevelArray，类型层已禁止；防擦除）
 *     ├─ 参数校验（id / getValue / syncMode / listeners 等结构层）
 *     ├─ 分派：id 存在 → defaultRegistry.getOrCreateEntry(id, options, factory)
 *     │        id 缺失 → 直接执行 factory（无 Registry 跟踪）
 *     │
 *     ├─ factory 内部（entryFactory）：
 *     │    ├─ pickDefaultAdapters(options.adapters)
 *     │    ├─ prepareEntryData(id, options) —— 同步抛错走 LockDisposedError；
 *     │    │   异步返回 { firstValue, dataReadyPromise }（首值 resolve 后由
 *     │    │   `applyRemote` 写入 dataRef.current）
 *     │    ├─ pickDriver({ adapters, options, id })
 *     │    ├─ 构造 Entry 骨架（dataRef = { current: firstValue }；authority: null）
 *     │    ├─ 若 syncMode='storage-authority' 且 id 存在 → 构造 StorageAuthority：
 *     │    │   ├─ host = entry（提供 dataRef / applyRemote / rev / lastAppliedRev / epoch）
 *     │    │   ├─ emitSync / emitCommit → fanoutSync / fanoutCommit
 *     │    │   └─ registerTeardown(authority.dispose) + 发起 authority.init()
 *     │    └─ 把 authority.init() 合成进 dataReadyPromise
 *     │
 *     ├─ createActions({ entry, options, releaseFromRegistry })
 *     ├─ createReadonlyView(entry.dataRef) —— wrapper Proxy；trap 重定向到 dataRef.current
 *     └─ 返回：dataReadyPromise === null ? [view, actions] : Promise<[view, actions]>
 *
 * 职责边界：
 * - 参数校验只做"结构层"（类型 / 非空）；语义合法性（如 timeout < 0）由下游模块负责
 * - Entry 构造期的部分字段（authority）是"一次性 readonly"：仅在 factory 内写入一次，
 *   Entry 对外暴露后字段视为 frozen；用 mutable 视图收敛到 factory 闭包内
 * - dataRef.current 在异步 resolve / commit / applyRemote 时由内部重新赋值；
 *   wrapper Proxy view 自动看到最新值
 */

import { isNull, isObject, isString, isUndef } from '@/shared/utils';
import { pickDefaultAdapters, type ResolvedAdapters } from '../adapters/index';
import { createStorageAuthority } from '../authority/index';
import { DEFAULT_SESSION_PROBE_TIMEOUT } from '../constants';
import { pickDriver } from '../drivers/index';
import type {
  CommitSource,
  LockDataActions,
  LockDataListeners,
  LockDataMutation,
  LockDataOptions,
  LockDataResult,
  Persistence,
  SyncMode,
  SyncSource,
} from '../types';
import { cloneByJson } from '../utils/json-safe';
import { createActions } from './actions';
import { fanoutCommit, fanoutSync } from './fanout';
import { createReadonlyView } from './readonly-view';
import {
  createInstanceRegistry,
  type Entry,
  type EntryFactory,
  type EntryFactoryContext,
  type InstanceRegistry,
  prepareEntryData,
} from './registry';

// ---------------------------------------------------------------------------
// 进程单例 Registry
// ---------------------------------------------------------------------------

/**
 * 进程级默认 Registry；同 id 多实例在此共享
 *
 * 懒初始化：首次 `lockData({ id })` 调用时创建；测试可通过 `__resetDefaultRegistry`
 * 拿到独立 Registry 做隔离（生产代码不应使用）
 */
let defaultRegistry: InstanceRegistry | null = null;

function getDefaultRegistry(): InstanceRegistry {
  if (isNull(defaultRegistry)) {
    defaultRegistry = createInstanceRegistry();
  }
  return defaultRegistry;
}

/**
 * @internal 仅供测试使用，不通过 index.ts 公开导出
 *
 * 重置进程级 Registry，用于测试间隔离（模拟"新 Tab / 新进程"场景）
 *
 * 注意：不会清理已有 Entry 的 teardown；调用者需自行确保没有活跃的 Entry 引用
 */
function __resetDefaultRegistry(): void {
  defaultRegistry = null;
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

/**
 * 提取合法的 id：非空字符串才返回，其他形态返回 undefined
 *
 * id 非字符串不抛错 —— 视为"纯本地只读锁"分支（RFC L107）；类型层用户已经受约束
 */
function extractValidId<T>(options: LockDataOptions<T>): string | undefined {
  const { id } = options;
  return isString(id) && id.length > 0 ? id : undefined;
}

/**
 * 规范化 syncMode：非法值 warn 并降级为 'none'
 *
 * RFC L643 / L741：仅 'none' 与 'storage-authority' 合法；其他一律降级
 */
function normalizeSyncMode(value: SyncMode | undefined): SyncMode {
  if (value === 'storage-authority') {
    return 'storage-authority';
  }
  return 'none';
}

function normalizePersistence(value: Persistence | undefined): Persistence {
  // 默认 'session'；非法值降级到 'session'（最常见的安全选项）
  return value === 'persistent' ? 'persistent' : 'session';
}

// ---------------------------------------------------------------------------
// Entry 构造
// ---------------------------------------------------------------------------

/**
 * 构造期的可变 Entry 视图
 *
 * 在 factory 闭包内把全部字段视为可写，便于 `onStateChange` 写回状态 /
 * authority 构造后回写 authority 引用；返回给调用方后视为 frozen
 */
type MutableEntry<T extends object> = {
  -readonly [K in keyof Entry<T>]: Entry<T>[K];
};

/**
 * 注册 authority 自 emit 回调的 teardown 守卫容器
 *
 * 生命周期：Entry 销毁时置 `disposed=true`，fanout 回调即使被滞后触发也直接 no-op
 */
interface FanoutGuard {
  disposed: boolean;
}

/**
 * emitCommit 事件体；由 StorageAuthority 在 onCommitSuccess 内部构造并透传（已包含 rev）
 */
interface AuthorityCommitEvent<T> {
  readonly source: CommitSource;
  readonly token: string;
  readonly rev: number;
  readonly mutations: readonly LockDataMutation[];
  readonly snapshot: T;
}

/** emitSync 事件体；由 StorageAuthority 在 applyAuthorityIfNewer 内部构造并透传 */
interface AuthoritySyncEvent<T> {
  readonly source: SyncSource;
  readonly rev: number;
  readonly snapshot: T;
}

function buildEmitCommit<T extends object>(
  entry: Entry<T>,
  guard: FanoutGuard,
): (event: AuthorityCommitEvent<T>) => void {
  return (event) => {
    if (guard.disposed) {
      return;
    }
    fanoutCommit(entry.listenersSet, event, entry.adapters.logger);
  };
}

function buildEmitSync<T extends object>(entry: Entry<T>, guard: FanoutGuard): (event: AuthoritySyncEvent<T>) => void {
  return (event) => {
    if (guard.disposed) {
      return;
    }
    fanoutSync(entry.listenersSet, event, entry.adapters.logger);
  };
}

/**
 * 构造 StorageAuthority 并写回 entry.authority；返回 init Promise
 *
 * 仅在 `syncMode === 'storage-authority' && id` 时调用；authority 构造失败时
 * 走 logger.warn（RFC「权威副本不可用 → 退化为同进程共享」），返回 null Promise
 *
 * wrapper 方案差异：
 * - 不再注入 `applySnapshot` 钩子（authority 通过 `host.applyRemote(next)` 完成原子覆写）
 * - 不再注入 `clone` 函数（authority 内部走 JSON 拷贝隔离）
 */
function attachAuthority<T extends object>(
  mutableEntry: MutableEntry<T>,
  options: LockDataOptions<T>,
  adapters: ResolvedAdapters<T>,
  id: string,
): Promise<void> | null {
  const persistence = normalizePersistence(options.persistence);
  const authorityAdapter = adapters.getAuthority({ id });
  const channelAdapter = adapters.getChannel({ id, channel: 'session' });
  const sessionStoreAdapter = adapters.getSessionStore({ id });

  // 全不可用 → logger.warn + 退化为同进程共享（返回 null 意味着"无 authority，commit 事件由 Actions 直接 fanout"）
  if (isNull(authorityAdapter) && isNull(channelAdapter) && isNull(sessionStoreAdapter)) {
    adapters.logger.warn(
      `[lockData] syncMode='storage-authority' requested on id=${id} but no authority/channel/sessionStore adapter is available; fallback to in-process sharing only`,
    );
    return null;
  }

  const guard: FanoutGuard = { disposed: false };

  // Entry 本身满足 StorageAuthorityHost 契约：同时具备 dataRef / applyRemote /
  // rev / lastAppliedRev / epoch 字段
  const authority = createStorageAuthority<T>({
    host: mutableEntry,
    authority: authorityAdapter,
    channel: channelAdapter,
    sessionStore: sessionStoreAdapter,
    persistence,
    sessionProbeTimeout: options.sessionProbeTimeout ?? DEFAULT_SESSION_PROBE_TIMEOUT,
    logger: adapters.logger,
    emitSync: buildEmitSync(mutableEntry, guard),
    emitCommit: buildEmitCommit(mutableEntry, guard),
  });

  mutableEntry.authority = authority;
  // teardowns 逆序执行：先 authority.dispose（仍能读 guard.disposed===false），再翻 guard
  // 这样 authority 内部 dispose 时若还有滞后 emit 入队，guard 翻转前仍会走正常 fanout
  mutableEntry.registerTeardown(() => authority.dispose());
  mutableEntry.registerTeardown(() => {
    guard.disposed = true;
  });

  // 通过 init Promise 把 resolveEpoch + 初次 pull 合并到 dataReadyPromise
  return authority.init().then(
    () => {
      /* swallow result；epoch 已由 authority 内部写回 entry.epoch */
    },
    (error) => {
      // authority.init 失败不阻塞 lockData 的返回 —— 只 warn，authority 自身
      // 在 disposed=true 之后所有方法都是 no-op，不会污染后续 commit / pull
      adapters.logger.warn(`[lockData] StorageAuthority.init failed on id=${id}`, error);
    },
  );
}

/**
 * 合成 dataReadyPromise + authority.init() 为统一的就绪 Promise
 *
 * 两个 Promise 至少一个非 null 时返回合成结果；都为 null 时返回 null
 */
function mergeReadyPromises(
  dataReady: Promise<void> | null,
  authorityReady: Promise<void> | null,
): Promise<void> | null {
  if (!(isNull(dataReady) || isNull(authorityReady))) {
    return Promise.all([dataReady, authorityReady]).then(() => undefined);
  }
  return dataReady ?? authorityReady;
}

// ---------------------------------------------------------------------------
// EntryFactory：被 Registry / 无 id 路径复用
// ---------------------------------------------------------------------------

/**
 * 构造 `applyRemote(next: T)` 闭包
 *
 * 契约（StorageAuthorityHost.applyRemote 同款）：
 * - 入参 `next` 必须是已通过 `assertJsonSafeInput` 的 JSON 安全值
 *   （由调用方在更早的边界完成 fail-fast，本函数到达时已确定为 JSON 安全）
 * - 内部走 `cloneByJson(next)` 拷贝隔离后赋给 `dataRef.current`
 * - 不触发 emit / commit / fanout —— 这些由 authority 外层 emitSync 负责
 *
 * applyRemote 是 wrapper 方案下「authority 远程同步 / 异步 getValue resolve」共用的
 * 单一入口，确保所有进入 `dataRef.current` 的值都经过同一层 JSON 拷贝隔离
 */
function buildApplyRemote<T extends object>(dataRef: { current: T }): (next: T) => void {
  return (next) => {
    dataRef.current = cloneByJson(next);
  };
}

/**
 * 构造 EntryFactory —— 承担 adapters / driver / initialData / authority 四件事的组装
 */
function createEntryFactory<T extends object>(): EntryFactory<T> {
  return (id, lockId, options, ctx: EntryFactoryContext): Entry<T> => {
    const adapters = pickDefaultAdapters<T>(options.adapters);

    // 同步抛错（getValue 同步抛 / 顶层数组 / 非 JSON-safe 值）会从这里直接向上抛 LockDisposedError /
    // InvalidOptionsError / TypeError —— Entry 不构造，不进 registry
    // 异步路径返回的 firstValue 是占位空对象；resolve 时通过 dataReadyPromise 携带 awaited 真实值，
    // 由 EntryFactory 调用 applyRemote(awaited) 写入 dataRef.current（占位永不暴露给用户）
    const initialData = prepareEntryData<T>(id, options);

    // 用 lockId 而非 id 喂 pickDriver：standalone 路径 lockId === undefined，
    // pickDriver 内部 `!isString(id) || id.length === 0` 短路命中 LocalLockDriver；
    // 不会被 mode='web-locks' 等强制起跨 Tab driver
    const driver = pickDriver<T>({ adapters, options, id: lockId });
    const listenersSet = new Set<LockDataListeners<T>>();
    // 用 isObject 严格校验：过滤 null / undefined / 字符串 / 数字等类型擦除路径下的脏值，
    // 与 registry.ts `getOrCreateEntry` 命中已有 Entry 时的 `isObject(listeners)` 保持一致
    if (isObject(options.listeners)) {
      listenersSet.add(options.listeners);
    }

    // 稳定 dataRef wrapper：引用本身在 Entry 生命周期内永不变更；
    // 所有「重新赋值」都通过修改 .current 完成（commit / applyRemote / 异步 resolve）
    const dataRef: { current: T } = { current: initialData.firstValue };
    const applyRemote = buildApplyRemote<T>(dataRef);

    const mutableEntry: MutableEntry<T> = {
      id,
      lockId,
      dataRef,
      driver,
      adapters,
      authority: null,
      listenersSet,
      initOptions: Object.freeze({
        timeout: options.timeout,
        mode: options.mode,
        syncMode: options.syncMode,
        persistence: options.persistence,
        sessionProbeTimeout: options.sessionProbeTimeout,
      }),
      dataReadyPromise: null,
      registerTeardown: ctx.registerTeardown,
      refCount: 1,
      rev: 0,
      lastAppliedRev: 0,
      epoch: null,
      applyRemote,
    };

    // 异步路径：dataReadyPromise resolve 时携带 awaited 真实首值，applyRemote 写入 dataRef.current
    // 仅一次 await，无需重复调用用户的 getValue
    const dataReadyAfterApply = attachAsyncFirstValue(applyRemote, initialData.dataReadyPromise);

    // syncMode 分派：'storage-authority' 且 **真实 id 存在**（lockId !== undefined）才启用
    // 注意必须用 lockId 判断 —— Entry.id 在 standalone 路径是占位 '__local__'（非空字符串），
    // 用它判断会让 standalone + storage-authority 错误地启用 authority、所有无 id 实例
    // 落到同一个 '__local__' 命名空间下互相覆盖。详见 fixes/standalone-id-leak.md
    const syncMode = normalizeSyncMode(options.syncMode);
    const authorityReady =
      syncMode === 'storage-authority' && lockId !== undefined
        ? attachAuthority(mutableEntry, options, adapters, lockId)
        : null;

    // 合成最终的 dataReadyPromise（构造期允许覆盖 readonly 字段）
    mutableEntry.dataReadyPromise = mergeReadyPromises(dataReadyAfterApply, authorityReady);

    return mutableEntry;
  };
}

/**
 * 异步路径：resolve 后通过 `applyRemote` 把 awaited 真实首值写入 `dataRef.current`
 *
 * 契约：
 * - 同步路径（initialData.dataReadyPromise === null）：firstValue 已是真实首值（经
 *   `prepareEntryData` 内部 `assertJsonSafeInput` + `cloneByJson`），无需 applyRemote 处理 → 返回 null
 * - 异步路径：消费 `prepareEntryData` 携带 awaited 的 Promise<T>；resolve 时调用
 *   `applyRemote(awaited)` 写入 `dataRef.current`；reject 直接透传 `LockDisposedError`
 *   （`prepareEntryData` 已把校验失败 / 原始 reject 都包装为 LockDisposedError）
 *
 * 注意：本函数不再二次调用 `options.getValue()` —— `prepareEntryData` 已完成单次 await + 校验，
 * awaited 真实值通过 Promise 通道直接透传过来；用户的 getValue **不要求幂等**
 */
function attachAsyncFirstValue<T extends object>(
  applyRemote: (next: T) => void,
  dataReadyPromise: Promise<T> | null,
): Promise<void> | null {
  if (isNull(dataReadyPromise)) {
    return null;
  }
  return dataReadyPromise.then((awaited) => {
    applyRemote(awaited);
  });
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * lockData 主入口（单参数 + getValue 必传）
 *
 * 返回值类型：
 * - getValue 同步返回 + 未启用 authority → `readonly [T, LockDataActions<T>]`
 * - getValue 返回 Promise 或 syncMode='storage-authority' → `Promise<readonly [T, LockDataActions<T>]>`
 *
 * 初始化失败（getValue reject / getValue 同步抛错）时：
 * - 同步路径：抛 `LockDisposedError`（getValue 同步抛错时 prepareEntryData 直接向上抛）
 * - 异步路径：返回的 Promise reject `LockDisposedError`（cause 携带原始错误）
 *
 * id 冲突：同 id 多次调用 lockData 复用同一份 Entry（dataRef / driver / adapters / authority 共享），
 * 自第二次起 getValue 不被重新执行（首值由首次调用产出）；非 listeners 字段冲突走 logger.warn
 */
function lockData<T extends object>(options: LockDataOptions<T>): LockDataResult<T> | Promise<LockDataResult<T>> {
  const id = extractValidId(options);
  const factory = createEntryFactory<T>();

  // 分派 Registry / 无 id 路径；无 id 场景用一次性 ctx（teardowns 在实例 dispose 时逆序运行）
  // prepareEntryData 内的同步抛错（getValue 同步抛 / 校验失败）会从这里直接向上抛
  const { entry, releaseFromRegistry } = isUndef(id)
    ? acquireStandalone<T>(options, factory)
    : acquireFromRegistry<T>(id, options, factory);

  const actions = createActions<T>({
    entry,
    options,
    releaseFromRegistry,
  });
  const view = createReadonlyView<T>(entry.dataRef);

  return finalizeResult<T>(entry, view, actions);
}

/**
 * 从进程单例 Registry 获取 Entry；同 id 复用，首次创建走 factory
 */
function acquireFromRegistry<T extends object>(
  id: string,
  options: LockDataOptions<T>,
  factory: EntryFactory<T>,
): { entry: Entry<T>; releaseFromRegistry: () => void } {
  const registry = getDefaultRegistry();
  const entry = registry.getOrCreateEntry<T>(id, options, factory);
  const release = (): void => {
    registry.releaseEntry<T>(id, options.listeners);
  };
  return { entry, releaseFromRegistry: release };
}

/**
 * 无 id 路径：直接执行 factory；teardowns 在 dispose 时运行（Registry 不介入）
 *
 * 入参拆分：
 * - 第一个参数 `'__local__'` 写入 `Entry.id`（展示用占位），用于日志、错误消息等稳定文本输出
 * - 第二个参数 `undefined` 写入 `Entry.lockId`（语义判定用真实 id）；
 *   下游 `pickDriver` / `attachAuthority` / driver acquire `name` 都以此识别"无真实 id"分支：
 *     - pickDriver 看到 undefined → LocalLockDriver（mode 字段被忽略）
 *     - syncMode='storage-authority' 不会启用 authority
 *     - driver acquire 的 `name` 走 `${LOCK_PREFIX}:__local__` 占位
 *
 * 详见 `src/shared/lock-data/fixes/standalone-id-leak.md`
 */
function acquireStandalone<T extends object>(
  options: LockDataOptions<T>,
  factory: EntryFactory<T>,
): { entry: Entry<T>; releaseFromRegistry: () => void } {
  const teardowns: Array<() => void> = [];
  const alive = { value: true };
  const registerTeardown = (teardown: () => void): void => {
    if (!alive.value) {
      return;
    }
    teardowns.push(teardown);
  };

  const entry = factory('__local__', undefined, options, { registerTeardown });

  const release = (): void => {
    if (!alive.value) {
      return;
    }
    alive.value = false;
    // 逆序执行 teardowns + driver.destroy；异常隔离到 logger.warn
    for (let i = teardowns.length - 1; i >= 0; i--) {
      try {
        teardowns[i]();
      } catch (error) {
        entry.adapters.logger.warn('[lockData] standalone teardown threw', error);
      }
    }
    teardowns.length = 0;
    try {
      entry.driver.destroy();
    } catch (error) {
      entry.adapters.logger.warn('[lockData] standalone driver.destroy threw', error);
    }
  };
  return { entry, releaseFromRegistry: release };
}

/**
 * 根据 `entry.dataReadyPromise` 决定同步返回还是 Promise 返回
 *
 * 简化说明（极简方案）：
 * - dataReadyState / dataReadyError 字段已删除；同步抛错路径在 prepareEntryData 内
 *   直接抛 LockDisposedError（Entry 不构造 / 不进入 finalizeResult）
 * - 同步就绪 → 直接返回元组
 * - 异步就绪 → 返回 Promise；resolve 到元组，reject 转为 LockDisposedError
 */
function finalizeResult<T extends object>(
  entry: Entry<T>,
  view: T,
  actions: LockDataActions<T>,
): LockDataResult<T> | Promise<LockDataResult<T>> {
  const tuple: LockDataResult<T> = [view, actions] as const;

  if (isNull(entry.dataReadyPromise)) {
    return tuple;
  }

  return entry.dataReadyPromise.then(
    () => tuple,
    (error: unknown) => {
      // dataReadyPromise reject 时，prepareEntryData 已将原始错误包装为 LockDisposedError(cause)；
      // 此处直接透传，避免双重包装导致 cause 链路断裂（cause 应直接指向 getValue 原始错误）
      void actions.dispose();
      throw error;
    },
  );
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export type { FanoutGuard, MutableEntry };
export {
  __resetDefaultRegistry,
  acquireStandalone,
  attachAuthority,
  buildEmitCommit,
  buildEmitSync,
  lockData,
  mergeReadyPromises,
};
