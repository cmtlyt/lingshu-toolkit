/**
 * listeners fanout：把 driver / authority / actions 产生的事件分发给 Entry 的全部 listener
 *
 * 对应 RFC.md L666-667「listeners 不冲突 / listener 异常隔离」契约：
 * - 每个实例的 `listeners` 独立保存在 `Entry.listenersSet` 中
 * - 事件触发时遍历 Set 向每个 listener 的对应 hook 分发
 * - 单个 listener 抛错（同步 throw / 异步 Promise reject）通过 logger.error
 *   统一吞掉 + 记录，继续向剩余 listener 分发，不阻断 actions 状态机
 *
 * 设计边界：
 * - 本模块**不产生**事件：事件对象由上游（actions / authority）构造好传入
 * - 本模块**不管理订阅**：订阅通过 `entry.listenersSet.add/delete` 操作，
 *   Registry 的 `releaseEntry` / `getOrCreateEntry` 已负责 Set 的增删
 * - listener 未提供对应 hook 时跳过（不调用 undefined）
 */

import { isFunction, isObject } from '@/shared/utils/verify';
import type { ResolvedLoggerAdapter } from '../adapters/logger';
import type { CommitEvent, LockDataListeners, LockStateChangeEvent, RevokeEvent, SyncEvent } from '../types';

/**
 * fanout 通用逻辑：遍历 listeners 集合，对每个存在指定 hook 的 listener 调用，
 * 同步 throw / 异步 reject 均走 logger.error 记录，继续下一个
 *
 * 使用独立泛型参数：不同事件 hook 的参数类型不同，上层四个 fanout 函数各自收窄
 *
 * @param listeners  Entry.listenersSet（调用方直接传入，不做拷贝）
 * @param hookName   对应 LockDataListeners 里的字段名；仅用于日志标识
 * @param pickHook   从 listener 中取对应 hook；hook 不存在返回 undefined
 * @param event      要分发的事件对象（调用方已构造好）
 * @param logger     错误记录通道
 */
function fanoutEvent<TListeners, TEvent>(
  listeners: Iterable<TListeners>,
  hookName: string,
  pickHook: (listener: TListeners) => ((payload: TEvent) => void | Promise<void>) | undefined,
  eventPayload: TEvent,
  logger: ResolvedLoggerAdapter,
): void {
  for (const listener of listeners) {
    const hook = pickHook(listener);
    if (!hook) {
      continue;
    }
    let result: void | Promise<void>;
    try {
      result = hook(eventPayload);
    } catch (error) {
      logger.error(`[lockData] listener threw (${hookName})`, error);
      continue;
    }
    // 严谨 thenable 鸭子类型判定：过滤 undefined/null/primitive 等任意非 Promise 返回值
    // （用户 hook 实现可能偏离 TS 类型约束）；Promise.resolve 把最小 thenable
    // （只有 .then 没有 .catch）正规化为 Promise 再挂 catch，避免 TypeError
    // 回归测试：actions.browser.test.ts 第 13 组 describe「listener.onCommit 返回最小 rejected thenable」
    if (isObject(result) && 'then' in result && isFunction(result.then)) {
      Promise.resolve(result as Promise<void>).catch((error: unknown) => {
        logger.error(`[lockData] listener threw (${hookName})`, error);
      });
    }
  }
}

/**
 * fanoutLockStateChange：状态机流转事件（idle → acquiring → holding → ...）
 *
 * 触发时机：Actions 状态机每次状态切换（见 RFC L933「每一步状态流转都通过
 * listenersFanout.onLockStateChange(event) 分发到所有实例的 listeners」）
 */
function fanoutLockStateChange<T extends object>(
  listeners: Iterable<LockDataListeners<T>>,
  event: LockStateChangeEvent,
  logger: ResolvedLoggerAdapter,
): void {
  fanoutEvent<LockDataListeners<T>, LockStateChangeEvent>(
    listeners,
    'onLockStateChange',
    (listener) => listener.onLockStateChange,
    event,
    logger,
  );
}

/**
 * fanoutRevoked：持有锁被 driver 驱逐 / timeout / dispose 主动释放时触发
 */
function fanoutRevoked<T extends object>(
  listeners: Iterable<LockDataListeners<T>>,
  event: RevokeEvent,
  logger: ResolvedLoggerAdapter,
): void {
  fanoutEvent<LockDataListeners<T>, RevokeEvent>(
    listeners,
    'onRevoked',
    (listener) => listener.onRevoked,
    event,
    logger,
  );
}

/**
 * fanoutCommit：commit 成功时触发（RFC L1201 onCommitSuccess 写路径）
 *
 * 事件中的 snapshot 必须是**已 clone 的独立副本**，由调用方保证
 * （StorageAuthority.onCommitSuccess 已在调用处 clone）
 */
function fanoutCommit<T extends object>(
  listeners: Iterable<LockDataListeners<T>>,
  event: CommitEvent<T>,
  logger: ResolvedLoggerAdapter,
): void {
  fanoutEvent<LockDataListeners<T>, CommitEvent<T>>(
    listeners,
    'onCommit',
    (listener) => listener.onCommit,
    event,
    logger,
  );
}

/**
 * fanoutSync：authority 拉到新快照时触发（RFC L1214）
 *
 * 来源包括：pull-on-acquire / storage-event / pageshow / visibilitychange
 */
function fanoutSync<T extends object>(
  listeners: Iterable<LockDataListeners<T>>,
  event: SyncEvent<T>,
  logger: ResolvedLoggerAdapter,
): void {
  fanoutEvent<LockDataListeners<T>, SyncEvent<T>>(listeners, 'onSync', (listener) => listener.onSync, event, logger);
}

export { fanoutCommit, fanoutLockStateChange, fanoutRevoked, fanoutSync };
