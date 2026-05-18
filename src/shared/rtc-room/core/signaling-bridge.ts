/**
 * P2P 信令适配器派生层
 *
 * 对应 RFC.md「派生SignalingAdapter」章节
 *
 * 将房间级信令（RoomSignalingAdapter）桥接为 P2P 级信令（SignalingAdapter），
 * 每个远端 peer 对应一个独立的 DerivedSignalingAdapter 实例
 */

import type { SignalingMessage } from '@/shared/rtc-controller';
import type { DerivedSignalingAdapter, RoomSignalingAdapter } from '../types';

/**
 * 为指定远端 peer 派生一个 P2P 信令适配器
 *
 * send() 委托到 roomSignaling.sendTo(remotePeerId, { from, signal })
 * onMessage() 注册到内部 __handlers，由 Room 收到 peer-signal 时分发
 */
function deriveSignalingAdapter(
  roomSignaling: RoomSignalingAdapter,
  localPeerId: string,
  remotePeerId: string,
): DerivedSignalingAdapter {
  const handlers: Array<(message: SignalingMessage) => void> = [];

  return {
    send(message: SignalingMessage): void | Promise<void> {
      return roomSignaling.sendTo(remotePeerId, { from: localPeerId, signal: message });
    },
    onMessage(callback: (message: SignalingMessage) => void): () => void {
      handlers.push(callback);
      return () => {
        const idx = handlers.indexOf(callback);
        if (idx >= 0) {
          handlers.splice(idx, 1);
        }
      };
    },
    dispose() {
      handlers.length = 0;
    },
    __handlers: handlers,
  };
}

/**
 * 将信令消息分发到派生适配器的所有 handler
 *
 * Room 收到 { type: 'peer-signal', from, signal } 时调用此函数
 */
function dispatchToAdapter(adapter: DerivedSignalingAdapter, signal: SignalingMessage): void {
  const handlers = adapter.__handlers.slice();
  for (let i = 0; i < handlers.length; i++) {
    handlers[i](signal);
  }
}

export { deriveSignalingAdapter, dispatchToAdapter };
