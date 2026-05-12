/**
 * 泛型事件系统
 *
 * 对应 RFC.md「事件系统实现」章节
 *
 * 设计要点：
 * - on / once / off / dispatch 四方法
 * - dispatch 采用快照遍历（slice），保证遍历过程中增删不影响当前分发
 * - 单个 handler 抛错通过 try/catch 捕获 + logger.error 记录，不阻断后续 handler
 * - once handler 在分发前从原数组移除，保证只触发一次
 */

import type { ResolvedLoggerAdapter } from '../adapters/logger';
import type { AllEvents, EventHandler, EventMap } from '../types';

interface HandlerEntry<P = unknown> {
  handler: EventHandler<P>;
  once: boolean;
}

/**
 * 创建泛型事件发射器
 *
 * @param logger 已解析的 logger（三方法齐全），用于异常隔离时记录错误
 */
function createEventEmitter<UserEvents extends EventMap>(logger: ResolvedLoggerAdapter) {
  const listeners = new Map<string, HandlerEntry[]>();

  function on<K extends keyof AllEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllEvents<UserEvents>[K]>,
  ): () => void {
    const key = event as string;
    let entries = listeners.get(key);
    if (!entries) {
      entries = [];
      listeners.set(key, entries);
    }
    const entry: HandlerEntry = { handler: handler as EventHandler<unknown>, once: false };
    entries.push(entry);
    return () => off(event, handler);
  }

  function once<K extends keyof AllEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllEvents<UserEvents>[K]>,
  ): () => void {
    const key = event as string;
    let entries = listeners.get(key);
    if (!entries) {
      entries = [];
      listeners.set(key, entries);
    }
    const entry: HandlerEntry = { handler: handler as EventHandler<unknown>, once: true };
    entries.push(entry);
    return () => off(event, handler);
  }

  function off<K extends keyof AllEvents<UserEvents>>(event: K, handler: EventHandler<AllEvents<UserEvents>[K]>): void {
    const key = event as string;
    const entries = listeners.get(key);
    if (!entries) {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].handler === handler) {
        entries.splice(i, 1);
        return;
      }
    }
  }

  /**
   * 事件分发（内部方法，不暴露给用户）
   *
   * 异常隔离契约（对齐 lock-data fanout 模式）：
   * - 单个 handler 同步 throw 通过 try/catch 捕获，走 logger.error 记录
   * - 不阻断后续 handler 执行
   *
   * 遍历安全：
   * - 先做数组快照（slice），再正向遍历快照
   * - once handler 从原数组中移除
   */
  function dispatch(event: string, payload?: unknown): void {
    const key = event;
    const entries = listeners.get(key);
    if (!entries || entries.length === 0) {
      return;
    }

    const snapshot = entries.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const entry = snapshot[i];
      if (entry.once) {
        const idx = entries.indexOf(entry);
        if (idx >= 0) {
          entries.splice(idx, 1);
        }
      }
      try {
        (entry.handler as (_payload?: unknown) => void)(payload);
      } catch (error) {
        logger.error(`event handler threw (${key})`, error);
      }
    }
  }

  /** 清理所有事件监听器 */
  function clear(): void {
    listeners.clear();
  }

  return { on, once, off, dispatch, clear };
}

export type { HandlerEntry };
export { createEventEmitter };
