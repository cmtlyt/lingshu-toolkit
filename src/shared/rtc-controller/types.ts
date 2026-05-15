/**
 * rtcController 公开类型定义
 *
 * 对应 RFC.md「API设计」+「附录A：完整接口索引」
 */

import type { LoggerAdapter } from '@/shared/logger';

// ── 基础类型 ──

/** 控制器连接状态机阶段 */
type RtcPhase = 'idle' | 'signaling' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

/** 用户自定义事件映射：事件名 → payload 类型 */
type EventMap = Record<string, any>;

/** payload 为 void 时 handler 无参数，否则携带 payload */
type EventHandler<P> = P extends void ? () => void : (payload: P) => void;

// ── 信令 ──

/** 信令消息的联合类型 */
type SignalingMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit };

/** 信令适配器：控制器与外部信令通道之间的桥梁 */
interface SignalingAdapter {
  /** 发送信令消息到远端 */
  send: (message: SignalingMessage) => void | Promise<void>;
  /** 注册信令消息接收回调，返回取消订阅函数 */
  onMessage: (callback: (message: SignalingMessage) => void) => () => void;
  /** 可选：信令通道销毁时的清理 */
  dispose?: () => void;
}

// ── 事件 ──

/** 内置事件（始终可用，不可被用户覆盖） */
interface BuiltinEvents {
  'phase-change': { phase: RtcPhase; prevPhase: RtcPhase };
  connected: null;
  disconnected: { reason: string };
  failed: { error: Error };
  closed: null;
  track: { track: MediaStreamTrack; streams: readonly MediaStream[] };
  'track-removed': { track: MediaStreamTrack };
  'data-channel-ready': { channel: RTCDataChannel; label: string };
  'data-channel-closed': { label: string };
  'ice-state-change': { state: RTCIceConnectionState };
  'ice-gathering-complete': null;
  'signaling-state-change': { state: RTCSignalingState };
  'raw-message': { data: unknown; channel: RTCDataChannel };
  error: { error: Error; context: string };
}

/**
 * 合并后的完整事件类型
 *
 * 类型层冲突处理：用 Omit 先剔除 UserEvents 中与 BuiltinEvents 同名的 key，
 * 再与 BuiltinEvents 交叉——内置事件始终优先，防止用户定义 'connected' 等
 * 同名事件导致类型变 never。运行时在初始化时检查冲突并 logger.warn 提示。
 */
type AllEvents<UserEvents extends EventMap = BuiltinEvents> = BuiltinEvents & Omit<UserEvents, keyof BuiltinEvents>;

// ── 数据通道消息协议 ──

/** 数据通道事件消息编码格式 */
interface DataChannelEventMessage {
  readonly __rtc_event__: true;
  readonly event: string;
  readonly payload: unknown;
}

// ── 配置 ──

/** createRtcController 的配置项 */
interface RtcControllerOptions {
  /** 必传。信令适配器，负责 SDP/ICE 的发送与接收 */
  readonly signaling: SignalingAdapter;
  /** 传给 new RTCPeerConnection() 的配置 */
  readonly rtcConfig?: RTCConfiguration;
  /** 默认数据通道的 label */
  readonly dataChannelLabel?: string;
  /** 默认数据通道的配置 */
  readonly dataChannelOptions?: RTCDataChannelInit;
  /** 作为 Offerer 时是否自动创建默认数据通道 */
  readonly autoCreateDataChannel?: boolean;
  /** connect()/reconnect() 等待 ICE 连接建立的超时时间（ms） */
  readonly connectTimeout?: number;
  /** 实例级 abort；aborted 等价于 dispose() */
  readonly signal?: AbortSignal;
  /** 日志适配器 */
  readonly logger?: LoggerAdapter;
}

/**
 * 内部使用的扩展配置项
 *
 * 供 rtc-room 等上层模块通过内部通道注入钩子，不对外暴露
 */
interface RtcControllerInternalOptions extends RtcControllerOptions {
  /**
   * 内部钩子：自定义事件先回调再分发
   *
   * rtc-room 通过此钩子拦截自定义事件，将 peerId 包装到 payload 中
   * 返回 true 表示已消费（不再触发 on 监听器），false/undefined 继续正常分发
   */
  readonly __onUserEvent?: (event: string, payload: unknown) => boolean | undefined;
}

// ── 控制器 ──

/** 事件监听接口 */
interface RtcEventEmitter<UserEvents extends EventMap = BuiltinEvents> {
  on: <K extends keyof AllEvents<UserEvents>>(event: K, handler: EventHandler<AllEvents<UserEvents>[K]>) => () => void;
  once: <K extends keyof AllEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllEvents<UserEvents>[K]>,
  ) => () => void;
  off: <K extends keyof AllEvents<UserEvents>>(event: K, handler: EventHandler<AllEvents<UserEvents>[K]>) => void;
}

/** RtcController 控制器主体 */
interface RtcController<UserEvents extends EventMap = BuiltinEvents> extends RtcEventEmitter<UserEvents> {
  /** 当前连接阶段（只读） */
  readonly phase: RtcPhase;
  /** 底层 RTCPeerConnection 引用（只读，供高级场景使用） */
  readonly peerConnection: RTCPeerConnection | null;

  // ── 连接管理 ──
  connect: () => Promise<void>;
  reconnect: () => Promise<void>;
  dispose: () => void;

  // ── 媒体流 ──
  addTrack: (track: MediaStreamTrack, ...streams: MediaStream[]) => RTCRtpSender;
  removeTrack: (sender: RTCRtpSender) => void;
  getRemoteStreams: () => readonly MediaStream[];

  // ── 数据通道 ──
  createDataChannel: (label: string, options?: RTCDataChannelInit) => RTCDataChannel;
  emit: <K extends keyof UserEvents>(
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ) => void;
  /** 向指定 label 的通道发送自定义事件 */
  emitTo: <K extends keyof UserEvents>(
    label: string,
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ) => void;
  /** 发送原始数据：无 label 走默认通道，有 label 走指定通道 */
  send: {
    (data: string | ArrayBuffer | Blob | ArrayBufferView): void;
    (label: string, data: string | ArrayBuffer | Blob | ArrayBufferView): void;
  };
  /** 按 label 获取通道，不传则返回默认通道 */
  getChannel: (label?: string) => RTCDataChannel | undefined;
  /** 获取所有已注册通道的 label 列表 */
  getChannelLabels: () => string[];

  // ── 状态查询 ──
  getStats: () => Promise<RTCStatsReport>;
}

export type { LoggerAdapter, ResolvedLoggerAdapter } from '@/shared/logger';
export type {
  AllEvents,
  BuiltinEvents,
  DataChannelEventMessage,
  EventHandler,
  EventMap,
  RtcController,
  RtcControllerInternalOptions,
  RtcControllerOptions,
  RtcEventEmitter,
  RtcPhase,
  SignalingAdapter,
  SignalingMessage,
};
