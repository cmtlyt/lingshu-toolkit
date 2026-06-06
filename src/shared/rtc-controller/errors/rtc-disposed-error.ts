/** 控制器已销毁后调用操作（cause 字段在 signal.aborted 触发时携带 abort reason） */
class RtcDisposedError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RtcDisposedError';
  }
}

export { RtcDisposedError };
