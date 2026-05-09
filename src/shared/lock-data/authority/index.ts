/**
 * StorageAuthority 主类：跨进程权威副本的读写 + 推送 + 拉取统一收口
 *
 * 对应 RFC.md「StorageAuthority（localStorage 权威副本）」章节。
 *
 * 职责边界（与 LockDriver 互不干扰）：
 *   - 权威 snapshot 读写
 *   - 跨 Tab 推送（authority.subscribe）/ 激活时主动拉取（pageshow / visibilitychange）
 *   - 会话纪元（epoch）生命周期管理（首次 resolveEpoch + 常驻 session-probe 响应）
 *   - 与锁调度完全无关（acquire / release / revoke 都不经过此处）
 *
 * 三条读路径共享同一应用流程：
 *   | 触发源                | 时机                            | source              | 数据来源                      |
 *   | --------------------- | ------------------------------- | ------------------- | ---------------------------- |
 *   | acquire 时 pull       | driver.acquire 成功、进入 recipe 前 | 'pull-on-acquire'   | authority.read() 同步读      |
 *   | authority.subscribe   | 其他进程写入触发订阅回调        | 'storage-event'     | 回调直接传入 newValue        |
 *   | 激活时主动 pull       | pageshow / visibilitychange     | 'pageshow' 等       | authority.read() 同步读      |
 *
 * 一条写路径：
 *   commit 成功 → rev++ → authority.write(serialize) → 触发 onCommit
 *
 * wrapper 方案下的契约（对应 fixes/api-getvalue-only-redesign.md §14.2 缺口 2）：
 *   - 不再注入 `applySnapshot` 钩子 —— 远程同步通过 `host.applyRemote(next)` 完成原子覆写，
 *     authority 不感知 wrapper / dataRef 实现细节
 *   - 不再注入 `clone` 函数 —— 内部用 `cloneByJson` 完成 emit 事件的 snapshot 隔离
 *   - 事件触发统一走 `emit` 回调，由调用方接到 listenersFanout
 */

import { isObject, isString } from '@/shared/utils';
import type {
  AuthorityAdapter,
  ChannelAdapter,
  CommitSource,
  LockDataMutation,
  LoggerAdapter,
  Persistence,
  SessionStoreAdapter,
  SyncSource,
} from '../types';
import { cloneByJson } from '../utils/json-safe';
import { type ResolveEpochContext, type ResolveEpochResult, resolveEpoch, subscribeSessionProbe } from './epoch';
import { readIfNewer } from './extract';
import { serializeAuthority } from './serialize';

/**
 * StorageAuthority 宿主契约（Entry 的最小子集）
 *
 * 设计动机：authority 不感知 Entry 完整结构，避免循环依赖；同时通过 `applyRemote` 方法
 * 把"如何写入 dataRef.current"的实现细节封装到 Entry 内部，authority 只负责调用该方法
 *
 * 字段语义：
 * - `applyRemote(next)`：远程同步入口；内部走 `cloneByJson(next)` + 赋值 `dataRef.current`，
 *   与 emit 链解耦（emit 由 authority 自己负责）
 * - `rev` / `lastAppliedRev` 读写双向；`epoch` 由 `StorageAuthority` 内部在首次
 *   `resolveEpoch` 后回写
 */
interface StorageAuthorityHost<T extends object> {
  /**
   * 远程同步入口：把 awaited / 远程 snapshot 写入 `dataRef.current`
   *
   * 调用方语义：authority 拿到远端最新 snapshot 后，先 `host.applyRemote(snapshot)` 完成
   * 内部状态切换，再由 authority 自己 `emitSync(...)` 通知 listener。Entry 内部实现
   * 必须保证 `applyRemote` 走 JSON 拷贝隔离（详见 core/entry.ts buildApplyRemote）
   */
  readonly applyRemote: (next: T) => void;
  /** 单调递增版本号；commit 时 `rev++` */
  rev: number;
  /** 已应用的最大 rev；commit 后同步更新；subscribe 回调时用于去重 */
  lastAppliedRev: number;
  /** 当前 Tab 的会话纪元；首次 resolveEpoch 完成后由此类回写 */
  epoch: string | null;
}

/**
 * StorageAuthority 的构造依赖集合
 *
 * adapters 三件套允许为 null：authority 或 channel 不可用时降级为
 * 对应功能 no-op，保证 lockData 在任何环境下都能跑
 */
interface StorageAuthorityDeps<T extends object> {
  readonly host: StorageAuthorityHost<T>;
  readonly authority: AuthorityAdapter | null;
  readonly channel: ChannelAdapter | null;
  readonly sessionStore: SessionStoreAdapter | null;
  readonly persistence: Persistence;
  readonly sessionProbeTimeout?: number;
  readonly logger: LoggerAdapter;
  /** onSync 事件触发回调；上层接到 listenersFanout */
  readonly emitSync: (event: { source: SyncSource; rev: number; snapshot: T }) => void;
  /** onCommit 事件触发回调；上层接到 listenersFanout */
  readonly emitCommit: (event: {
    source: CommitSource;
    token: string;
    rev: number;
    mutations: readonly LockDataMutation[];
    snapshot: T;
  }) => void;
}

/**
 * StorageAuthority 对外暴露的 API
 */
interface StorageAuthority<T extends object> {
  /**
   * 初始化：resolveEpoch + 常驻 session-probe 响应 + 初次 pull + 订阅推送通道
   *
   * 返回 `Promise<ResolveEpochResult>`；调用方（`core/entry.ts`）会把此 Promise 与
   * getValue Promise 合成后挂到 `Entry.dataReadyPromise` 对外暴露
   *
   * 多次调用 init 是非法的：宿主自行保证只调用一次
   */
  init: () => Promise<ResolveEpochResult>;

  /** 手动拉取（acquire 时使用）：等价于一次 source='pull-on-acquire' 的 readIfNewer + 应用 */
  pullOnAcquire: () => void;

  /**
   * commit 成功后的写路径：`rev++` → `authority.write` → emit onCommit
   *
   * `mutations` 由 Draft 层（`core/draft.ts`）提供；commit 流程为空 mutations 时也可调用
   * `snapshot` 必须是已隔离的独立副本（调用方走 `cloneByJson`，authority.write 之后
   * 宿主可能继续改 dataRef.current，独立副本保证 listener 看到的是 commit 当时的值）
   */
  onCommitSuccess: (event: {
    source: CommitSource;
    token: string;
    mutations: readonly LockDataMutation[];
    snapshot: T;
  }) => void;

  /**
   * 销毁：解绑所有订阅（authority.subscribe / pageshow / visibilitychange / session-probe）
   * + close channel；幂等
   */
  dispose: () => void;
}

/**
 * StorageAuthority 的内部可变状态容器
 *
 * 从 `createStorageAuthority` 中抽离，让生命周期函数（init / pullOnAcquire /
 * onCommitSuccess / dispose）可以作为顶层纯函数独立存在；否则这些函数作为闭包
 * 会让 `createStorageAuthority` 单函数行数超过 biome `noExcessiveLinesPerFunction`
 * 默认阈值（100 行）
 */
interface AuthorityState {
  readonly unsubscribers: Array<() => void>;
  disposed: boolean;
  initialized: boolean;
}

/**
 * 根据远端 raw 应用到 host；三条读路径共享
 *
 * 命中条件 see extract.ts: `readIfNewer`
 *
 * wrapper 方案下：调用 `host.applyRemote(nextSnapshot)` 完成原子覆写，authority 不感知
 * dataRef 实现细节；emitSync 的 snapshot 走 `cloneByJson` 拷贝隔离，避免 listener mutate
 * 影响内部 dataRef.current
 */
function applyAuthorityIfNewer<T extends object>(
  state: AuthorityState,
  deps: StorageAuthorityDeps<T>,
  source: SyncSource,
  raw: string | null,
): void {
  if (state.disposed) {
    return;
  }
  const { host, logger, emitSync } = deps;
  const result = readIfNewer({ lastAppliedRev: host.lastAppliedRev, epoch: host.epoch }, raw);
  if (!result) {
    return;
  }
  // 远端 snapshot 经过 readIfNewer 内部 JSON.parse；JSON-safe 契约下不会出现非对象（顶层数组
  // 已被入口 assertJsonSafeInput 拒绝），但保留 isObject 守卫防御脏数据 / 跨版本兼容
  if (!isObject(result.snapshot)) {
    logger.warn(`[lockData] authority snapshot is not an object (source=${source}), skip apply`);
    return;
  }
  const nextSnapshot = result.snapshot as T;
  try {
    host.applyRemote(nextSnapshot);
  } catch (error) {
    logger.error(`[lockData] host.applyRemote failed (source=${source}, rev=${result.rev})`, error);
    return;
  }
  host.rev = result.rev;
  host.lastAppliedRev = result.rev;
  // 触发 onSync；传出的 snapshot 走 cloneByJson 隔离，避免用户监听器改动内部 dataRef.current
  try {
    emitSync({ source, rev: result.rev, snapshot: cloneByJson(nextSnapshot) });
  } catch (error) {
    logger.error(`[lockData] emitSync listener threw (source=${source})`, error);
  }
}

/**
 * 订阅推送通道：authority.subscribe 触发时，newValue 就是完整 raw
 */
function attachAuthorityPushSubscription<T extends object>(state: AuthorityState, deps: StorageAuthorityDeps<T>): void {
  const { authority } = deps;
  if (!authority) {
    return;
  }
  const unsubscribe = authority.subscribe((newValue) => {
    applyAuthorityIfNewer(state, deps, 'storage-event', newValue);
  });
  state.unsubscribers.push(unsubscribe);
}

/**
 * 订阅激活时 pull：pageshow / visibilitychange → authority.read() + 应用
 *
 * 仅在浏览器环境（`window` / `document` 可用）注册；
 * 非浏览器环境由自定义 AuthorityAdapter.subscribe 在合适时机回调即可
 */
function attachActivationPullSubscription<T extends object>(
  state: AuthorityState,
  deps: StorageAuthorityDeps<T>,
): void {
  const { authority } = deps;
  if (!authority) {
    return;
  }
  // 使用 typeof 守卫（这些是顶级全局变量，未声明时直接访问会 ReferenceError）
  if (typeof globalThis.window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const onPageShow = (event: PageTransitionEvent): void => {
    // 仅在 bfcache 恢复时 pull（e.persisted === true）；普通首次加载不触发（此时走 init 首次 pull）
    if (!event.persisted) {
      return;
    }
    applyAuthorityIfNewer(state, deps, 'pageshow', authority.read());
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') {
      return;
    }
    applyAuthorityIfNewer(state, deps, 'visibilitychange', authority.read());
  };

  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibilityChange);
  state.unsubscribers.push(() => {
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });
}

/**
 * 订阅常驻 session-probe 响应：仅 session 策略 + channel 可用时生效
 */
function attachSessionProbeResponder<T extends object>(state: AuthorityState, deps: StorageAuthorityDeps<T>): void {
  if (deps.persistence !== 'session' || !deps.channel) {
    return;
  }
  const unsubscribe = subscribeSessionProbe(deps.channel, () => deps.host.epoch);
  state.unsubscribers.push(unsubscribe);
}

/**
 * 执行 init 流程：常驻 probe 响应 → resolveEpoch → 推送/激活订阅 → 初次 pull
 */
async function performInit<T extends object>(
  state: AuthorityState,
  deps: StorageAuthorityDeps<T>,
): Promise<ResolveEpochResult> {
  const { host, authority, channel, sessionStore, persistence, sessionProbeTimeout, logger } = deps;
  if (state.initialized) {
    // 非法调用；返回幂等结果避免中断宿主（宿主应自行保证单次调用）
    logger.warn('[lockData] StorageAuthority.init called twice, ignore the second call');
    return { epoch: host.epoch || 'persistent', effectivePersistence: persistence, authorityCleared: false };
  }
  state.initialized = true;

  // 1. 先订阅常驻 session-probe 响应，避免本 Tab resolveEpoch 期间错过其他 Tab 的探测
  //    （但此时 host.epoch 仍为 null，subscribeSessionProbe 内部会按 null 跳过响应）
  attachSessionProbeResponder(state, deps);

  // 2. resolveEpoch 六分支决策
  const epochCtx: ResolveEpochContext = {
    persistence,
    sessionStore,
    channel,
    authority: authority ? { remove: () => authority.remove() } : null,
    sessionProbeTimeout,
    logger,
  };
  const resolved = await resolveEpoch(epochCtx);

  // ⚠️ await resolveEpoch 期间外部可能已经调用 dispose()。
  // 若已销毁：不回写 host.epoch、不挂 push/pull、不做初次 pull —— 直接交还
  // resolveEpoch 结果，让 dataReadyPromise 仍能 resolve（init() 契约不破坏），
  // 同时彻底避免悬挂 listener 与「已销毁实例被重新接回事件流」的状态错配。
  // 详见 src/shared/lock-data/fixes/init-dispose-race.md
  if (state.disposed) {
    return resolved;
  }
  host.epoch = resolved.epoch;

  // 3. 订阅 authority 推送 + 激活 pull
  attachAuthorityPushSubscription(state, deps);
  attachActivationPullSubscription(state, deps);

  // 4. 初次 pull：仅在未主动清空 authority 时尝试（清空后必然无命中，省一次 read）
  if (authority && !resolved.authorityCleared) {
    applyAuthorityIfNewer(state, deps, 'pull-on-acquire', authority.read());
  }

  return resolved;
}

/**
 * 执行 pullOnAcquire 流程：dispose / authority 缺失时 no-op
 */
function performPullOnAcquire<T extends object>(state: AuthorityState, deps: StorageAuthorityDeps<T>): void {
  const { authority } = deps;
  if (state.disposed || !authority) {
    return;
  }
  applyAuthorityIfNewer(state, deps, 'pull-on-acquire', authority.read());
}

/**
 * 执行 onCommitSuccess 写路径：rev 自增 → authority.write → emitCommit
 */
function performCommitSuccess<T extends object>(
  state: AuthorityState,
  deps: StorageAuthorityDeps<T>,
  event: {
    source: CommitSource;
    token: string;
    mutations: readonly LockDataMutation[];
    snapshot: T;
  },
): void {
  if (state.disposed) {
    return;
  }
  const { host, authority, logger, emitCommit } = deps;
  // rev 自增 + 同步 lastAppliedRev：本 Tab 写入不会再被自己的 storage 事件误判为"新值"
  host.rev++;
  host.lastAppliedRev = host.rev;

  // 写入权威副本：authority / epoch 任一不可用时跳过广播，回退为"同进程同 id 共享"
  if (authority && isString(host.epoch)) {
    const raw = serializeAuthority(host.rev, Date.now(), host.epoch, event.snapshot);
    // authority.write 的异常捕获由 adapter 内部（默认实现用 logger.warn）处理；
    // 此处不 try-catch 以避免吞掉自定义 adapter 显式抛出的致命错误
    authority.write(raw);
  }

  // 触发 onCommit；监听器异常隔离
  try {
    emitCommit({
      source: event.source,
      token: event.token,
      rev: host.rev,
      mutations: event.mutations,
      snapshot: event.snapshot,
    });
  } catch (error) {
    logger.error(`[lockData] emitCommit listener threw (source=${event.source})`, error);
  }
}

/**
 * 执行 dispose 流程：解绑所有订阅 + channel.close；幂等
 */
function performDispose<T extends object>(state: AuthorityState, deps: StorageAuthorityDeps<T>): void {
  if (state.disposed) {
    return;
  }
  state.disposed = true;
  const { channel, logger } = deps;
  for (let i = 0; i < state.unsubscribers.length; i++) {
    try {
      state.unsubscribers[i]();
    } catch (error) {
      logger.warn('[lockData] StorageAuthority dispose: unsubscriber threw', error);
    }
  }
  state.unsubscribers.length = 0;
  // channel 由 StorageAuthority 拥有所有权（init 时订阅的 session-probe 响应）；
  // 同 Entry 的 broadcast driver 也可能共享相同 channel 名，但 ResolvedAdapters 的工厂
  // 每次调用返回独立实例，所以这里 close 是安全的
  if (channel) {
    try {
      channel.close();
    } catch (error) {
      logger.warn('[lockData] StorageAuthority dispose: channel.close threw', error);
    }
  }
}

/**
 * 创建 StorageAuthority 实例
 *
 * 仅负责：state 初始化 + 绑定 deps 闭包 + 返回 API 表面
 * 具体生命周期逻辑由顶层 `perform*` / `attach*` 纯函数承担
 *
 * 立即执行：不做初始化（resolveEpoch / 订阅）；这些在 `init()` 中异步触发
 */
function createStorageAuthority<T extends object>(deps: StorageAuthorityDeps<T>): StorageAuthority<T> {
  const state: AuthorityState = {
    unsubscribers: [],
    disposed: false,
    initialized: false,
  };
  return {
    init: () => performInit(state, deps),
    pullOnAcquire: () => performPullOnAcquire(state, deps),
    onCommitSuccess: (event) => performCommitSuccess(state, deps, event),
    dispose: () => performDispose(state, deps),
  };
}

export type { AuthorityState, StorageAuthority, StorageAuthorityDeps, StorageAuthorityHost };
export {
  applyAuthorityIfNewer,
  attachActivationPullSubscription,
  createStorageAuthority,
  performCommitSuccess,
  performDispose,
  performInit,
  performPullOnAcquire,
};
