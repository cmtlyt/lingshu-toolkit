/**
 * rtcRoom — WebRTC 多方通信房间控制器
 *
 * 在 rtc-controller 之上封装房间级多方通信抽象，
 * 采用 Mesh 拓扑策略，自动管理成员发现、P2P 连接建立、
 * 事件桥接与本地轨道同步。
 */

import type { EventMap } from '@/shared/rtc-controller';
import { createRoom } from './core/room';
import type { RtcRoom, RtcRoomOptions } from './types';

function createRtcRoom<UserEvents extends EventMap = Record<string, never>>(
  options: RtcRoomOptions,
): RtcRoom<UserEvents> {
  return createRoom<UserEvents>(options);
}

export {
  RoomDisposedError,
  RoomInvalidStateError,
  RoomPeerNotFoundError,
  RoomSignalingError,
  RoomTimeoutError,
} from './errors';
export type {
  AllRoomEvents,
  PeerSignalingMessage,
  RoomBuiltinEvents,
  RoomEventPayload,
  RoomPhase,
  RoomSignalingAdapter,
  RoomSignalingMessage,
  RtcRoom,
  RtcRoomOptions,
} from './types';
export { createRtcRoom };
