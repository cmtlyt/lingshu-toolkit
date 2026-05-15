/** 在非法的 phase 下调用操作（如 idle 状态下 broadcast；joining 状态下再次 join） */
class RoomInvalidStateError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RoomInvalidStateError';
  }
}

export { RoomInvalidStateError };
