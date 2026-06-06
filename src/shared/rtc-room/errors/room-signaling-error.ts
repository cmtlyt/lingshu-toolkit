/** 房间信令 join / leave / sendTo 抛错；cause 字段携带原始错误 */
class RoomSignalingError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RoomSignalingError';
  }
}

export { RoomSignalingError };
