/**
 * rtc-room 公开类型定义
 *
 * 对应 RFC.md「API设计」+「附录A：完整接口索引」
 */

import type {
  EventHandler,
  EventMap,
  LoggerAdapter,
  RtcController,
  RtcPhase,
  SignalingAdapter,
  SignalingMessage,
} from '@/shared/rtc-controller';

// ── 房间状态 ──

/** 房间生命周期阶段 */
type RoomPhase = 'idle' | 'joining' | 'joined' | 'leaving' | 'left' | 'disposed';

// ── 房间信令 ──

/** P2P 信令包装：标注发送者 + 原始信令 */
interface PeerSignalingMessage {
  readonly from: string;
  readonly signal: SignalingMessage;
}

/** 房间信令消息的联合类型 */
type RoomSignalingMessage =
  | { type: 'member-joined'; peerId: string }
  | { type: 'member-left'; peerId: string }
  | { type: 'peer-signal'; from: string; signal: SignalingMessage };

/** 房间信令适配器：成员发现 + 消息路由 */
interface RoomSignalingAdapter {
  /** 加入房间，返回当前成员列表（不含自己） */
  join: (peerId: string) => Promise<string[]>;
  /** 离开房间 */
  leave: (peerId: string) => void | Promise<void>;
  /** 向目标成员发送 P2P 信令 */
  sendTo: (targetPeerId: string, message: PeerSignalingMessage) => void | Promise<void>;
  /** 注册房间消息接收回调，返回取消订阅函数 */
  onMessage: (callback: (message: RoomSignalingMessage) => void) => () => void;
  /** 可选：信令通道销毁时的清理 */
  dispose?: () => void;
}

// ── 事件 ──

/** 房间内置事件（11 个，始终优先） */
interface RoomBuiltinEvents {
  'room-phase-change': { phase: RoomPhase; prevPhase: RoomPhase };
  'member-joined': { peerId: string };
  'member-left': { peerId: string };
  'peer-connected': { peerId: string };
  'peer-disconnected': { peerId: string; reason: string };
  'peer-failed': { peerId: string; error: Error };
  track: { peerId: string; track: MediaStreamTrack; streams: readonly MediaStream[] };
  'track-removed': { peerId: string; track: MediaStreamTrack };
  'data-channel-ready': { peerId: string; channel: RTCDataChannel; label: string };
  'raw-message': { peerId: string; data: unknown; channel: RTCDataChannel };
  error: { error: Error; context: string; peerId?: string };
}

/** 自定义事件到达 Room 时的 payload 包装 */
interface RoomEventPayload<P> {
  readonly from: string;
  readonly payload: P;
}

/**
 * 合并后的完整事件类型
 *
 * 内置事件始终优先；用户自定义事件自动包装为 RoomEventPayload
 */
type AllRoomEvents<UserEvents extends EventMap> = RoomBuiltinEvents & {
  [K in keyof Omit<UserEvents, keyof RoomBuiltinEvents>]: RoomEventPayload<UserEvents[K]>;
};

// ── 配置 ──

/** createRtcRoom 的配置项 */
interface RtcRoomOptions {
  /** 本地 peer 唯一标识 */
  readonly peerId: string;
  /** 房间信令适配器 */
  readonly roomSignaling: RoomSignalingAdapter;
  /** 传给 RTCPeerConnection 的配置 */
  readonly rtcConfig?: RTCConfiguration;
  /** 默认数据通道的 label */
  readonly dataChannelLabel?: string;
  /** 默认数据通道的配置 */
  readonly dataChannelOptions?: RTCDataChannelInit;
  /** 作为 Offerer 时是否自动创建默认数据通道 */
  readonly autoCreateDataChannel?: boolean;
  /** connect() 等待 ICE 连接建立的超时时间（ms） */
  readonly connectTimeout?: number;
  /** join() 等待成员列表的超时时间（ms） */
  readonly joinTimeout?: number;
  /** 实例级 abort；aborted 等价于 dispose() */
  readonly signal?: AbortSignal;
  /** 日志适配器 */
  readonly logger?: LoggerAdapter;
}

// ── 内部类型 ──

/** 单个 peer 的内部管理条目 */
interface PeerEntry {
  readonly peerId: string;
  readonly controller: RtcController<EventMap>;
  readonly derivedSignaling: DerivedSignalingAdapter;
  /** trackId → RTCRtpSender 映射（用于 removeTrack） */
  readonly trackSenders: Map<string, RTCRtpSender>;
}

/** 本地轨道条目 */
interface LocalTrackEntry {
  readonly trackId: string;
  readonly track: MediaStreamTrack;
  readonly streams: MediaStream[];
}

/** 扩展 SignalingAdapter 的内部派生适配器，含 __handlers 供 Room 分发信令 */
interface DerivedSignalingAdapter extends SignalingAdapter {
  /** 内部字段：Room 收到 peer-signal 时直接遍历分发 */
  readonly __handlers: Array<(message: SignalingMessage) => void>;
}

// ── 房间接口 ──

/** RtcRoom 控制器主体 */
interface RtcRoom<UserEvents extends EventMap = Record<string, never>> {
  /** 当前房间阶段（只读） */
  readonly phase: RoomPhase;
  /** 本地 peerId（只读） */
  readonly peerId: string;
  /** 当前房间成员列表（不含自己，只读快照） */
  readonly members: readonly string[];

  // ── 事件 ──
  on: <K extends keyof AllRoomEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllRoomEvents<UserEvents>[K]>,
  ) => () => void;
  once: <K extends keyof AllRoomEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllRoomEvents<UserEvents>[K]>,
  ) => () => void;
  off: <K extends keyof AllRoomEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllRoomEvents<UserEvents>[K]>,
  ) => void;

  // ── 房间管理 ──
  join: () => Promise<void>;
  leave: () => void;
  dispose: () => void;

  // ── 消息 ──
  broadcast: <K extends keyof UserEvents>(
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ) => void;
  send: <K extends keyof UserEvents>(
    targetPeerId: string,
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ) => void;
  sendRaw: (targetPeerId: string, data: string | ArrayBuffer | Blob | ArrayBufferView) => void;
  broadcastRaw: (data: string | ArrayBuffer | Blob | ArrayBufferView) => void;

  // ── 媒体 ──
  addTrack: (track: MediaStreamTrack, ...streams: MediaStream[]) => string;
  removeTrack: (trackId: string) => void;
  getRemoteStreams: (peerId: string) => readonly MediaStream[];
  getAllRemoteStreams: () => ReadonlyMap<string, readonly MediaStream[]>;

  // ── 连接管理 ──
  reconnectPeer: (peerId: string) => Promise<void>;
  reconnectAll: () => Promise<void>;
  getPeerController: (peerId: string) => RtcController<UserEvents> | undefined;

  // ── 状态查询 ──
  getPeerStates: () => ReadonlyMap<string, RtcPhase>;
  getPeerStats: (peerId: string) => Promise<RTCStatsReport>;
}

export type {
  AllRoomEvents,
  DerivedSignalingAdapter,
  LocalTrackEntry,
  PeerEntry,
  PeerSignalingMessage,
  RoomBuiltinEvents,
  RoomEventPayload,
  RoomPhase,
  RoomSignalingAdapter,
  RoomSignalingMessage,
  RtcRoom,
  RtcRoomOptions,
};
