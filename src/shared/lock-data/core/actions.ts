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
import { DEFAULT_TIMEOUT, ERROR_FN_NAME, LOCK_PREFIX, NEVER_TIMEOUT } from '../constants';
import { LockAbortedError, LockDisposedError, LockRevokedError, LockTimeoutError } from '../errors';
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
import { createDraftSession } from './draft';
import { fanoutCommit, fanoutLockStateChange, fanoutRevoked } from './fanout';
import { applyInPlace, createFailedInitError, type Entry } from './registry';
import { anySignal, type SignalLike } from './signal';

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
// 内部状态
// ---------------------------------------------------------------------------

/**
 * Actions 的内部可变状态；所有字段集中在此避免散落的闭包变量
 *
 * token 语义：
 * - `currentToken`：当前 acquire 发放的 token；release / revoke / dispose 后仍保留
 *   用于还锁 / 撤销事件的 token 字段；下次 acquire 会被覆盖
 * - `aliveToken`：当前持有的"有效"token；revoke 后置空 —— 区分"这个 token 是否仍能
 *   commit"，解决 acquiring 期被 revoke 后 await 仍回来的 race（见 performAcquire）
 */
interface ActionsInternalState {
  phase: LockPhase;
  /** 当前持有的 driver handle；非 holding 状态下必为 null */
  currentHandle: LockDriverHandle | null;
  /** 最近一次 acquire 发放的 token；每次 acquire 覆盖一次 */
  currentToken: string;
  /**
   * 当前 "仍然有效" 的 token；acquire 成功后 = currentToken；
   * release / revoke / dispose 后置空字符串 —— performAcquire 返回后若 aliveToken
   * 与自己发的 token 不一致说明期间已被 revoke / dispose，立即归还 handle 并抛错
   */
  aliveToken: string;
  /** token 单调序号；用于 issueToken */
  tokenSeq: number;
  /** holdTimeout 定时器句柄 */
  holdTimer: ReturnType<typeof setTimeout> | null;
  /**
   * 当前持锁是否由 getLock 发起（影响 update 完成后是否自动 release）
   *
   * - `true`：getLock 抢的锁，update 完成后保留
   * - `false`：update / replace 自己抢的锁，完成后立即 release
   */
  acquiredByGetLock: boolean;
  /** dispose 终态标记；之后所有调用 reject LockDisposedError */
  disposed: boolean;
}

function createInitialState(): ActionsInternalState {
  return {
    phase: 'idle',
    currentHandle: null,
    currentToken: '',
    aliveToken: '',
    tokenSeq: 0,
    holdTimer: null,
    acquiredByGetLock: false,
    disposed: false,
  };
}

/**
 * 发放新 token；格式：`${LOCK_PREFIX}:${id}:token:${seq}`
 *
 * 仅用于事件 token 字段追踪，无需全局唯一；进程重启从 0 开始不会造成混淆
 */
function issueToken(state: ActionsInternalState, id: string): string {
  state.tokenSeq++;
  return `${LOCK_PREFIX}:${id}:token:${state.tokenSeq}`;
}

// ---------------------------------------------------------------------------
// timeout 归一化
// ---------------------------------------------------------------------------

/**
 * 从 options / callOpts 决议本次调用的抢锁超时
 *
 * 优先级：`callOpts.acquireTimeout` > `options.timeout` > `DEFAULT_TIMEOUT`
 */
function resolveAcquireTimeout<T>(options: LockDataOptions<T>, callOpts: ActionCallOptions | undefined): TimeoutValue {
  if (callOpts && callOpts.acquireTimeout !== undefined) {
    return callOpts.acquireTimeout;
  }
  if (options.timeout !== undefined) {
    return options.timeout;
  }
  return DEFAULT_TIMEOUT;
}

/** 同 resolveAcquireTimeout，维度换为 holdTimeout */
function resolveHoldTimeout<T>(options: LockDataOptions<T>, callOpts: ActionCallOptions | undefined): TimeoutValue {
  if (callOpts && callOpts.holdTimeout !== undefined) {
    return callOpts.holdTimeout;
  }
  if (options.timeout !== undefined) {
    return options.timeout;
  }
  return DEFAULT_TIMEOUT;
}

/** 把 TimeoutValue 归一化为毫秒数；NEVER_TIMEOUT 返回 null 表示"不计时" */
function toMilliseconds(value: TimeoutValue): number | null {
  return value === NEVER_TIMEOUT ? null : (value as number);
}

// ---------------------------------------------------------------------------
// 合并 signal 生成
// ---------------------------------------------------------------------------

interface AcquireSignalBundle {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
  /** acquireTimeout 触发用的 AbortController（null 表示 NEVER_TIMEOUT 不计时） */
  readonly timeoutController: AbortController | null;
}

/**
 * 把 options.signal / callOpts.signal / acquireTimeout / disposedSignal 合成一个派生 signal
 *
 * 返回 `dispose`：清理 timer + 内部 anySignal 的监听；调用方在 acquire 完成 / 失败时都要调用
 */
function buildAcquireSignal(baseSignals: readonly SignalLike[], acquireTimeoutMs: number | null): AcquireSignalBundle {
  const timeoutController = acquireTimeoutMs === null ? null : new AbortController();
  const acquireTimer =
    timeoutController === null
      ? null
      : setTimeout(
          () => timeoutController.abort(new DOMException('acquire timeout', 'TimeoutError')),
          acquireTimeoutMs as number,
        );
  const merged = anySignal([...baseSignals, timeoutController ? timeoutController.signal : null]);
  const dispose = (): void => {
    if (acquireTimer !== null) {
      clearTimeout(acquireTimer);
    }
    merged.dispose();
  };
  return { signal: merged.signal, dispose, timeoutController };
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
  clearHoldTimer(state);
  releaseDriverHandle(deps, state);
  transitionTo(deps, state, 'revoked', token);
  fanoutRevoked(deps.entry.listenersSet, { reason, token }, deps.entry.adapters.logger);
}

function clearHoldTimer(state: ActionsInternalState): void {
  if (state.holdTimer !== null) {
    clearTimeout(state.holdTimer);
    state.holdTimer = null;
  }
}

/**
 * 调用 driver handle.release；异步 release 的错误通过 logger.warn 兜底，
 * 不让 actions 的"还锁成功"被异步失败反向污染
 */
function releaseDriverHandle<T extends object>(deps: ActionsDeps<T>, state: ActionsInternalState): void {
  const handle = state.currentHandle;
  if (!handle) {
    return;
  }
  state.currentHandle = null;
  let result: unknown;
  try {
    result = handle.release();
  } catch (error) {
    deps.entry.adapters.logger.warn('[lockData] driver.release threw (sync)', error);
    return;
  }
  // 严谨 thenable 鸭子类型判定：三重守卫过滤 undefined/null/primitive，Promise.resolve
  // 把最小 thenable（只有 .then 没有 .catch）正规化为 Promise 再挂 catch，避免
  // `(result as Promise<void>).catch` 在最小 thenable 上抛 "catch is not a function"
  // 回归测试：actions.browser.test.ts 第 13 组 describe「driver.release 返回最小 rejected thenable」
  if (isObject(result) && 'then' in result && isFunction(result.then)) {
    Promise.resolve(result as Promise<void>).catch((error: unknown) => {
      deps.entry.adapters.logger.warn('[lockData] driver.release threw (async)', error);
    });
  }
}

/** 独立调用 handle.release（用于 dispose-race 场景，此时 currentHandle 可能未设置） */
function safeReleaseHandle<T extends object>(deps: ActionsDeps<T>, handle: LockDriverHandle): void {
  let result: unknown;
  try {
    result = handle.release();
  } catch (error) {
    deps.entry.adapters.logger.warn('[lockData] handle.release threw (dispose-race)', error);
    return;
  }
  // 严谨 thenable 鸭子类型判定：result 类型是 unknown（driver.release 的实际返回值可能
  // 偏离契约），通过 isObject + 'then' in + isFunction 三重守卫过滤 null/primitive；
  // Promise.resolve 把最小 thenable（只有 .then 没有 .catch）正规化为 Promise 再挂 catch
  // 回归测试：actions.browser.test.ts 第 13 组 describe「dispose-race：acquire 期间 dispose 触发 → safeReleaseHandle 处理最小 thenable 不抛 TypeError」
  if (isObject(result) && 'then' in result && isFunction(result.then)) {
    Promise.resolve(result as Promise<void>).catch((error: unknown) => {
      deps.entry.adapters.logger.warn('[lockData] handle.release threw (dispose-race async)', error);
    });
  }
}

// ---------------------------------------------------------------------------
// 错误辅助
// ---------------------------------------------------------------------------

/** 抛 LockDisposedError 辅助 */
function throwDisposed(cause?: unknown): never {
  throwError(ERROR_FN_NAME, 'actions disposed', LockDisposedError as unknown as ErrorConstructor, { cause });
}

function isAbortLike(error: unknown): boolean {
  if (!isObject(error)) {
    return false;
  }
  const { name } = error as { name?: unknown };
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * driver.acquire 抛错时按 signal 原因翻译错误类型
 *
 * - 超时 controller 触发 → LockTimeoutError
 * - 其他 AbortError / TimeoutError → LockAbortedError
 * - 其他错误原样透传（driver 内部故障、自定义 driver 抛错）
 */
function translateAcquireError(error: unknown, timeoutController: AbortController | null): Error {
  if (timeoutController && timeoutController.signal.aborted) {
    return createError(ERROR_FN_NAME, 'acquire timeout', LockTimeoutError as unknown as ErrorConstructor, {
      cause: error,
    });
  }
  if (isAbortLike(error)) {
    return createError(ERROR_FN_NAME, 'acquire aborted', LockAbortedError as unknown as ErrorConstructor, {
      cause: error,
    });
  }
  return error as Error;
}

// ---------------------------------------------------------------------------
// dataReady 前置等待
// ---------------------------------------------------------------------------

/**
 * 进入抢锁流程前的前置检查：
 * - disposed 终态 → reject LockDisposedError
 * - dataReady 'failed' → reject LockDisposedError(cause=原因)
 * - dataReady 'pending' → await dataReadyPromise（等待期不计入 acquireTimeout）
 */
async function ensureDataReady<T extends object>(deps: ActionsDeps<T>, state: ActionsInternalState): Promise<void> {
  if (state.disposed) {
    throwDisposed();
  }
  const { entry } = deps;
  if (entry.dataReadyState === 'failed') {
    throw createFailedInitError(entry.id, entry.dataReadyError);
  }
  // Entry 契约：dataReadyState === 'pending' ↔ dataReadyPromise !== null（resolveInitialData 保证）
  // 这里用显式 !== null 避开 `Promise | null` 做布尔条件触发的 noMisusedPromises 告警
  if (entry.dataReadyState === 'pending' && entry.dataReadyPromise !== null) {
    try {
      await entry.dataReadyPromise;
    } catch (error) {
      throw createFailedInitError(entry.id, error);
    }
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
      name: `${LOCK_PREFIX}:${entry.id}`,
      token,
      force,
      acquireTimeout: acquireTimeoutValue,
      holdTimeout: holdTimeoutValue,
      signal: signalBundle.signal,
    });
  } catch (error) {
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
    safeReleaseHandle(deps, handle);
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
 * 回滚语义与锁状态解耦：Draft 的写入原地落到 entry.data，只要未 commit 就必须 rollback
 * 恢复 data，避免脏写入泄漏给其他共享 Entry 的实例 / readonly view（revoke / dispose
 * 不影响此结论，通过 `committed` 标志在 finally 中统一判定）
 */
async function runTransaction<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  source: CommitSource,
  recipe: (draft: T) => void | Promise<void>,
): Promise<void> {
  const { entry } = deps;
  const session = createDraftSession(entry.data);
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
 * commit 成功路径：rev++ / 更新 lastAppliedRev / authority.onCommitSuccess / fanoutCommit
 *
 * 事件的 `snapshot` 必须 clone 隔离：fanout 期间用户可能继续修改 data，
 * 让 snapshot 与 data 引用断开避免用户事后误改数据
 */
function applyCommit<T extends object>(
  deps: ActionsDeps<T>,
  state: ActionsInternalState,
  source: CommitSource,
  token: string,
  mutations: readonly LockDataMutation[],
): void {
  const { entry } = deps;
  entry.rev++;
  entry.lastAppliedRev = entry.rev;
  const snapshot = entry.adapters.clone(entry.data);
  if (entry.authority) {
    entry.authority.onCommitSuccess({ source, token, mutations, snapshot });
  } else {
    // 无 authority 场景下由 Actions 直接派发 onCommit（authority 路径已在内部派发）
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
  releaseDriverHandle(deps, state);
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
      releaseDriverHandle(deps, state);
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
      ensureAlive();
      if (!isFunction(recipe)) {
        throwError(ERROR_FN_NAME, 'update requires a recipe function', TypeError);
      }
      const { alreadyHeld } = await ensureHolding(callOpts, 'update');
      try {
        await runTransaction(deps, state, 'update', recipe);
      } finally {
        maybeAutoRelease(alreadyHeld);
      }
    },

    async replace(next, callOpts): Promise<void> {
      ensureAlive();
      if (!isObject(next)) {
        throwError(ERROR_FN_NAME, 'replace requires a non-null object', TypeError);
      }
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
    },

    read(): T {
      ensureAlive();
      return deps.entry.adapters.clone(deps.entry.data);
    },

    async getLock(callOpts): Promise<void> {
      ensureAlive();
      await ensureHolding(callOpts, 'getLock');
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

// ---------------------------------------------------------------------------
// signal.aborted 自动 dispose 桥接
// ---------------------------------------------------------------------------

/**
 * 为 options.signal 注册 abort 监听；触发时等价于自动 dispose
 *
 * 返回 unbind 函数：actions 主动 dispose 时调用，避免悬挂监听
 *
 * 若 signal 构造期已 aborted：通过 queueMicrotask 延迟触发，保证 createActions 完整
 * 返回后再进入 dispose 路径，避免构造期半初始化状态被观察
 */
function attachSignalAutoDispose(signal: AbortSignal | undefined, triggerDispose: () => void): () => void {
  if (!(signal instanceof AbortSignal)) {
    return noop;
  }
  if (signal.aborted) {
    queueMicrotask(triggerDispose);
    return noop;
  }
  const onAbort = (): void => {
    triggerDispose();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return (): void => {
    signal.removeEventListener('abort', onAbort);
  };
}

function noop(): void {
  /* no-op */
}

export type { ActionsDeps };
export { createActions };
