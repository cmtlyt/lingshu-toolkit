/** dispose() 后继续调用任何方法；signal.aborted 后任意调用 */
class RoomDisposedError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RoomDisposedError';
  }
}

export { RoomDisposedError };
