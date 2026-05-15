/** join() 超过 joinTimeout 仍未获取成员列表 */
class RoomTimeoutError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RoomTimeoutError';
  }
}

export { RoomTimeoutError };
