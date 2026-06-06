/**
 * rtcController — 通用 WebRTC 控制器
 *
 * 信令无关、类型安全、事件驱动的 WebRTC P2P 通信控制器。
 * 将连接生命周期管理 + 泛型事件系统 + 媒体/数据通道操作聚合为简洁 API，
 * 信令交换逻辑完全外部化，由使用者自行决定信令通道的实现方式。
 */

export { createRtcController } from './core/controller';

export {
  RtcChannelNotReadyError,
  RtcDisposedError,
  RtcInvalidStateError,
  RtcSignalingError,
  RtcTimeoutError,
} from './errors';

export type {
  AllEvents,
  BuiltinEvents,
  DataChannelEventMessage,
  EventHandler,
  EventMap,
  LoggerAdapter,
  ResolvedLoggerAdapter,
  RtcController,
  RtcControllerOptions,
  RtcEventEmitter,
  RtcPhase,
  SignalingAdapter,
  SignalingMessage,
} from './types';
