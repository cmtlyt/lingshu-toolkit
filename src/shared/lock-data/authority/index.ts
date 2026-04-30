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
 * 三条读路径共享同一应用流程（RFC L1204）：
 *   | 触发源                | 时机                            | source              | 数据来源                      |
 *   | --------------------- | ------------------------------- | ------------------- | ---------------------------- |
 *   | acquire 时 pull       | driver.acquire 成功、进入 recipe 前 | 'pull-on-acquire'   | authority.read() 同步读      |
 *   | authority.subscribe   | 其他进程写入触发订阅回调        | 'storage-event'     | 回调直接传入 newValue        |
 *   | 激活时主动 pull       | pageshow / visibilitychange     | 'pageshow' 等       | authority.read() 同步读      |
 *
 * 一条写路径（RFC L1190）：
 *   commit 成功 → rev++ → authority.write(serialize) → 触发 onCommit
 *
 * Phase 4 阶段的设计约束：
 *   - Phase 5 的 Entry 尚未实现，这里用 `StorageAuthorityHost` 最小契约封装依赖
 *     （结构化鸭子类型：Phase 5 Entry 天然实现此接口）
 *   - 不做 data 的 in-place 替换，通过 `applySnapshot` 回调交给宿主实现
 *     （Phase 5 会注入基于 `core/readonly-view.ts` 的 replaceInPlace）
 *   - 事件触发统一走 `emit` 回调，Phase 5 的 `listenersFanout` 会实现真正的多实例扇出
 */

import { isObject, isString } from '@/shared/utils/verify';
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
import { type ResolveEpochContext, type ResolveEpochResult, resolveEpoch, subscribeSessionProbe } from './epoch';
import { readIfNewer } from './extract';
import { serializeAuthority } from './serialize';

/**
 * StorageAuthority 宿主契约（Phase 5 Entry 的最小子集）
 *
 * 设计动机：Phase 4 不感知 Entry 完整结构，避免与 Phase 5 的 registry 形成循环依赖。
 * 宿主对象必须保证这些字段可读可写 —— `rev` / `lastAppliedRev` 读写双向，
 * `epoch` 仅由 `StorageAuthority` 内部在首次 `resolveEpoch` 后回写。
 */
interface StorageAuthorityHost<T extends object> {
  /** 当前数据；applySnapshot 会原地改写此对象（由宿主注入的 applySnapshot 实现） */
  data: T;
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
  /**
   * 深克隆函数；`onCommitSuccess` 写入 authority 前不克隆（由调用方在更靠外层克隆，
   * 避免 snapshot 再次被改动），但初次 pull 成功时会 clone 以避免外部拿到的对象
   * 与 data 同一引用
   */
  readonly clone: <V>(value: V) => V;
  /**
   * in-place 替换 data 内容；Phase 4 阶段交由宿主提供具体实现
   * （Phase 5 会注入基于 readonly-view 的深度 replaceInPlace；
   * Phase 4 测试里用简单的 `Object.assign + 删键` 即可）
   */
  readonly applySnapshot: (data: T, nextSnapshot: T) => void;
  /** onSync 事件触发回调；Phase 5 会接到 listenersFanout */
  readonly emitSync: (event: { source: SyncSource; rev: number; snapshot: T }) => void;
  /** onCommit 事件触发回调；Phase 5 会接到 listenersFanout */
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
   * 返回 `Promise<ResolveEpochResult>`（Phase 5 的 dataReadyPromise 会把此 Promise
   * 和 getValue Promise 组合后 resolve）
   *
   * 多次调用 init 是非法的：宿主自行保证只调用一次
   */
  init: () => Promise<ResolveEpochResult>;

  /** 手动拉取（acquire 时使用）：等价于一次 source='pull-on-acquire' 的 readIfNewer + 应用 */
  pullOnAcquire: () => void;

  /**
   * commit 成功后的写路径：`rev++` → `authority.write` → emit onCommit
   *
   * `mutations` 由 Phase 5 的 Draft 层提供；Phase 4 测试里可传空数组
   * `snapshot` 必须是已 clone 的独立副本（authority.write 之后宿主可能继续改 data）
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
  const { host, logger, clone, applySnapshot, emitSync } = deps;
  const result = readIfNewer({ lastAppliedRev: host.lastAppliedRev, epoch: host.epoch }, raw);
  if (!result) {
    return;
  }
  // Phase 4 不关心 snapshot 的具体类型 —— 由 applySnapshot 宿主实现负责校验；
  // 但基本 object 守卫能避免脏数据导致 replace 过程里抛错
  if (!isObject(result.snapshot)) {
    logger.warn(`[lockData] authority snapshot is not an object (source=${source}), skip apply`);
    return;
  }
  const nextSnapshot = result.snapshot as T;
  try {
    applySnapshot(host.data, nextSnapshot);
  } catch (error) {
    logger.error(`[lockData] applySnapshot failed (source=${source}, rev=${result.rev})`, error);
    return;
  }
  host.rev = result.rev;
  host.lastAppliedRev = result.rev;
  // 触发 onSync；传出的 snapshot 必须克隆隔离，避免用户监听器改动内部 data
  try {
    emitSync({ source, rev: result.rev, snapshot: clone(nextSnapshot) });
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
  // Phase 3 broadcast driver 也可能共享同一个 channel，但 ResolvedAdapters 的工厂
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

export type { StorageAuthority, StorageAuthorityDeps, StorageAuthorityHost };
export { createStorageAuthority };
