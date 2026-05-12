/** 连接超时（connect / reconnect 的 connectTimeout 到期，或被动接受 offer 时超时） */
class RtcTimeoutError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RtcTimeoutError';
  }
}

export { RtcTimeoutError };
