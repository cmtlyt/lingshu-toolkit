/** 在非法状态下调用操作（如 idle 状态下 addTrack、closed 状态下 connect） */
class RtcInvalidStateError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RtcInvalidStateError';
  }
}

export { RtcInvalidStateError };
