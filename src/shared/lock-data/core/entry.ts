/**
 * lockData 主入口：组装 Registry / Adapters / Driver / Authority / Actions / ReadonlyView
 *
 * 对应 RFC.md「架构分层」「InstanceRegistry」「能力检测与降级」章节（L612-760）。
 *
 * 流程总览：
 *   lockData(initial, options)
 *     ├─ 参数校验（id / signal / syncMode / listeners）
 *     ├─ 分派：id 存在 → defaultRegistry.getOrCreateEntry(id, options, factory)
 *     │        id 缺失 → 直接执行 factory（无 Registry 跟踪）
 *     │
 *     ├─ factory 内部（entryFactory）：
 *     │    ├─ pickDefaultAdapters(options.adapters)
 *     │    ├─ resolveInitialData(options, initial, logger, onStateChange)
 *     │    ├─ pickDriver({ adapters, options, id })
 *     │    ├─ 构造 Entry 骨架（authority: null 初值）
 *     │    ├─ 若 syncMode='storage-authority' 且 id 存在 → 构造 StorageAuthority：
 *     │    │   ├─ host = entry（Entry 的 data/rev/lastAppliedRev/epoch 字段
 *     │    │   │           恰好匹配 StorageAuthorityHost 契约）
 *     │    │   ├─ applySnapshot = applyInPlace
 *     │    │   ├─ emitSync / emitCommit → fanoutSync / fanoutCommit
 *     │    │   ├─ 通过构造期 mutable 写回 entry.authority（类型层标记为 readonly，
 *     │    │   │   运行时仅在 factory 构造期允许一次性写入）
 *     │    │   └─ registerTeardown(authority.dispose) + 发起 authority.init()
 *     │    └─ 把 authority.init() 合成进 dataReadyPromise（确保就绪时两者都已完成）
 *     │
 *     ├─ createActions({ entry, options, releaseFromRegistry })
 *     ├─ createReadonlyView(entry.data)
 *     └─ 返回：dataReadyPromise === null ? [view, actions] : Promise<[view, actions]>
 *
 * 职责边界：
 * - 参数校验只做"结构层"（类型 / 非空）；语义合法性（如 timeout < 0）由下游模块负责
 * - Entry 构造期的部分字段（authority）是"一次性 readonly"：仅在 factory 内写入一次，
 *   Entry 对外暴露后字段视为 frozen；用 `Entry<T> & { authority: ... }` 的 mutable
 *   视图收敛到 factory 闭包内，避免外部代码误改
 */

import { isObject, isString } from '@/shared/utils/verify';
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
import { createActions } from './actions';
import { fanoutCommit, fanoutSync } from './fanout';
import { createReadonlyView } from './readonly-view';
import {
  applyInPlace,
  createFailedInitError,
  createInstanceRegistry,
  type Entry,
  type EntryFactory,
  type EntryFactoryContext,
  type InstanceRegistry,
  resolveInitialData,
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
  if (defaultRegistry === null) {
    defaultRegistry = createInstanceRegistry();
  }
  return defaultRegistry;
}

/**
 * 仅用于测试：重置进程级 Registry
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
function extractValidId(options: LockDataOptions<unknown>): string | undefined {
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
 * 走 logger.warn（RFC L740 "权威副本不可用 → 退化为同进程共享"），返回 null Promise
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
  if (authorityAdapter === null && channelAdapter === null && sessionStoreAdapter === null) {
    adapters.logger.warn(
      `[lockData] syncMode='storage-authority' requested on id=${id} but no authority/channel/sessionStore adapter is available; fallback to in-process sharing only`,
    );
    return null;
  }

  const guard: FanoutGuard = { disposed: false };

  // Entry 本身满足 StorageAuthorityHost 契约：同时具备 data/rev/lastAppliedRev/epoch 字段
  const authority = createStorageAuthority<T>({
    host: mutableEntry,
    authority: authorityAdapter,
    channel: channelAdapter,
    sessionStore: sessionStoreAdapter,
    persistence,
    sessionProbeTimeout: options.sessionProbeTimeout ?? DEFAULT_SESSION_PROBE_TIMEOUT,
    logger: adapters.logger,
    clone: adapters.clone,
    applySnapshot: applyInPlace,
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
  if (dataReady !== null && authorityReady !== null) {
    return Promise.all([dataReady, authorityReady]).then(() => undefined);
  }
  return dataReady ?? authorityReady;
}

// ---------------------------------------------------------------------------
// EntryFactory：被 Registry / 无 id 路径复用
// ---------------------------------------------------------------------------

/**
 * 构造 EntryFactory —— 承担 adapters / driver / initialData / authority 四件事的组装
 *
 * 传入 `initial` 作为闭包参数：Registry 路径下 `getOrCreateEntry` 命中已有 Entry 时
 * 不会调用 factory，initial 被忽略；首次创建才会应用
 */
function createEntryFactory<T extends object>(initial: T | undefined): EntryFactory<T> {
  return (id, options, ctx: EntryFactoryContext): Entry<T> => {
    const adapters = pickDefaultAdapters<T>(options.adapters);

    // Entry 引用通过 closure 变量向前传递给 onStateChange；初始为 null，构造完立即赋值
    // 不会出现"骨架未构造时触发 onStateChange" —— resolveInitialData 的 failed 态
    // 已经通过返回的 InitialDataPatch.dataReadyState / dataReadyError 字段同步暴露
    let entryRef: MutableEntry<T> | null = null;
    const onStateChange = (state: 'pending' | 'ready' | 'failed', error: unknown): void => {
      if (entryRef === null) {
        return;
      }
      entryRef.dataReadyState = state;
      entryRef.dataReadyError = error;
    };

    const initialPatch = resolveInitialData(options, initial, adapters.logger, onStateChange);
    const driver = pickDriver<T>({ adapters, options, id });
    const listenersSet = new Set<LockDataListeners<T>>();
    if (isObject(options.listeners)) {
      listenersSet.add(options.listeners);
    }

    const mutableEntry: MutableEntry<T> = {
      id,
      data: initialPatch.data,
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
      dataReadyPromise: initialPatch.dataReadyPromise,
      registerTeardown: ctx.registerTeardown,
      refCount: 1,
      rev: 0,
      lastAppliedRev: 0,
      epoch: null,
      dataReadyState: initialPatch.dataReadyState,
      dataReadyError: initialPatch.dataReadyError,
    };
    entryRef = mutableEntry;

    // syncMode 分派：'storage-authority' 且 id 存在才启用
    const syncMode = normalizeSyncMode(options.syncMode);
    const authorityReady =
      syncMode === 'storage-authority' ? attachAuthority(mutableEntry, options, adapters, id) : null;

    // 合成最终的 dataReadyPromise（构造期允许覆盖 readonly 字段）
    mutableEntry.dataReadyPromise = mergeReadyPromises(initialPatch.dataReadyPromise, authorityReady);

    return mutableEntry;
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * lockData 主入口
 *
 * 返回值类型：
 * - 数据同步就绪（未提供 getValue / getValue 同步返回 / 未启用 authority）→ `readonly [T, LockDataActions<T>]`
 * - 异步就绪（getValue 返回 Promise 或 syncMode='storage-authority'）→ `Promise<readonly [T, LockDataActions<T>]>`
 *
 * 初始化失败（getValue reject / getValue 同步抛错）时：
 * - 同步路径：抛 `LockDisposedError`
 * - 异步路径：返回的 Promise reject `LockDisposedError`（cause 携带原始错误）
 *
 * id 冲突：同 id 多次调用 lockData 复用同一份 Entry（data/driver/adapters/authority 共享），
 * 传入的 `newInitial` 自第二次起被忽略（RFC L663）；非 listeners 字段冲突走 logger.warn
 */
function lockData<T extends object>(
  initial: T | undefined,
  options?: LockDataOptions<T>,
): LockDataResult<T> | Promise<LockDataResult<T>> {
  const normalizedOptions: LockDataOptions<T> = options || {};
  const id = extractValidId(normalizedOptions);
  const factory = createEntryFactory<T>(initial);

  // 分派 Registry / 无 id 路径；无 id 场景用一次性 ctx（teardowns 在实例 dispose 时逆序运行）
  const { entry, releaseFromRegistry } =
    id === undefined
      ? acquireStandalone<T>(normalizedOptions, factory)
      : acquireFromRegistry<T>(id, normalizedOptions, factory);

  const actions = createActions<T>({
    entry,
    options: normalizedOptions,
    releaseFromRegistry,
  });
  const view = createReadonlyView(entry.data);

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
 * 用占位 id `__local__` 满足 Entry.id 非空约束（纯本地锁不会和 Registry 冲突）；
 * driver 层已通过 `id === undefined` 识别本地场景并走 LocalLockDriver
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

  const entry = factory('__local__', options, { registerTeardown });

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
 * - 同步就绪 → 立即检查 `dataReadyState === 'failed'`（getValue 同步抛错路径）；
 *   failed 时抛 LockDisposedError
 * - 异步就绪 → 返回 Promise；resolve 到元组，reject 转为 LockDisposedError
 */
function finalizeResult<T extends object>(
  entry: Entry<T>,
  view: T,
  actions: LockDataActions<T>,
): LockDataResult<T> | Promise<LockDataResult<T>> {
  const tuple: LockDataResult<T> = [view, actions] as const;

  if (entry.dataReadyPromise === null) {
    if (entry.dataReadyState === 'failed') {
      // 同步 getValue 抛错：RFC L684 要求立即抛 LockDisposedError
      // 在 throwError 之前先触发 actions.dispose 保证资源不泄漏
      void actions.dispose();
      throw createFailedInitError(entry.id, entry.dataReadyError);
    }
    return tuple;
  }

  return entry.dataReadyPromise.then(
    () => tuple,
    (error: unknown) => {
      // authority.init 失败已被 attachAuthority 内部 warn + swallow；
      // 这里 reject 只来自 dataReadyPromise（getValue 异步 reject），
      // 统一包装为 LockDisposedError
      void actions.dispose();
      throw createFailedInitError(entry.id, error);
    },
  );
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export { __resetDefaultRegistry, lockData };
