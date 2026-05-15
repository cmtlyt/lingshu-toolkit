/** 信令交换失败（cause 字段携带底层 RTCPeerConnection 的原始错误） */
class RtcSignalingError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RtcSignalingError';
  }
}

export { RtcSignalingError };
