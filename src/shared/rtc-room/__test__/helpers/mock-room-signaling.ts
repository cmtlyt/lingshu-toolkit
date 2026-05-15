/**
 * 测试用内存房间信令适配器
 *
 * 模拟一个简易房间服务：维护成员列表 + 消息路由
 * 对应 RFC.md「Mock房间信令适配器」
 */

import type { PeerSignalingMessage, RoomSignalingAdapter, RoomSignalingMessage } from '../../types';

interface MockRoomSignaling {
  /** 为指定 peerId 创建一个 adapter 视角 */
  createAdapter: (peerId: string) => RoomSignalingAdapter;
  /** 获取当前房间成员列表 */
  getMembers: () => string[];
}

function createMockRoomSignaling(): MockRoomSignaling {
  const members = new Set<string>();
  const adapterHandlers = new Map<string, Array<(msg: RoomSignalingMessage) => void>>();

  function broadcastExcept(sender: string, message: RoomSignalingMessage): void {
    for (const [peerId, handlers] of adapterHandlers) {
      if (peerId === sender) {
        continue;
      }
      for (let i = 0; i < handlers.length; i++) {
        handlers[i](message);
      }
    }
  }

  function createAdapter(peerId: string): RoomSignalingAdapter {
    const handlers: Array<(msg: RoomSignalingMessage) => void> = [];
    adapterHandlers.set(peerId, handlers);

    return {
      async join(id: string): Promise<string[]> {
        members.add(id);
        broadcastExcept(id, { type: 'member-joined', peerId: id });
        return Array.from(members).filter((member) => member !== id);
      },
      leave(id: string) {
        members.delete(id);
        adapterHandlers.delete(id);
        broadcastExcept(id, { type: 'member-left', peerId: id });
      },
      sendTo(targetPeerId: string, message: PeerSignalingMessage) {
        const targetHandlers = adapterHandlers.get(targetPeerId);
        if (!targetHandlers) {
          return;
        }
        const routedMessage: RoomSignalingMessage = {
          type: 'peer-signal',
          from: message.from,
          signal: message.signal,
        };
        for (let i = 0; i < targetHandlers.length; i++) {
          targetHandlers[i](routedMessage);
        }
      },
      onMessage(callback) {
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
        adapterHandlers.delete(peerId);
      },
    };
  }

  return { createAdapter, getMembers: () => Array.from(members) };
}

export type { MockRoomSignaling };
export { createMockRoomSignaling };
