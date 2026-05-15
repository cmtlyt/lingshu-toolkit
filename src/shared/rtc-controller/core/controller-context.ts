/**
 * 控制器内部共享上下文
 *
 * 各 core 子模块（connection / data-channel / media）通过此接口
 * 访问和修改控制器的共享状态，避免循环依赖。
 *
 * 由 core/controller.ts 的 createRtcController 内部创建并注入。
 */

import type { ResolvedLoggerAdapter } from '../adapters/logger';
import type { EventMap, RtcPhase } from '../types';
import type { createEventEmitter } from './event-emitter';

/** 控制器内部共享上下文 */
interface ControllerContext<UserEvents extends EventMap = EventMap> {
  /** 当前连接阶段（可写，由 setPhase 更新） */
  phase: RtcPhase;
  /** 底层 RTCPeerConnection 引用 */
  peerConnection: RTCPeerConnection | null;
  /** 默认数据通道 */
  defaultChannel: RTCDataChannel | null;
  /** 多通道注册表：label → RTCDataChannel */
  channels: Map<string, RTCDataChannel>;
  /** ICE candidate 缓冲队列（remoteDescription 未设置时暂存） */
  pendingCandidates: RTCIceCandidateInit[];
  /** 事件发射器 */
  emitter: ReturnType<typeof createEventEmitter<UserEvents>>;
  /** 已解析的 logger */
  logger: ResolvedLoggerAdapter;
  /** 连接建立 Promise 的 resolve */
  resolveConnection: () => void;
  /** 连接建立 Promise 的 reject */
  rejectConnection: (error: Error) => void;
  /** 连接建立 Promise */
  connectionPromise: Promise<void>;
  /** dispose 函数引用（供 timeout 等场景调用） */
  disposeFn: () => void;
  /** __onUserEvent 钩子（供 rtc-room 拦截自定义事件） */
  onUserEventHook?: (event: string, payload: unknown) => boolean | undefined;
}

export type { ControllerContext };
