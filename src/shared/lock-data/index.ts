import { lockData as lockDataImpl } from './core/entry';
import type { LockDataOptions, LockDataResult, LockDataTuple } from './types';

/**
 * 创建一个带锁的数据容器
 *
 * 三重载签名对应 RFC L112-155 定义的三条初始化路径：
 * - 分支 A：同步初始化（无 getValue 且 syncMode 为 'none' / undefined）→ 直接返回 `LockDataTuple<T>`
 * - 分支 B：异步初始化（getValue 返回 Promise）→ 返回 `Promise<LockDataTuple<T>>`
 * - 分支 C：异步初始化（syncMode 为 'storage-authority'，首次 pull 本地权威副本）
 *   → 返回 `Promise<LockDataTuple<T>>`
 *
 * 返回元组：
 * - 第一个元素：深只读视图（ReadonlyView<T>），业务只能读取不能直接写入
 * - 第二个元素：actions（update / replace / dispose / 等），通过事务 API 修改数据
 *
 * ### 分支 A：同步初始化
 *
 * ```ts
 * const [view, actions] = lockData({ count: 0 });
 * view.count; // 0
 * await actions.update(draft => { draft.count = 1; });
 * ```
 *
 * ### 分支 B：异步初始化（getValue 返回 Promise）
 *
 * ```ts
 * const [view, actions] = await lockData<User>(undefined, {
 *   getValue: () => fetch('/api/user').then(r => r.json()),
 * });
 * ```
 *
 * ### 分支 C：异步初始化（syncMode storage-authority）
 *
 * ```ts
 * const [view, actions] = await lockData({ count: 0 }, {
 *   id: 'shared-counter',
 *   syncMode: 'storage-authority',
 * });
 * ```
 */
// 分支 A：同步初始化
function lockData<T extends object>(
  data: T,
  options?: LockDataOptions<T> & {
    getValue?: undefined;
    syncMode?: 'none' | undefined;
  },
): LockDataTuple<T>;

// 分支 B：异步初始化（getValue 返回 Promise）
function lockData<T extends object>(
  data: T | undefined,
  options: LockDataOptions<T> & { getValue: () => Promise<T> },
): Promise<LockDataTuple<T>>;

// 分支 C：异步初始化（syncMode storage-authority）
function lockData<T extends object>(
  data: T,
  options: LockDataOptions<T> & { syncMode: 'storage-authority' },
): Promise<LockDataTuple<T>>;

// 实现签名：与 core/entry.ts::lockData 签名一致的宽联合
// 类型桥接：core 层内部视角返回 `LockDataResult<T>`（裸 T），公开契约返回 `LockDataTuple<T>`
// （ReadonlyView<T>）—— 运行时完全一致（都是同一个 readonly Proxy），仅类型层断言
function lockData<T extends object>(
  data: T | undefined,
  options?: LockDataOptions<T>,
): LockDataTuple<T> | Promise<LockDataTuple<T>> {
  const result = lockDataImpl<T>(data, options);
  if (result instanceof Promise) {
    return result as Promise<LockDataResult<T>> as unknown as Promise<LockDataTuple<T>>;
  }
  return result as unknown as LockDataTuple<T>;
}

// ---------------------------------------------------------------------------
// 公开导出
// ---------------------------------------------------------------------------

export { NEVER_TIMEOUT } from './constants';
export {
  InvalidOptionsError,
  LockAbortedError,
  LockDisposedError,
  LockRevokedError,
  LockTimeoutError,
  ReadonlyMutationError,
} from './errors';
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
  LockDataTuple,
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
} from './types';
export { lockData };
