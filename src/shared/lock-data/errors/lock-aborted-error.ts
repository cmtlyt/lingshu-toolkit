/**
 * `ActionCallOptions.signal` 在 acquiring / holding 阶段 abort 时抛出
 *
 * 与 `LockDisposedError` 区分：本错误仅影响当前调用，actions 实例仍可继续使用
 * 对应 RFC.md「错误类型」章节
 */
class LockAbortedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'LockAbortedError';
  }
}

export { LockAbortedError };
