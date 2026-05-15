/** 数据通道未就绪时发送数据（DataChannel 未创建或 readyState 非 'open'） */
class RtcChannelNotReadyError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RtcChannelNotReadyError';
  }
}

export { RtcChannelNotReadyError };
