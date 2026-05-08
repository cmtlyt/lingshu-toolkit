import { lockData as lockDataImpl } from './core/entry';
import type { LockDataOptions, LockDataResult, LockDataReturn, LockDataValueShape } from './types';

/**
 * 创建一个带锁的数据容器（**单参数 API + getValue 必传 + 条件类型自动推断返回值**）
 *
 * 单签名 + 严格条件类型契约（对应 RFC.md「§3 核心语义 / §API 签名」+ 决策 #33 §A）：
 * - `getValue: () => T | Promise<T>` 必传 —— 数据来源唯一入口
 * - `T` 必须满足 `LockDataValueShape<T> = T extends readonly unknown[] ? never : T`，
 *   即 **类型层禁止顶层数组**（`lockData<string[]>` 在类型层即被排除为 `never`）
 * - **返回值类型由 `LockDataReturn<T, O>` 条件类型从入参 `O` 直接推断**，无需调用方断言：
 *   1. `O extends { syncMode: 'storage-authority' }` → 必须配 `id: string`，否则编译期 `never`（最严格）
 *   2. 否则若 `ReturnType<O['getValue']> extends Promise<unknown>` → `Promise<LockDataTuple<T>>`
 *   3. 否则 → `LockDataTuple<T>`
 * - 同步抛错 → 同步抛 `LockDisposedError`（Entry 不构造）
 * - 异步 reject → 返回的 Promise reject `LockDisposedError`，`cause` 字段携带原因
 * - 运行时双重 fail-fast：`Array.isArray(awaited)` 拒绝顶层数组（抛 `InvalidOptionsError`），
 *   非 JSON-safe 抛 `InvalidOptionsError`
 *
 * 返回元组：
 * - 第一个元素：深只读视图（`ReadonlyView<T>`，wrapper Proxy 实现），业务只能读取不能直接写入
 * - 第二个元素：actions（`update` / `replace` / `snapshot` / `dispose` 等），通过事务 API 修改数据
 *
 * ### 同步初始化（直接得元组，无需 await / 断言）
 *
 * ```ts
 * const [view, actions] = lockData<{ count: number }>({
 *   getValue: () => ({ count: 0 }),
 * });
 * view.count; // 0
 * await actions.update((draft) => { draft.count = 1; });
 * ```
 *
 * ### 异步初始化（getValue 返回 Promise → 类型自动收窄为 Promise<LockDataTuple<T>>）
 *
 * ```ts
 * const [view, actions] = await lockData<User>({
 *   getValue: () => fetch('/api/user').then((r) => r.json()),
 * });
 * ```
 *
 * ### 跨 Tab 同步（syncMode='storage-authority' 必须配 id，否则编译期报错）
 *
 * ```ts
 * const [view, actions] = await lockData<{ count: number }>({
 *   id: 'shared-counter',
 *   syncMode: 'storage-authority',
 *   getValue: () => ({ count: 0 }),
 * });
 * ```
 */
// 单泛型 + 条件类型：`T` 直接从 `O['getValue']` 的 Awaited 返回值反推，调用方无需显式传任何泛型；
// `const O` 让 `O` 取得字面量类型（含 `syncMode` / `id` / `getValue` 返回类型的精确字面量），
// 是 `LockDataReturn<T, O>` 能正确判定三层条件分支的前提。
//
// 关键设计：约束位置只用 `LockDataOptions<unknown>` 的最弱形状（避免「O 的约束依赖
// `LockDataInfer<O>`、`LockDataInfer<O>` 又依赖 O」的循环推断），`T` 的具体反推与
// 顶层数组禁止校验都通过条件类型在返回值层完成（编译期 fail-fast），不影响 `T` 反推
type LockDataInfer<O> = O extends { getValue: () => infer R }
  ? Awaited<R> extends infer T extends object
    ? T
    : never
  : never;

// 顶层数组禁止：在返回值类型层 fail-fast，把 `T extends readonly unknown[]` 推为 `never`
// 调用方拿到 `never` 元组时无法解构使用，等价于编译期拒绝
type LockDataResolveReturn<O extends object> =
  LockDataValueShape<LockDataInfer<O>> extends infer T extends object ? LockDataReturn<T, O> : never;

function lockData<const O extends LockDataOptions<unknown>>(options: O): LockDataResolveReturn<O> {
  // 类型桥接：core 层内部视角返回 `LockDataResult<T>`（裸 T），公开契约返回 `LockDataTuple<T>`
  // （`ReadonlyView<T>`）—— 运行时完全一致（都是同一个 wrapper Proxy），仅类型层断言。
  // 运行时分支：core/entry.ts 已通过 `entry.dataReadyPromise === null` 决定同步 / 异步；
  // 公开签名只是把这层运行时分支的类型在 LockDataResolveReturn<O> 中显式镜像，无需在此分流
  type InferredValue = LockDataInfer<O> & object;
  const result = lockDataImpl<InferredValue>(options as unknown as LockDataOptions<InferredValue>);
  type ResultType = LockDataResolveReturn<O>;
  if (result instanceof Promise) {
    return result as Promise<LockDataResult<InferredValue>> as unknown as ResultType;
  }
  return result as unknown as ResultType;
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
  CommitEvent,
  CommitSource,
  LockDataActions,
  LockDataAdapters,
  LockDataListeners,
  LockDataMutation,
  LockDataMutationOp,
  LockDataOptions,
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
} from './types';
export { lockData };
