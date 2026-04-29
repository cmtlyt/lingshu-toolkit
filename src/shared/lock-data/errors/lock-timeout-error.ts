/**
 * 超过 `timeout` / `acquireTimeout` 仍未获得锁时抛出
 *
 * 对应 RFC.md「错误类型」章节
 */
class LockTimeoutError extends Error {
  // 为什么不用 `override readonly name = '...'` 类字段：
  // 类字段在 `useDefineForClassFields: true` 下会生成实例属性，导致 TS 推断
  // 该类与 `ErrorConstructor { new(message?: string): Error }` 签名不兼容，
  // 无法直接传给 shared/throw-error 的 `throwError` 第三参数
  constructor(message?: string) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

export { LockTimeoutError };
