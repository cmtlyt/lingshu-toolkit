/**
 * `options` 不合法时抛出（如 `timeout < 0`、未知的 `syncMode` 等）
 *
 * 归类为 TypeError 的原因：这是调用方传参问题，而非运行时故障，
 * 与 JavaScript 原生对非法 API 用法抛 TypeError 的惯例对齐
 * 对应 RFC.md「错误类型」章节
 */
class InvalidOptionsError extends TypeError {
  constructor(message?: string) {
    super(message);
    this.name = 'InvalidOptionsError';
  }
}

export { InvalidOptionsError };
