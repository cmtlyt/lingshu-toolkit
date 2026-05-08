/**
 * LockDataActions：状态机 + 事务式写入的对外 API 实现
 *
 * 对应 RFC.md「Actions 实现要点」章节（L930-964）。
 *
 * 状态机：
 *   `idle` → `acquiring` → `holding` → `committing` → `released` / `revoked` / `disposed`
 *
 * 职责：
 * - 抢锁 / 还锁 / 持锁期事务（update / replace）
 * - 合并 AbortSignal：`options.signal` + `callOpts.signal` + `acquireTimeout` + 内部 dispose controller
 * - `holdTimeout` 定时器 / `onRevokedByDriver` 桥接 → 触发 revoke + 广播 `onRevoked`
 * - 通过 `entry.dataReadyPromise` 等待异步初始化完成，`failed` 态直接 reject `LockDisposedError`
 * - dispose 时调用 `releaseFromRegistry` 释放引用计数；Entry 销毁由 Registry 负责
 *
 * 职责边界（不做什么）：
 * - 不直接销毁 Entry（refCount 归零时由 Registry 的 releaseEntry 触发 teardowns）
 * - 不关心 driver / authority 的具体实现（只通过抽象接口交互）
 * - 不管 Entry 销毁后的清理（通过 registerTeardown 登记的回调由 Registry 负责逆序运行）
 */

import { createError, throwError } from '@/shared/throw-error';
import { isFunction, isObject } from '@/shared/utils/verify';
import { ERROR_FN_NAME } from '../constants';
import { LockAbortedError, LockRevokedError } from '../errors';
import type {
  ActionCallOptions,
  CommitSource,
  LockDataActions,
  LockDataMutation,
  LockDataOptions,
  LockDriverHandle,
  LockPhase,
  RevokeReason,
  TimeoutValue,
} from '../types';
import { assertJsonSafeInput, cloneByJson } from '../utils/json-safe';
import {
  type ActionsInternalState,
  applyInPlace,
  attachSignalAutoDispose,
  buildAcquireName,
  buildAcquireSignal,
  clearHoldTimer,
  createInitialState,
  enqueueWrite,
  issueToken,
  noop,
  releaseDriverHandle,
  resolveAcquireTimeout,
  resolveHoldTimeout,
  safeReleaseHandle,
  throwDisposed,
  toMilliseconds,
  translateAcquireError,
} from './actions-helpers';
import { createDraftSession } from './draft';
import { fanoutCommit, fanoutLockStateChange, fanoutRevoked } from './fanout';
import type { Entry } from './registry';

/**
 * Actions 构造依赖
 *
 * 使用依赖注入而非直接 import registry：便于测试用 stub registry 隔离，
 * 也让 entry.ts 的组装链路显式可见（Registry 实例从 entry.ts 传入）
 */
interface ActionsDeps<T extends object> {
  /** 共享的 Entry；Actions 不拥有它，只读取 / 标记 rev++ */
  readonly entry: Entry<T>;
  /** 本实例原始 options（listeners / signal / timeout 等）；长期持有 */
  readonly options: LockDataOptions<T>;
  /**
   * 释放 Entry 的引用计数通道；Actions.dispose 调用
   *
   * 无 id 场景传入 `() => void` no-op（Entry 独占，无 Registry 跟踪）
   */
  readonly releaseFromRegistry: () => void;
}

// ---------------------------------------------------------------------------
// 状态流转 + fanout
// ---------------------------------------------------------------------------

function transitionTo<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  phase: LockPhase,
  token: string,
): void {
  state.phase = phase;
  fanoutLockStateChange(deps.entry.listenersSet, { phase, token }, deps.entry.adapters.logger);
}

// ---------------------------------------------------------------------------
// revoke 流程：清理持锁资源 + 广播 onRevoked
// ---------------------------------------------------------------------------

/**
 * 统一的 revoke 路径：清理 holdTimer + release driver handle + 广播
 *
 * 幂等：通过 aliveToken 去重，同一轮持锁只处理一次
 */
function handleRevoke<T extends object>(deps: ActionsDeps<T>, state: ActionsInternalState, reason: RevokeReason): void {
  // aliveToken 为空说明已经不在有效持锁期（从未 acquire 成功 / 已被其他源 revoke / 已 release）
  if (state.aliveToken === '') {
    return;
  }
  const token = state.aliveToken;
  state.aliveToken = '';
  // 与 performRelease / doDispose 对称：所有「持锁周期出口」必须把 acquiredByGetLock 归零，
  // 否则上一轮 getLock() 留下的 flag 会污染下一轮 update()，导致 maybeAutoRelease 误判
  // 为「这把锁是 getLock 主动留的」从而跳过自动释放，普通 update 抢的锁被永久留住。
  // 详见 src/shared/lock-data/fixes/revoke-clear-acquired-by-get-lock.md
  state.acquiredByGetLock = false;
  clearHoldTimer(state);
  releaseStateHandle(deps, state);
  transitionTo(deps, state, 'revoked', token);
  fanoutRevoked(deps.entry.listenersSet, { reason, token }, deps.entry.adapters.logger);
}

/**
 * 释放当前 state 持有的 driver handle 并清空 currentHandle 字段
 *
 * 实际释放工作委托给 helpers 的 `releaseDriverHandle(handle, logger)`；
 * 此处只负责"从 state 取出 handle 并清空"的状态机职责
 */
function releaseStateHandle<T extends object>(deps: ActionsDeps<T>, state: ActionsInternalState): void {
  const handle = state.currentHandle;
  if (!handle) {
    return;
  }
  state.currentHandle = null;
  releaseDriverHandle(handle, deps.entry.adapters.logger);
}

// ---------------------------------------------------------------------------
// dataReady 前置等待
// ---------------------------------------------------------------------------

/**
 * 进入抢锁流程前的前置检查：
 * - disposed 终态 → reject LockDisposedError
 * - dataReadyPromise 存在（异步初始化未就绪）→ await（等待期不计入 acquireTimeout）；
 *   reject 通道由 `prepareEntryData` 负责包装为 `LockDisposedError(cause=...)`，本处直接透传
 *
 * 半极简方案（设计文档 §12）：删除 `dataReadyState/dataReadyError` 字段后，仅靠
 * `dataReadyPromise !== null` 一个标志位就能完整表达"是否需要等待初始化"
 */
async function ensureDataReady<T extends object>(deps: ActionsDeps<T>, state: ActionsInternalState): Promise<void> {
  if (state.disposed) {
    throwDisposed();
  }
  const { entry } = deps;
  // 显式 !== null 避开 `Promise | null` 做布尔条件触发的 noMisusedPromises 告警
  if (entry.dataReadyPromise !== null) {
    await entry.dataReadyPromise;
    if (state.disposed) {
      throwDisposed();
    }
  }
}

// ---------------------------------------------------------------------------
// acquire 主流程
// ---------------------------------------------------------------------------

/**
 * 执行一次 acquire；拿到 handle 后启动 holdTimeout + onRevokedByDriver 绑定
 *
 * 失败路径：把错误翻译成 LockTimeoutError / LockAbortedError 抛出，并把 phase 回落到 'idle'
 */
async function performAcquire<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  disposedSignal: AbortSignal,
  callOpts: ActionCallOptions | undefined,
  force: boolean,
): Promise<void> {
  const { entry, options } = deps;
  const acquireTimeoutValue = resolveAcquireTimeout(options, callOpts);
  const acquireTimeoutMs = toMilliseconds(acquireTimeoutValue);
  const holdTimeoutValue = resolveHoldTimeout(options, callOpts);
  const signalBundle = buildAcquireSignal([options.signal, callOpts?.signal, disposedSignal], acquireTimeoutMs);

  const token = issueToken(state, entry.id);
  state.currentToken = token;
  // 进入 acquiring 期：aliveToken 暂设为 token；若期间被 revoke，aliveToken 会被置空
  state.aliveToken = token;
  transitionTo(deps, state, 'acquiring', token);

  let handle: LockDriverHandle;
  try {
    handle = await entry.driver.acquire({
      name: buildAcquireName(entry),
      token,
      force,
      acquireTimeout: acquireTimeoutValue,
      holdTimeout: holdTimeoutValue,
      signal: signalBundle.signal,
    });
  } catch (error) {
    // dispose 与 in-flight acquire 竞争：disposed 是终态，不能再回退到 idle
    // （否则 onLockStateChange 会在 'disposed' 之后又收到一次 'idle'），且调用方应
    // 拿到 LockDisposedError 而非 abort/timeout 错误（语义对齐成功路径 L411-415 +
    // ensureDataReady 中「disposed 后任何方法都 reject LockDisposedError」契约）。
    // 把原始错误作为 cause 透传，便于排障定位是哪条路径触发了 dispose。
    // 详见 src/shared/lock-data/fixes/dispose-race-acquire-catch.md
    if (state.disposed) {
      throwDisposed(error);
    }
    // acquire 失败：phase 回到 idle；aliveToken 保持置空；抛翻译后的错误
    state.aliveToken = '';
    transitionTo(deps, state, 'idle', token);
    throw translateAcquireError(error, signalBundle.timeoutController);
  } finally {
    signalBundle.dispose();
  }

  // acquire 成功但在 await 期间可能发生：
  // 1. dispose 被触发 → state.disposed = true
  // 2. aliveToken 被 revoke 改写成 ''（driver 通过别的通道触发了 revoke）
  // 两种情况都要立刻归还 handle 并抛错
  if (state.disposed || state.aliveToken !== token) {
    safeReleaseHandle(handle, deps.entry.adapters.logger);
    if (state.disposed) {
      throwDisposed();
    }
    throwError(ERROR_FN_NAME, 'lock revoked before activation', LockRevokedError as unknown as ErrorConstructor);
  }

  state.currentHandle = handle;
  attachRevokeFromDriver(deps, state, handle);
  startHoldTimer(deps, state, holdTimeoutValue);
  transitionTo(deps, state, 'holding', token);

  // acquire 成功 → 主动 pull authority（RFC L1220 pull-on-acquire 读路径）
  if (entry.authority) {
    entry.authority.pullOnAcquire();
  }
}

function attachRevokeFromDriver<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  handle: LockDriverHandle,
): void {
  if (!isFunction(handle.onRevokedByDriver)) {
    return;
  }
  handle.onRevokedByDriver((reason) => {
    handleRevoke(deps, state, reason);
  });
}

function startHoldTimer<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  holdTimeout: TimeoutValue,
): void {
  const holdMs = toMilliseconds(holdTimeout);
  if (holdMs === null) {
    return;
  }
  state.holdTimer = setTimeout(() => {
    state.holdTimer = null;
    handleRevoke(deps, state, 'timeout');
  }, holdMs);
}

// ---------------------------------------------------------------------------
// 事务执行：update / replace 共享
// ---------------------------------------------------------------------------

/**
 * 在 ensureHolding 成功后执行 recipe，按事务语义处理 commit / rollback
 *
 * 回滚语义与锁状态解耦：Draft 的写入原地落到 `entry.dataRef.current`，只要未 commit
 * 就必须 rollback 恢复 dataRef.current，避免脏写入泄漏给其他共享 Entry 的实例 /
 * readonly view（revoke / dispose 不影响此结论，通过 `committed` 标志在 finally 中
 * 统一判定）
 *
 * wrapper 方案契约：draft session 直接挂载在 `dataRef.current` 上做原地修改 ——
 * `dataRef` 引用本身永不变更，readonly view 与外部缓存的 dataRef 持续看到同一内容
 */
async function runTransaction<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  source: CommitSource,
  recipe: (draft: T) => void | Promise<void>,
): Promise<void> {
  const { entry } = deps;
  const session = createDraftSession(entry.dataRef.current);
  const token = state.currentToken;
  transitionTo(deps, state, 'committing', token);

  let committed = false;
  try {
    const result = recipe(session.draft);
    // 严谨 thenable 鸭子类型判定：recipe 可能同步返回 void 或异步返回 Promise，
    // 严谨检测避免对 primitive 等意外返回值走 microtask（await 对非 thenable 虽安全但
    // 会产生不必要的 tick 延迟，影响同步 update 场景的时序契约）
    if (isObject(result) && 'then' in result && isFunction(result.then)) {
      await result;
    }
    if (state.aliveToken !== token) {
      // 锁已失效（revoke / dispose），不能 commit；rollback 在 finally 统一处理
      throwError(ERROR_FN_NAME, 'lock revoked during recipe', LockRevokedError as unknown as ErrorConstructor);
    }
    const mutations = session.commit();
    committed = true;
    applyCommit(deps, state, source, token, mutations);
  } finally {
    if (!committed) {
      session.rollback();
    }
    session.dispose();
  }
}

/**
 * commit 成功路径：rev 自增 + lastAppliedRev 同步 + 事件派发
 *
 * rev 自增的归属约定（避免双增 bug）：
 *   - `entry.authority` 存在 → 由 `StorageAuthority.onCommitSuccess` 内部统一
 *     自增 rev + 写权威副本 + 派发 onCommit（见 `authority/index.ts::performCommitSuccess`）
 *   - `entry.authority === null` → Actions 直接在此自增 rev 并派发 fanoutCommit
 *
 * 事件的 `snapshot` 必须 JSON 拷贝隔离：fanout 期间用户可能继续修改 dataRef.current，
 * 让 snapshot 与 dataRef.current 引用断开避免用户事后误改数据。wrapper 方案下
 * 统一走 `cloneByJson`，与 `entry.applyRemote` / `getValue` 入口用同一份隔离契约
 */
function applyCommit<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  source: CommitSource,
  token: string,
  mutations: readonly LockDataMutation[],
): void {
  const { entry } = deps;
  const snapshot = cloneByJson(entry.dataRef.current);
  if (entry.authority) {
    // authority 路径：rev 自增 + 权威副本写入 + onCommit 派发全部在 onCommitSuccess 内部完成
    entry.authority.onCommitSuccess({ source, token, mutations, snapshot });
  } else {
    // 无 authority 路径：本地自增 rev 后直接 fanoutCommit
    entry.rev++;
    entry.lastAppliedRev = entry.rev;
    fanoutCommit(entry.listenersSet, { source, token, rev: entry.rev, mutations, snapshot }, entry.adapters.logger);
  }
  transitionTo(deps, state, 'holding', token);
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

/**
 * release 执行：清理 holdTimer + 释放 driver handle + state 回 idle
 *
 * 非 holding / committing 状态为 no-op（幂等）；disposed 终态下抛 LockDisposedError
 */
function performRelease<T extends object>(deps: ActionsDeps<T>, state: ActionsInternalState): void {
  if (state.disposed) {
    throwDisposed();
  }
  if (state.phase !== 'holding' && state.phase !== 'committing') {
    return;
  }
  const token = state.currentToken;
  state.aliveToken = '';
  clearHoldTimer(state);
  releaseStateHandle(deps, state);
  state.acquiredByGetLock = false;
  transitionTo(deps, state, 'released', token);
  transitionTo(deps, state, 'idle', token);
}

// ---------------------------------------------------------------------------
// 主入口：createActions
// ---------------------------------------------------------------------------

/**
 * 构造 LockDataActions 实例
 *
 * 所有状态封装在 `ActionsInternalState`；对外暴露的 Actions 方法是纯闭包，
 * 不泄漏内部 state 引用
 */
function createActions<T extends object>(deps: ActionsDeps<T>): LockDataActions<T> {
  const state = createInitialState();
  const disposedController = new AbortController();
  // 本 actions 实例的 signal listener 解绑通道；dispose 内部调用
  let unbindSignalAutoDispose: () => void = noop;

  /** 主动 dispose 的内部实现；供 Actions.dispose 与 signal.aborted 自动触发共享 */
  const doDispose = (): void => {
    if (state.disposed) {
      return;
    }
    state.disposed = true;
    unbindSignalAutoDispose();
    unbindSignalAutoDispose = noop;

    // 中断正在进行的 acquire
    if (!disposedController.signal.aborted) {
      disposedController.abort(
        createError(ERROR_FN_NAME, 'actions disposed', LockAbortedError as unknown as ErrorConstructor),
      );
    }

    // 正在持锁 / 正在 acquire：还锁 + revoked 广播
    if (state.aliveToken !== '') {
      const token = state.aliveToken;
      state.aliveToken = '';
      clearHoldTimer(state);
      releaseStateHandle(deps, state);
      fanoutRevoked(deps.entry.listenersSet, { reason: 'dispose', token }, deps.entry.adapters.logger);
    }

    // disposed 终态发放独立 token，避免与之前的持锁事件语义混淆
    const disposeToken = issueToken(state, deps.entry.id);
    transitionTo(deps, state, 'disposed', disposeToken);
    deps.releaseFromRegistry();
  };

  // 绑定 options.signal 的 abort 自动 dispose；若构造期已 aborted 则延迟到下一 microtask
  // 触发，避免 createActions 还没返回时就跑完 doDispose（释放 registerTeardown 回调会
  // 对一个尚未完全构造的 actions 造成可观察性混乱）
  unbindSignalAutoDispose = attachSignalAutoDispose(deps.options.signal, doDispose);

  const ensureAlive = (): void => {
    if (state.disposed) {
      throwDisposed();
    }
  };

  /** update / replace / getLock 的共享前置：准备好 dataReady 并抢锁（未持锁时） */
  const ensureHolding = async (
    callOpts: ActionCallOptions | undefined,
    acquireTag: 'update' | 'replace' | 'getLock',
  ): Promise<{ alreadyHeld: boolean }> => {
    await ensureDataReady(deps, state);
    if (state.phase === 'holding' && state.aliveToken !== '') {
      return { alreadyHeld: true };
    }
    const force = callOpts?.force === true;
    await performAcquire(deps, state, disposedController.signal, callOpts, force);
    if (acquireTag === 'getLock') {
      state.acquiredByGetLock = true;
    }
    return { alreadyHeld: false };
  };

  /** recipe 结束后的 release 决策：自己抢的锁且仍持有时立即 release */
  const maybeAutoRelease = (alreadyHeld: boolean): void => {
    if (alreadyHeld || state.acquiredByGetLock) {
      return;
    }
    if (state.phase !== 'holding') {
      return;
    }
    performRelease(deps, state);
  };

  const actions: LockDataActions<T> = {
    get isHolding(): boolean {
      return state.phase === 'holding' || state.phase === 'committing';
    },

    async update(recipe, callOpts): Promise<void> {
      // 入队前同步快速失败（disposed / 类型错误）：保持现有 fail-fast 契约，
      // 不让无效调用占用串行链位置
      ensureAlive();
      if (!isFunction(recipe)) {
        throwError(ERROR_FN_NAME, 'update requires a recipe function', TypeError);
      }
      // 写操作串行化：通过 enqueueWrite 排队，保证 ensureHolding + runTransaction +
      // maybeAutoRelease 的关键区同一时刻只有一个写操作执行。排队后再次 ensureAlive
      // 兜底「排队期间被 dispose」场景，按 disposed 终态契约 reject LockDisposedError
      return enqueueWrite(state, async () => {
        ensureAlive();
        const { alreadyHeld } = await ensureHolding(callOpts, 'update');
        try {
          await runTransaction(deps, state, 'update', recipe);
        } finally {
          maybeAutoRelease(alreadyHeld);
        }
      });
    },

    async replace(next, callOpts): Promise<void> {
      ensureAlive();
      if (!isObject(next)) {
        throwError(ERROR_FN_NAME, 'replace requires a non-null object', TypeError);
      }
      // 入口 fail-fast：顶层数组 / 非 JSON-safe 立即抛错，避免污染 draft / commit
      // 链路。与 `entry.applyRemote` / `getValue` resolve 后入口共享同一份契约
      assertJsonSafeInput(next, 'lockData actions.replace(next)');
      return enqueueWrite(state, async () => {
        ensureAlive();
        const { alreadyHeld } = await ensureHolding(callOpts, 'replace');
        try {
          // Draft Proxy 的 set/delete 会把 applyInPlace 的 length=0 / push / deleteProperty /
          // Reflect.set 全部捕获为 mutation，享受统一的回滚保护；错配时 applyInPlace 抛 TypeError
          await runTransaction(deps, state, 'replace', (draft) => {
            applyInPlace(draft, next as T);
          });
        } finally {
          maybeAutoRelease(alreadyHeld);
        }
      });
    },

    snapshot(): T {
      ensureAlive();
      // wrapper 方案契约：snapshot 必须与内部 dataRef.current 完全隔离，调用方对返回
      // 值的任意 mutate 都不会反向影响 lock-data 内部状态。统一走 JSON 拷贝，与
      // commit / applyRemote / getValue 入口共享同一份隔离语义
      return cloneByJson(deps.entry.dataRef.current);
    },

    async getLock(callOpts): Promise<void> {
      ensureAlive();
      return enqueueWrite(state, async () => {
        ensureAlive();
        await ensureHolding(callOpts, 'getLock');
      });
    },

    release(): void {
      performRelease(deps, state);
    },

    async dispose(): Promise<void> {
      doDispose();
    },
  };

  return actions;
}

export type { ActionsDeps };
export { createActions };
