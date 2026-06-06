/** send() / sendRaw() / reconnectPeer() / getPeerStats() 指定的 peerId 不在成员列表中 */
class RoomPeerNotFoundError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RoomPeerNotFoundError';
  }
}

export { RoomPeerNotFoundError };
