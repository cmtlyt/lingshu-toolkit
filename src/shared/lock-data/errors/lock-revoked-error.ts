/**
 * 持有锁期间被 `force` 抢占或 `holdTimeout` 触发时抛出
 *
 * 持有者后续对 draft 的写入也会继续抛出此错误，防止闭包泄露导致写入无效
 * 对应 RFC.md「错误类型」章节
 */
class LockRevokedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'LockRevokedError';
  }
}

export { LockRevokedError };
