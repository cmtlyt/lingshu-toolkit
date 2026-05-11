/**
 * actions.ts 的内部辅助：纯函数式工具 + 内部状态接口
 *
 * 拆分动机：actions.ts 主体由「createActions 状态机闭包」+「跨调用的纯函数辅助」
 * 两部分组成，后者完全独立可测，且 biome `noExcessiveLinesPerFile.maxLines: 500`
 * 要求拆分，遂把以下章节迁移到本模块：
 * - 错误辅助：throwDisposed / isAbortLike / translateAcquireError
 * - timeout 归一化：resolveAcquireTimeout / resolveHoldTimeout / toMilliseconds
 * - signal 合并：buildAcquireSignal + AcquireSignalBundle
 * - driver handle 释放：releaseDriverHandle / safeReleaseHandle
 * - token + buildAcquireName + issueToken
 * - applyInPlace：replace 路径专用的原地覆写
 * - 内部状态：ActionsInternalState / createInitialState / enqueueWrite
 * - signal 自动 dispose 桥接：attachSignalAutoDispose / noop
 *
 * 本模块只对 actions.ts 内部使用；不通过 index.ts 对外导出
 */

import { createError, throwError } from '@/shared/throw-error';
import { isFunction, isObject } from '@/shared/utils';
import type { ResolvedLoggerAdapter } from '../adapters/logger';
import { DEFAULT_TIMEOUT, ERROR_FN_NAME, LOCK_PREFIX, NEVER_TIMEOUT } from '../constants';
import { LockAbortedError, LockDisposedError, LockTimeoutError } from '../errors';
import type { ActionCallOptions, LockDataOptions, LockDriverHandle, LockPhase, TimeoutValue } from '../types';
import type { Entry } from './registry';
import { anySignal, type SignalLike } from './signal';

// ---------------------------------------------------------------------------
// driver name + token
// ---------------------------------------------------------------------------

/**
 * 构造 driver `acquire` 入参的 `name`
 *
 * 必须基于 `entry.lockId`（语义判定用真实 id），而不是 `entry.id`（展示用占位）：
 * - Registry 路径：lockId === id，行为与历史一致（`${LOCK_PREFIX}:<真实 id>`）
 * - Standalone（无 id）路径：lockId === undefined，fallback 到 `${LOCK_PREFIX}:__local__`，
 *   与 `drivers/index.ts::buildDriverDeps` 的占位 name 保持一致；CustomDriver 透传给
 *   用户的 `getLock` 时也会拿到这个 fallback，而非伪 `__local__` 真实 id
 *
 * 详见 `src/shared/lock-data/fixes/standalone-id-leak.md` §3.5
 */
function buildAcquireName<T extends object>(entry: Entry<T>): string {
  return entry.lockId === undefined ? `${LOCK_PREFIX}:__local__` : `${LOCK_PREFIX}:${entry.lockId}`;
}

interface TokenSeqHolder {
  tokenSeq: number;
}

/**
 * 发放新 token；格式：`${LOCK_PREFIX}:${id}:token:${seq}`
 *
 * 仅用于事件 token 字段追踪，无需全局唯一；进程重启从 0 开始不会造成混淆
 */
function issueToken(holder: TokenSeqHolder, id: string): string {
  holder.tokenSeq++;
  return `${LOCK_PREFIX}:${id}:token:${holder.tokenSeq}`;
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
// 错误辅助
// ---------------------------------------------------------------------------

/** 抛 LockDisposedError 辅助 */
function throwDisposed(cause?: unknown): never {
  throwError(ERROR_FN_NAME, 'actions disposed', LockDisposedError as unknown as ErrorConstructor, { cause });
}

function isAbortLike(error: unknown): false | true {
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
// driver handle 释放
// ---------------------------------------------------------------------------

/**
 * 调用 driver handle.release；异步 release 的错误通过 logger.warn 兜底，
 * 不让 actions 的"还锁成功"被异步失败反向污染
 *
 * 严谨 thenable 鸭子类型判定：三重守卫过滤 undefined/null/primitive，Promise.resolve
 * 把最小 thenable（只有 .then 没有 .catch）正规化为 Promise 再挂 catch，避免
 * `(result as Promise<void>).catch` 在最小 thenable 上抛 "catch is not a function"
 * 回归测试：actions.browser.test.ts 第 13 组 describe「driver.release 返回最小 rejected thenable」
 */
function releaseDriverHandle(handle: LockDriverHandle, logger: ResolvedLoggerAdapter): void {
  let result: unknown;
  try {
    result = handle.release();
  } catch (error) {
    logger.warn('[lockData] driver.release threw (sync)', error);
    return;
  }
  if (isObject(result) && 'then' in result && isFunction(result.then)) {
    Promise.resolve(result as Promise<void>).catch((error: unknown) => {
      logger.warn('[lockData] driver.release threw (async)', error);
    });
  }
}

/**
 * 独立调用 handle.release（用于 dispose-race 场景，此时 currentHandle 可能未设置）
 *
 * 严谨 thenable 鸭子类型判定：result 类型是 unknown（driver.release 的实际返回值可能
 * 偏离契约），通过 isObject + 'then' in + isFunction 三重守卫过滤 null/primitive；
 * Promise.resolve 把最小 thenable（只有 .then 没有 .catch）正规化为 Promise 再挂 catch
 * 回归测试：actions.browser.test.ts 第 13 组 describe「dispose-race：acquire 期间 dispose 触发 → safeReleaseHandle 处理最小 thenable 不抛 TypeError」
 */
function safeReleaseHandle(handle: LockDriverHandle, logger: ResolvedLoggerAdapter): void {
  let result: unknown;
  try {
    result = handle.release();
  } catch (error) {
    logger.warn('[lockData] handle.release threw (dispose-race)', error);
    return;
  }
  if (isObject(result) && 'then' in result && isFunction(result.then)) {
    Promise.resolve(result as Promise<void>).catch((error: unknown) => {
      logger.warn('[lockData] handle.release threw (dispose-race async)', error);
    });
  }
}

// ---------------------------------------------------------------------------
// applyInPlace：replace 路径专用的原地覆写
// ---------------------------------------------------------------------------

/**
 * 把 `target` 的全部自有字段替换为 `next` 的字段（原地修改）
 *
 * 通过 Draft Proxy 调用以保证 set / delete 走 mutation log，享受统一的回滚保护：
 * - 数组：`length = 0` 后 `push(...)` 还原；其他自有数字键 / `length` 不会泄漏
 * - 对象：先 `delete` 多余键，再 `Reflect.set` 复制 `next` 的键
 *
 * 形态错配（target 是数组而 next 是对象，或反之）立即抛 `TypeError`，事务统一 rollback
 *
 * 历史位置：曾位于 `core/registry.ts`；wrapper 方案下 registry 不再做就地覆写
 * （commit / 远程同步全部走 `entry.applyRemote(next)` 的新引用赋值），applyInPlace
 * 仅 `actions.replace` 还在使用，遂迁移到本模块
 */
function applyInPlace<T extends object>(target: T, next: T): void {
  const targetIsArray = Array.isArray(target);
  const nextIsArray = Array.isArray(next);
  if (targetIsArray !== nextIsArray) {
    throwError(
      ERROR_FN_NAME,
      `replace shape mismatch: target is ${targetIsArray ? 'array' : 'object'}, next is ${nextIsArray ? 'array' : 'object'}`,
      TypeError,
    );
  }
  if (targetIsArray) {
    const targetArray = target as unknown as unknown[];
    const nextArray = next as unknown as unknown[];
    // 先清空再 push：通过 Draft Proxy 时 length=0 / 每次 push 都被 trap 记录为 mutation
    targetArray.length = 0;
    for (let i = 0; i < nextArray.length; i++) {
      targetArray.push(nextArray[i]);
    }
    return;
  }
  // 对象路径：先删除 target 自身多余键，再写入 next 全部键
  const targetKeys = Object.keys(target as Record<string, unknown>);
  for (let i = 0; i < targetKeys.length; i++) {
    const key = targetKeys[i];
    if (!Object.hasOwn(next as Record<string, unknown>, key)) {
      Reflect.deleteProperty(target as Record<string, unknown>, key);
    }
  }
  const nextKeys = Object.keys(next as Record<string, unknown>);
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i];
    Reflect.set(target as Record<string, unknown>, key, (next as Record<string, unknown>)[key]);
  }
}

// ---------------------------------------------------------------------------
// 内部状态 + 写串行链
// ---------------------------------------------------------------------------

/**
 * Actions 的内部可变状态；所有字段集中在此避免散落的闭包变量
 *
 * token 语义：
 * - `currentToken`：当前 acquire 发放的 token；release / revoke / dispose 后仍保留
 *   用于还锁 / 撤销事件的 token 字段；下次 acquire 会被覆盖
 * - `aliveToken`：当前持有的"有效"token；revoke 后置空 —— 区分"这个 token 是否仍能
 *   commit"，解决 acquiring 期被 revoke 后 await 仍回来的 race
 *
 * `writeChain` 用于写操作严格 FIFO 串行，详见 fixes/concurrent-acquire-serialize.md
 */
interface ActionsInternalState {
  phase: LockPhase;
  /** 当前持有的 driver handle；非 holding 状态下必为 null */
  currentHandle: LockDriverHandle | null;
  /** 最近一次 acquire 发放的 token；每次 acquire 覆盖一次 */
  currentToken: string;
  /** 当前 "仍然有效" 的 token；release / revoke / dispose 后置空字符串 */
  aliveToken: string;
  /** token 单调序号；用于 issueToken */
  tokenSeq: number;
  /** holdTimeout 定时器句柄 */
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** 当前持锁是否由 getLock 发起（影响 update 完成后是否自动 release） */
  acquiredByGetLock: boolean;
  /** dispose 终态标记；之后所有调用 reject LockDisposedError */
  disposed: boolean;
  /** 写操作串行链：update / replace / getLock 通过此 Promise 链严格 FIFO 排队 */
  writeChain: Promise<void>;
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
    writeChain: Promise.resolve(),
  };
}

/**
 * 写操作串行化排队 helper
 *
 * 关键设计点：
 * 1. `state.writeChain.then(task, task)` —— 无论前一个任务成功或失败，下一个任务都会
 *    继续执行；保证 FIFO 严格串行
 * 2. `state.writeChain = next.then(swallow, swallow)` —— 链尾用空函数吞掉 rejection，
 *    下一个排队者不会被前一个失败污染；调用方拿到的是 `next` 本身
 *
 * 详见 src/shared/lock-data/fixes/concurrent-acquire-serialize.md
 */
function enqueueWrite<R>(state: ActionsInternalState, task: () => Promise<R>): Promise<R> {
  const swallow = (): void => {
    /* 吞掉 rejection 隔离链上后续任务，调用方仍从 next 拿到真实错误 */
  };
  const next = state.writeChain.then(task, task);
  state.writeChain = next.then(swallow, swallow);
  return next;
}

function clearHoldTimer(state: ActionsInternalState): void {
  if (state.holdTimer !== null) {
    clearTimeout(state.holdTimer);
    state.holdTimer = null;
  }
}

// ---------------------------------------------------------------------------
// signal 自动 dispose 桥接
// ---------------------------------------------------------------------------

function noop(): void {
  /* no-op */
}

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

export type { AcquireSignalBundle, ActionsInternalState, TokenSeqHolder };
export {
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
};
