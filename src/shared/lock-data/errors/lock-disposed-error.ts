/**
 * 调用方在 actions 已 `dispose()` 后继续使用时抛出
 *
 * 同时覆盖：
 * - `options.signal.aborted` 后任意调用
 * - `options.getValue` Promise reject 后共享同一 Entry 的任意调用
 *   （此时错误 `cause` 字段携带原始 reject 原因）
 *
 * 对应 RFC.md「错误类型」章节
 */
class LockDisposedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'LockDisposedError';
  }
}

export { LockDisposedError };
