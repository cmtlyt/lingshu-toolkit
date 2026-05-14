# RFC: rtcRoom — 多方 WebRTC 房间控制器

> status: draft
>
> author: cmtlyt
>
> create time: 2026/05/12 12:14:00
>
> rfc version: 0.1.0
>
> scope: `src/shared/rtc-room`

## 版本历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 0.1.0 | 2026/05/12 | 初稿：多方通信架构设计、房间信令适配器、成员管理、拓扑策略、房间级事件系统、API 签名、生命周期状态机、错误体系、目录规划、测试策略 |

## 背景与动机

`rtc-controller`（[RFC](../rtc-controller/RFC.md)）提供了**单个 P2P 连接**的完整生命周期管理——信令外部化、泛型事件系统、状态机、媒体/数据通道操作。其非目标中明确预留了多方扩展点：

> 未来可引入 `RtcRoom` 上层抽象聚合多个控制器

在实际业务中，多方通信（视频会议、协同编辑、多人游戏）是高频场景。直接让业务方手动管理 N 个 `RtcController` 实例存在以下痛点：

- **成员发现**：谁在房间里？谁加入了？谁离开了？——需要一套标准的成员管理协议
- **连接拓扑**：N 个参与者之间如何建立连接？全网状（Mesh）每人维护 N-1 个连接？还是通过中心节点（SFU）中转？——拓扑选择影响性能和可扩展性
- **事件聚合**：业务方关心的是"房间里某人发了消息"，而不是"第 3 个 controller 的 data-channel 收到了数据"——需要房间级事件抽象
- **媒体流管理**：本地轨道需要广播给所有 peer，远端轨道需要按成员归属——需要统一的媒体流视图
- **生命周期**：加入/离开房间、房间销毁等操作应聚合所有底层 controller 的生命周期

本 RFC 的目标：**在 `rtc-controller` 之上构建一个多方通信的房间抽象层**，将"成员管理 + 连接拓扑 + 事件聚合 + 媒体流视图"聚合成简洁的 `RtcRoom` API，同时保持信令层和拓扑策略的完全可定制性。

## 目标与非目标

### 目标

- 提供 `createRtcRoom<Events>(options)` 单入口，返回 `RtcRoom<Events>` 实例
- **房间信令适配器**：通过 `options.roomSignaling` 注入房间级信令适配器，处理成员发现（join/leave/member-list）和 P2P 信令路由（按 peerId 寻址）
- **成员管理**：维护房间成员列表，提供 `members` 只读视图，触发 `member-joined` / `member-left` 事件
- **Mesh 拓扑**：本期实现全网状拓扑（每个成员与其他所有成员建立 P2P 连接），每个连接由一个 `RtcController` 实例管理
- **房间级泛型事件系统**：复用 `rtc-controller` 的泛型事件模式，自定义事件附带发送者信息（`from: peerId`）
- **媒体流广播**：本地轨道自动添加到所有 peer 连接；远端轨道按成员归属聚合
- **房间级 `reconnect` / `dispose`**：统一管理所有底层 controller 的生命周期
- 遵循项目既有风格：`throw-error` 报错、`logger` 日志、零外部依赖

### 非目标

- **不**实现具体的房间信令服务器（WebSocket 房间服务 / Socket.IO 等）
- **不**在本期实现 SFU / MCU 拓扑——API 设计预留拓扑策略扩展点（`TopologyStrategy` 接口），本期仅提供 `MeshStrategy` 内置实现
- **不**实现房间权限控制（主持人 / 静音他人 / 踢人等）——这些是业务层逻辑
- **不**实现自动重连策略（提供 `reconnectPeer()` / `reconnectAll()` API，策略由外部决定）
- **不**实现音视频质量自适应（码率 / 分辨率调整由业务方通过 `RTCRtpSender.setParameters` 自行管理）
- **不**实现录制 / 屏幕共享等高级功能

## 名词约定

| 名词 | 含义 |
| --- | --- |
| Room（房间） | `createRtcRoom` 返回的实例，管理一个多方通信会话的完整生命周期 |
| Member（成员） | 房间中的一个参与者，由唯一的 `peerId` 标识 |
| Local Member（本地成员） | 当前客户端自身，即 `options.peerId` 对应的成员 |
| Remote Member（远端成员） | 房间中除本地成员外的其他参与者 |
| Peer Connection（对等连接） | 本地成员与某个远端成员之间的 P2P 连接，由一个 `RtcController` 实例管理 |
| Mesh（全网状） | 拓扑策略：每个成员与其他所有成员各建一条 P2P 连接；N 人房间每人维护 N-1 个连接 |
| RoomSignaling（房间信令） | 房间级信令适配器，负责成员发现 + P2P 信令路由；与 `rtc-controller` 的 `SignalingAdapter`（点对点信令）是不同层级的抽象 |
| Topology Strategy（拓扑策略） | 决定成员之间如何建立连接的策略接口；本期内置 Mesh，未来可扩展 SFU |

## API 设计

### 总览

```ts
import { createRtcRoom } from '@cmtlyt/lingshu-toolkit/shared'

// 基础用法
const room = createRtcRoom({
  peerId: 'user-123',
  roomSignaling: myRoomSignaling,
})

// 带自定义事件的泛型用法
interface ChatEvents {
  'chat-message': { text: string; timestamp: number }
  'cursor-move': { x: number; y: number }
}

const room = createRtcRoom<ChatEvents>({
  peerId: 'user-123',
  roomSignaling: myRoomSignaling,
  rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
})

// 监听房间级事件
room.on('member-joined', ({ peerId }) => {
  console.log(`${peerId} 加入房间`)
})

room.on('chat-message', ({ from, payload }) => {
  // from: string (peerId), payload: { text: string; timestamp: number }
  console.log(`${from}: ${payload.text}`)
})

// 加入房间
await room.join()

// 广播自定义事件（发送到所有已连接的成员）
room.broadcast('chat-message', { text: 'hello everyone', timestamp: Date.now() })

// 向特定成员发送
room.send('user-456', 'chat-message', { text: 'private msg', timestamp: Date.now() })

// 添加本地媒体轨道（自动广播到所有 peer）
const stream = await navigator.mediaDevices.getUserMedia({ video: true })
room.addTrack(stream.getVideoTracks()[0], stream)

// 离开房间
room.leave()
```

核心语义：

- `createRtcRoom` 仅构建房间实例，**不立即加入房间**
- `room.join()` 通过房间信令加入房间，获取现有成员列表，与每个成员建立 P2P 连接
- 新成员加入时，已在房间的成员收到通知并主动与新成员建立连接
- `room.broadcast()` 通过各个 P2P 连接的 DataChannel 向所有已连接成员发送自定义事件
- `room.send()` 向特定成员发送自定义事件
- 自定义事件到达时，房间自动附加 `from` 字段标识发送者
- `room.leave()` 关闭所有 P2P 连接并通知房间信令离开

### 签名

```ts
function createRtcRoom<
  UserEvents extends EventMap = {},
>(options: RtcRoomOptions): RtcRoom<UserEvents>
```

### RtcRoomOptions

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `peerId` | `string` | — | **必传**。本地成员的唯一标识 |
| `roomSignaling` | `RoomSignalingAdapter` | — | **必传**。房间级信令适配器，负责成员发现和 P2P 信令路由 |
| `rtcConfig` | `RTCConfiguration` | `{ iceServers: [] }` | 传给每个底层 `RtcController` 的 WebRTC 配置 |
| `dataChannelLabel` | `string` | `'lingshu-rtc'` | 默认数据通道 label，传递给底层 controller |
| `dataChannelOptions` | `RTCDataChannelInit` | `{ ordered: true }` | 默认数据通道配置 |
| `autoCreateDataChannel` | `boolean` | `true` | 作为 Offerer 时是否自动创建默认数据通道 |
| `connectTimeout` | `number` | `30000` | 每个 P2P 连接的超时时间（ms），传递给底层 controller |
| `joinTimeout` | `number` | `10000` | `join()` 等待房间信令返回成员列表的超时时间（ms） |
| `signal` | `AbortSignal` | — | 实例级 abort；aborted 等价于 `leave()` |
| `logger` | `LoggerAdapter` | — | 日志适配器；传递给底层 controller + Room 自身使用 |

### RoomSignalingAdapter（房间信令适配器）

房间信令适配器是 Room 与外部房间管理服务之间的桥梁。与 `rtc-controller` 的 `SignalingAdapter`（点对点信令）是**不同层级**的抽象：

- **`SignalingAdapter`**（P2P 层）：负责两个特定 peer 之间的 SDP/ICE 交换
- **`RoomSignalingAdapter`**（房间层）：负责成员发现 + 将 P2P 信令消息路由到目标 peer

Room 内部通过 `RoomSignalingAdapter` 为每个 peer 动态派生出一个 `SignalingAdapter`，注入到对应的 `RtcController` 中。

```ts
interface RoomSignalingAdapter {
  /**
   * 加入房间，返回当前房间内已有成员的 peerId 列表
   * Room 内部在 join() 时调用
   */
  join(peerId: string): Promise<string[]>

  /**
   * 离开房间
   * Room 内部在 leave() / dispose 时调用
   */
  leave(peerId: string): void | Promise<void>

  /**
   * 向指定 peer 发送 P2P 信令消息
   * Room 内部为每个 peer 派生 SignalingAdapter 时，将其 send 委托到此方法
   */
  sendTo(targetPeerId: string, message: PeerSignalingMessage): void | Promise<void>

  /**
   * 注册房间级消息接收回调
   * 接收的消息包括：成员加入/离开通知、P2P 信令消息（携带 from 字段）
   * 返回取消订阅函数
   */
  onMessage(callback: (message: RoomSignalingMessage) => void): () => void

  /**
   * 可选：信令通道销毁时的清理
   */
  dispose?(): void
}
```

### 房间信令消息类型

```ts
/** P2P 信令消息（复用 rtc-controller 的 SignalingMessage，附加路由信息） */
interface PeerSignalingMessage {
  /** 消息发送者的 peerId */
  readonly from: string
  /** 原始 P2P 信令内容 */
  readonly signal: SignalingMessage
}

/** 房间级信令消息的联合类型 */
type RoomSignalingMessage =
  | { type: 'member-joined'; peerId: string }
  | { type: 'member-left'; peerId: string }
  | { type: 'peer-signal'; from: string; signal: SignalingMessage }
```

**设计理由**：

- `join` 返回 `Promise<string[]>` 而非同步，因为需要与房间服务交互获取成员列表
- `sendTo` 按 `targetPeerId` 寻址，Room 为每个 peer 的 `RtcController` 派生的 `SignalingAdapter.send` 会自动填充 `targetPeerId`
- `onMessage` 统一接收所有房间级消息（成员变动 + P2P 信令），Room 内部按 `type` 路由
- 与 `rtc-controller` 的 `SignalingAdapter` 完全解耦——Room 内部桥接，业务方只需实现 `RoomSignalingAdapter`

### 派生 SignalingAdapter（内部桥接）

Room 内部为每个远端 peer 创建 `RtcController` 时，需要将 `RoomSignalingAdapter` 桥接为该 peer 专用的 `SignalingAdapter`：

```ts
function deriveSignalingAdapter(
  roomSignaling: RoomSignalingAdapter,
  localPeerId: string,
  remotePeerId: string,
): SignalingAdapter {
  const handlers: Array<(msg: SignalingMessage) => void> = []

  return {
    send(message: SignalingMessage) {
      return roomSignaling.sendTo(remotePeerId, {
        from: localPeerId,
        signal: message,
      })
    },
    onMessage(callback) {
      handlers.push(callback)
      return () => {
        const index = handlers.indexOf(callback)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    // dispatchFromRoom 供 Room 内部调用：收到 peer-signal 时分发到对应 handler
    __handlers: handlers,
  }
}
```

> `__handlers` 是内部字段，不暴露给外部。Room 收到 `{ type: 'peer-signal', from, signal }` 时，找到 `from` 对应的派生适配器，遍历其 `__handlers` 分发 `signal`。

### 泛型事件系统

#### 房间级内置事件

```ts
/** 房间级内置事件（始终可用，不可被用户覆盖） */
interface RoomBuiltinEvents {
  /** 房间状态变更 */
  'room-phase-change': { phase: RoomPhase; prevPhase: RoomPhase }
  /** 成员加入 */
  'member-joined': { peerId: string }
  /** 成员离开 */
  'member-left': { peerId: string }
  /** 与某成员的 P2P 连接建立 */
  'peer-connected': { peerId: string }
  /** 与某成员的 P2P 连接断开 */
  'peer-disconnected': { peerId: string; reason: string }
  /** 与某成员的 P2P 连接失败 */
  'peer-failed': { peerId: string; error: Error }
  /** 收到远端媒体轨道（附带来源成员） */
  'track': { peerId: string; track: MediaStreamTrack; streams: readonly MediaStream[] }
  /** 远端轨道移除 */
  'track-removed': { peerId: string; track: MediaStreamTrack }
  /** 数据通道就绪 */
  'data-channel-ready': { peerId: string; channel: RTCDataChannel; label: string }
  /** 收到原始消息 */
  'raw-message': { peerId: string; data: unknown; channel: RTCDataChannel }
  /** 错误事件 */
  'error': { error: Error; context: string; peerId?: string }
}
```

#### 自定义事件包装

自定义事件在房间层会自动包装 `from` 字段，标识消息发送者：

```ts
/**
 * 房间级自定义事件 handler 的 payload 包装
 * 业务方 on('chat-message', handler) 中 handler 收到的是 RoomEventPayload<原始payload>
 */
type RoomEventPayload<P> = {
  /** 发送此事件的成员 peerId */
  readonly from: string
  /** 原始 payload */
  readonly payload: P
}

/**
 * 合并后的完整房间事件类型
 * 自定义事件的 payload 被包装为 RoomEventPayload<原始payload>
 */
type AllRoomEvents<UserEvents extends EventMap> =
  RoomBuiltinEvents &
  { [K in keyof Omit<UserEvents, keyof RoomBuiltinEvents>]: RoomEventPayload<UserEvents[K]> }
```

#### 事件 API

```ts
interface RoomEventEmitter<UserEvents extends EventMap> {
  on<K extends keyof AllRoomEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllRoomEvents<UserEvents>[K]>,
  ): () => void

  once<K extends keyof AllRoomEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllRoomEvents<UserEvents>[K]>,
  ): () => void

  off<K extends keyof AllRoomEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllRoomEvents<UserEvents>[K]>,
  ): void
}
```

### RtcRoom（房间主体）

```ts
interface RtcRoom<UserEvents extends EventMap = {}>
  extends RoomEventEmitter<UserEvents> {

  /** 当前房间阶段（只读） */
  readonly phase: RoomPhase

  /** 本地成员 peerId（只读） */
  readonly peerId: string

  /** 当前房间成员列表（只读，不含本地成员） */
  readonly members: readonly string[]

  // ── 房间管理 ──

  /**
   * 加入房间
   * 1. 通过房间信令发送 join，获取现有成员列表
   * 2. 为每个现有成员创建 RtcController 并发起连接（作为 Offerer）
   * 3. 所有连接建立后 resolve（或 joinTimeout 到期 reject）
   *
   * 边界行为：
   * - phase 非 idle 时抛 RoomInvalidStateError
   * - joinTimeout 到期仍未获取成员列表 → reject RoomTimeoutError
   * - 单个 peer 连接失败不阻塞整体 join（触发 'peer-failed' 事件，其余继续）
   */
  join(): Promise<void>

  /**
   * 离开房间
   * 1. 关闭所有 P2P 连接（dispose 所有 RtcController）
   * 2. 通知房间信令离开
   * 3. 清理事件监听
   *
   * 幂等语义：首次执行完整清理；第二次起 no-op
   */
  leave(): void

  // ── 消息 ──

  /**
   * 广播自定义事件到所有已连接成员
   * 内部遍历所有 peer controller 调用 emit
   * 跳过未 connected 的 peer（静默，不抛错）
   */
  broadcast<K extends keyof UserEvents>(
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ): void

  /**
   * 向指定成员发送自定义事件
   * 找到对应 peer 的 controller 调用 emit
   * 目标 peer 不存在或未 connected 时抛 RoomPeerNotFoundError
   */
  send<K extends keyof UserEvents>(
    targetPeerId: string,
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ): void

  /**
   * 向指定成员发送原始数据
   */
  sendRaw(targetPeerId: string, data: string | ArrayBuffer | Blob | ArrayBufferView): void

  /**
   * 广播原始数据到所有已连接成员
   */
  broadcastRaw(data: string | ArrayBuffer | Blob | ArrayBufferView): void

  // ── 媒体流 ──

  /**
   * 添加本地媒体轨道
   * 自动添加到所有已连接的 peer controller
   * 后续新加入的成员建立连接时，也会自动附加已有轨道
   * 返回 track 标识（用于后续 removeTrack）
   */
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): string

  /**
   * 移除本地媒体轨道
   * 从所有 peer controller 移除
   */
  removeTrack(trackId: string): void

  /**
   * 获取指定成员的远端媒体流
   */
  getRemoteStreams(peerId: string): readonly MediaStream[]

  /**
   * 获取所有远端媒体流（按成员归属）
   */
  getAllRemoteStreams(): ReadonlyMap<string, readonly MediaStream[]>

  // ── 连接管理 ──

  /**
   * 重连指定 peer
   * 内部调用对应 controller.reconnect()
   */
  reconnectPeer(peerId: string): Promise<void>

  /**
   * 重连所有已断开/失败的 peer
   * 并行调用所有非 connected 状态的 controller.reconnect()
   */
  reconnectAll(): Promise<void>

  /**
   * 获取指定 peer 的底层 RtcController（高级用法）
   */
  getPeerController(peerId: string): RtcController<UserEvents> | undefined

  // ── 状态查询 ──

  /**
   * 获取所有 peer 的连接状态
   */
  getPeerStates(): ReadonlyMap<string, RtcPhase>

  /**
   * 获取指定 peer 的连接统计
   */
  getPeerStats(peerId: string): Promise<RTCStatsReport>
}
```

### RoomPhase（房间状态机）

```ts
type RoomPhase =
  | 'idle'        // 初始状态，未加入房间
  | 'joining'     // 正在加入房间（等待信令返回成员列表 + 建立 P2P 连接）
  | 'joined'      // 已加入房间
  | 'leaving'     // 正在离开房间（清理连接中）
  | 'left'        // 已离开房间（终态，可复用实例重新 join）
  | 'disposed'    // 已销毁（终态，不可复用）
```

状态流转图：

```
  idle ──► joining ──► joined ──► leaving ──► left
   ▲                     │                      │
   │                     │                      │ join() 可重新加入
   │                     │                      ▼
   │                     │                     idle（重置）
   │                     │
   │                     ▼
   │                   disposed ◄── leave({ dispose: true }) / signal aborted
   │
   ▼
  disposed ◄── 任意状态 dispose()
```

**状态语义**：

- **idle → joining**：调用 `join()`，开始通过房间信令加入
- **joining → joined**：房间信令返回成员列表，所有 peer 连接建立（或超时/失败后降级完成）
- **joined → leaving**：调用 `leave()`，开始关闭所有连接
- **leaving → left**：所有连接已关闭，房间信令已通知离开
- **left → idle**：再次调用 `join()` 时，重置为 idle 后重新走 joining 流程
- **任意 → disposed**：调用 `dispose()` 或 `AbortSignal` aborted，终态不可逆

**与 `rtc-controller` 状态机的关系**：

- Room 的 `phase` 是房间级别的宏观状态
- 每个底层 `RtcController` 有独立的 `phase`（idle / signaling / connecting / connected / ...）
- Room 在 `joined` 状态下，各 peer controller 可能处于不同状态（有的 connected，有的 disconnected）
- Room 通过 `peer-connected` / `peer-disconnected` / `peer-failed` 事件暴露各 peer 的状态变化

## 成员管理

### 成员生命周期

```
                   join() 返回成员列表
                         │
    ┌────────────────────┼───────────────────────┐
    ▼                    ▼                       ▼
  peer-A              peer-B                   peer-C
    │                    │                       │
    ▼                    ▼                       ▼
  创建 controller      创建 controller          创建 controller
  connect() 作为       connect() 作为           connect() 作为
  Offerer              Offerer                  Offerer
    │                    │                       │
    ▼                    ▼                       ▼
  connected            connected                failed → 'peer-failed' 事件
                                                        （不阻塞 join resolve）
```

新成员加入时：

```
  roomSignaling 收到 'member-joined' 消息
    │
    ▼
  Room 创建新 controller
  被动等待新成员的 offer（新成员作为 Offerer）
    │
    ▼
  connected → 'peer-connected' 事件
```

**Offerer 决定规则**：

避免双方同时发起 offer 导致"glare"冲突，Room 采用**确定性规则**：

- `join()` 时与既有成员建立连接：**joiner 始终作为 Offerer**（主动发起方）
- 新成员加入通知：**新成员作为 Offerer**，已在房间的成员被动等待

这意味着 Room 内部创建 controller 后：
- 作为 Offerer 时调用 `controller.connect()`
- 作为 Answerer 时不调用 `connect()`，等待信令适配器内部自动处理收到的 offer

### 成员列表维护

```ts
// 内部数据结构
interface PeerEntry {
  readonly peerId: string
  readonly controller: RtcController<UserEvents>
  readonly derivedSignaling: DerivedSignalingAdapter
  /** 已添加到此 peer 的本地轨道 sender 映射：trackId → RTCRtpSender */
  readonly trackSenders: Map<string, RTCRtpSender>
}

// Room 内部维护
const peers = new Map<string, PeerEntry>()

// 公开的 members 是 peers 的 key 列表快照
get members(): readonly string[] {
  return Array.from(peers.keys())
}
```

## 拓扑策略（扩展点预留）

### TopologyStrategy 接口（本期不实现，仅预留）

本期仅实现 Mesh 拓扑，但 API 层预留拓扑策略接口，未来可扩展 SFU 等模式：

```ts
/**
 * 拓扑策略接口（预留，本期不外部暴露）
 *
 * 未来若需 SFU 拓扑，可实现此接口并通过 options.topology 注入。
 * 本期 Room 内部硬编码 MeshStrategy 逻辑，不抽象为独立策略对象。
 */
interface TopologyStrategy {
  /** 决定新成员加入时需要建立哪些连接 */
  getConnectionTargets(newPeerId: string, existingMembers: string[]): string[]
  /** 决定本地成员的角色（Offerer / Answerer） */
  getRole(localPeerId: string, remotePeerId: string): 'offerer' | 'answerer'
}
```

### Mesh 拓扑（本期实现）

Mesh 模式下的行为：

- **`getConnectionTargets`**：返回所有 `existingMembers`（全连接）
- **`getRole`**：joiner 始终为 Offerer
- **连接数**：N 人房间，每人维护 N-1 个连接，总连接数 N*(N-1)/2
- **适用场景**：小规模通信（2-6 人），每人直接与其他人建立连接
- **局限性**：参与者增多时带宽和 CPU 开销线性增长（每人需要编解码 N-1 路媒体流）

```
  3 人 Mesh 拓扑：

    A ──── B
    │ ╲    │
    │  ╲   │
    │   ╲  │
    │    ╲ │
    C ──── ╳（A-C、B-C 各一条连接）

  实际连接：A↔B, A↔C, B↔C（3 条）
```

## 错误类型

遵循项目约定，所有错误通过 `shared/throw-error` 模块抛出。错误消息统一带 `[@cmtlyt/lingshu-toolkit#rtcRoom]` 前缀。

> **错误子类与 `throwError` 的适配**：与 `rtc-controller` 相同，class 语法子类需 `RoomXxxError as unknown as ErrorConstructor` 局部类型适配。

```ts
/** 在非法的房间状态下调用操作（如 idle 状态下 broadcast） */
class RoomInvalidStateError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RoomInvalidStateError'
  }
}

/** 房间信令操作失败（join / leave / sendTo） */
class RoomSignalingError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RoomSignalingError'
  }
}

/** 房间已销毁后调用操作 */
class RoomDisposedError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RoomDisposedError'
  }
}

/** join 超时 */
class RoomTimeoutError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RoomTimeoutError'
  }
}

/** 目标 peer 不存在或未连接 */
class RoomPeerNotFoundError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RoomPeerNotFoundError'
  }
}
```

| 错误 | 触发时机 |
| --- | --- |
| `RoomInvalidStateError` | 在非法的 phase 下调用操作（如 `idle` 状态下 `broadcast`；`joining` 状态下再次 `join`） |
| `RoomSignalingError` | 房间信令 `join` / `leave` / `sendTo` 抛错；`cause` 字段携带原始错误 |
| `RoomDisposedError` | `dispose()` 后继续调用任何方法；`signal.aborted` 后任意调用 |
| `RoomTimeoutError` | `join()` 超过 `joinTimeout` 仍未获取成员列表 |
| `RoomPeerNotFoundError` | `send()` / `sendRaw()` / `reconnectPeer()` / `getPeerStats()` 指定的 peerId 不在成员列表中，或对应 controller 未 connected |

## logger 适配器

复用 `rtc-controller` 的 `LoggerAdapter` / `ResolvedLoggerAdapter` 接口和 `resolveLoggerAdapter` 字段级混合兜底逻辑。Room 实例自身使用 `fnName = 'rtcRoom'`，底层每个 controller 沿用 `'rtcController'`。

```ts
// Room 内部 logger 初始化
const logger = resolveLoggerAdapter(options.logger, 'rtcRoom')
```

## 内部实现要点

> 以下伪代码中使用了若干内部辅助函数，语义约定如下：
>
> | 辅助函数 | 语义 |
> | --- | --- |
> | `assertNotDisposed(caller)` | 若 `phase === 'disposed'` 则 `throwError` 抛 `RoomDisposedError` |
> | `assertJoined(caller)` | 若 `phase !== 'joined'` 则 `throwError` 抛 `RoomInvalidStateError` |
> | `setPhase(next)` | 更新 `phase` 并 `dispatch('room-phase-change', { phase: next, prevPhase: old })` |
> | `createPeerEntry(peerId)` | 为指定 peer 创建 `PeerEntry`：派生 `SignalingAdapter` + 创建 `RtcController` + 注册事件桥接 |
> | `removePeerEntry(peerId)` | dispose 对应 controller + 从 `peers` Map 移除 + 触发 `member-left` |
> | `bridgeControllerEvents(peerId, controller)` | 将 controller 的内置事件（connected / disconnected / failed / track / ...）桥接为 Room 级事件（附加 peerId） |
> | `applyLocalTracks(controller)` | 将当前已添加的所有本地轨道添加到新 controller（保证后加入的 peer 能收到已有轨道） |

### 加入房间流程（join）

```ts
async function join(): Promise<void> {
  // 1. 前置守卫
  assertNotDisposed('join')
  if (phase === 'left') {
    // 允许重新加入：重置为 idle
    setPhase('idle')
  }
  if (phase !== 'idle') {
    throwError('rtcRoom', `cannot join in phase "${phase}"`,
      RoomInvalidStateError as unknown as ErrorConstructor)
  }

  // 2. 通过房间信令加入，获取现有成员列表
  setPhase('joining')
  let existingMembers: string[]
  try {
    existingMembers = await Promise.race([
      roomSignaling.join(peerId),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(
          createError('rtcRoom', `join timed out after ${joinTimeout}ms`,
            RoomTimeoutError as unknown as ErrorConstructor)
        ), joinTimeout)
      }),
    ])
  } catch (error) {
    setPhase('idle')
    throw error
  }

  // 3. 注册房间信令消息监听（成员变动 + P2P 信令路由）
  unsubscribeRoomSignaling = roomSignaling.onMessage(handleRoomMessage)

  // 4. 为每个现有成员创建 controller 并发起连接（作为 Offerer）
  const connectPromises: Promise<void>[] = []
  for (let i = 0; i < existingMembers.length; i++) {
    const remotePeerId = existingMembers[i]
    if (remotePeerId === peerId) continue // 跳过自己
    const entry = createPeerEntry(remotePeerId)
    peers.set(remotePeerId, entry)
    // joiner 作为 Offerer
    connectPromises.push(
      entry.controller.connect().catch((error) => {
        // 单个 peer 连接失败不阻塞整体 join
        dispatch('peer-failed', { peerId: remotePeerId, error: error as Error })
        logger.warn(`peer ${remotePeerId} connect failed during join`, error)
      })
    )
  }

  await Promise.allSettled(connectPromises)
  setPhase('joined')
}
```

### 房间信令消息路由（handleRoomMessage）

```ts
function handleRoomMessage(message: RoomSignalingMessage): void {
  if (phase === 'disposed') return

  switch (message.type) {
    case 'member-joined': {
      const remotePeerId = message.peerId
      if (remotePeerId === peerId || peers.has(remotePeerId)) return
      // 创建 controller，被动等待新成员的 offer（新成员作为 Offerer）
      const entry = createPeerEntry(remotePeerId)
      peers.set(remotePeerId, entry)
      // 不调用 connect()——等待新成员主动发起 offer
      dispatch('member-joined', { peerId: remotePeerId })
      break
    }
    case 'member-left': {
      removePeerEntry(message.peerId)
      break
    }
    case 'peer-signal': {
      // 将 P2P 信令分发到对应 peer 的派生适配器
      const entry = peers.get(message.from)
      if (!entry) {
        // 可能是尚未创建 entry 的新成员发来的 offer
        // 先创建 entry 再分发
        const newEntry = createPeerEntry(message.from)
        peers.set(message.from, newEntry)
        dispatch('member-joined', { peerId: message.from })
        dispatchToAdapter(newEntry.derivedSignaling, message.signal)
        return
      }
      dispatchToAdapter(entry.derivedSignaling, message.signal)
      break
    }
  }
}

function dispatchToAdapter(adapter: DerivedSignalingAdapter, signal: SignalingMessage): void {
  const handlers = adapter.__handlers
  for (let i = 0; i < handlers.length; i++) {
    handlers[i](signal)
  }
}
```

### 创建 PeerEntry（createPeerEntry）

```ts
function createPeerEntry(remotePeerId: string): PeerEntry {
  const derivedSignaling = deriveSignalingAdapter(roomSignaling, peerId, remotePeerId)

  const controller = createRtcController<UserEvents>({
    signaling: derivedSignaling,
    rtcConfig: options.rtcConfig,
    dataChannelLabel: options.dataChannelLabel,
    dataChannelOptions: options.dataChannelOptions,
    autoCreateDataChannel: options.autoCreateDataChannel,
    connectTimeout: options.connectTimeout,
    logger: options.logger,
  })

  const trackSenders = new Map<string, RTCRtpSender>()

  // 桥接 controller 事件到 Room 级事件
  bridgeControllerEvents(remotePeerId, controller)

  // 将已有的本地轨道添加到新 controller
  applyLocalTracks(controller, trackSenders)

  return { peerId: remotePeerId, controller, derivedSignaling, trackSenders }
}
```

### 事件桥接（bridgeControllerEvents）

```ts
function bridgeControllerEvents(
  remotePeerId: string,
  controller: RtcController<UserEvents>,
): void {
  controller.on('connected', () => {
    dispatch('peer-connected', { peerId: remotePeerId })
  })

  controller.on('disconnected', ({ reason }) => {
    dispatch('peer-disconnected', { peerId: remotePeerId, reason })
  })

  controller.on('failed', ({ error }) => {
    dispatch('peer-failed', { peerId: remotePeerId, error })
  })

  controller.on('track', ({ track, streams }) => {
    dispatch('track', { peerId: remotePeerId, track, streams })
  })

  controller.on('track-removed', ({ track }) => {
    dispatch('track-removed', { peerId: remotePeerId, track })
  })

  controller.on('data-channel-ready', ({ channel, label }) => {
    dispatch('data-channel-ready', { peerId: remotePeerId, channel, label })
  })

  controller.on('raw-message', ({ data, channel }) => {
    dispatch('raw-message', { peerId: remotePeerId, data, channel })
  })

  controller.on('error', ({ error, context }) => {
    dispatch('error', { error, context, peerId: remotePeerId })
  })

  // 自定义事件桥接：controller 收到自定义事件时，包装 from 字段后分发
  // 通过监听 controller 的 raw-message，解析事件协议后分发到 Room 级事件系统
  // 注意：自定义事件走的是 DataChannel 事件协议（__rtc_event__ 标记），
  // controller 内部已解码并触发对应的用户事件名——Room 需要拦截并包装 from
}
```

> **自定义事件桥接的实现细节**：
>
> `rtc-controller` 收到 DataChannel 消息时，若检测到 `__rtc_event__` 标记，会自动解码并触发对应的用户事件（如 `'chat-message'`）。Room 需要对每个 controller 的所有 `UserEvents` key 注册监听器，将收到的 payload 包装为 `{ from: remotePeerId, payload }` 后通过 Room 的事件系统重新分发。
>
> 这意味着 Room 在 `createPeerEntry` 时需要遍历用户传入的事件 key。但由于 TypeScript 泛型在运行时不存在，Room 无法自动获取 `UserEvents` 的 key 列表。解决方案：**不在编译期遍历 key，而是在 controller 层新增一个内部钩子 `onUserEvent`**——当 controller 收到任何自定义事件时回调 `(event: string, payload: unknown) => void`，Room 注册此钩子即可。
>
> 这需要 `rtc-controller` 配合新增内部 API（不对外暴露）。在 `rtc-controller` 实施时预留此钩子。

### 本地轨道管理

```ts
// Room 内部维护本地轨道列表
interface LocalTrackEntry {
  readonly trackId: string
  readonly track: MediaStreamTrack
  readonly streams: MediaStream[]
}

const localTracks: LocalTrackEntry[] = []
let trackIdCounter = 0

function addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): string {
  assertNotDisposed('addTrack')
  assertJoined('addTrack')

  const trackId = `local-track-${++trackIdCounter}`
  localTracks.push({ trackId, track, streams })

  // 添加到所有活跃的 peer controller（idle/signaling/connecting/connected 均可）
  // - idle/signaling 阶段添加：轨道信息会包含在后续 offer/answer SDP 中
  // - connected 阶段添加：触发 renegotiation
  // - disconnected/failed/closed 阶段跳过：无效连接不再处理
  for (const [remotePeerId, entry] of peers) {
    const { phase } = entry.controller
    if (phase === 'disconnected' || phase === 'failed' || phase === 'closed') {
      continue
    }
    const sender = entry.controller.addTrack(track, ...streams)
    entry.trackSenders.set(trackId, sender)
  }

  return trackId
}

function removeTrack(trackId: string): void {
  assertNotDisposed('removeTrack')

  const idx = localTracks.findIndex((t) => t.trackId === trackId)
  if (idx < 0) return
  localTracks.splice(idx, 1)

  // 从所有 peer controller 移除
  for (const [, entry] of peers) {
    const sender = entry.trackSenders.get(trackId)
    if (sender) {
      entry.controller.removeTrack(sender)
      entry.trackSenders.delete(trackId)
    }
  }
}

/**
 * 将当前已有的本地轨道添加到新创建的 controller
 *
 * 调用时机：controller 创建后、connect() 调用前（controller 处于 idle 阶段）。
 * 这确保轨道信息在 offer/answer SDP 生成时已包含在 m-line 中，
 * 无需 connected 后再 renegotiation。
 */
function applyLocalTracks(
  controller: RtcController<UserEvents>,
  trackSenders: Map<string, RTCRtpSender>,
): void {
  for (let i = 0; i < localTracks.length; i++) {
    const { trackId, track, streams } = localTracks[i]
    const sender = controller.addTrack(track, ...streams)
    trackSenders.set(trackId, sender)
  }
}
```

### 离开房间流程（leave）

```ts
function leave(): void {
  if (phase === 'disposed' || phase === 'left' || phase === 'idle') return

  setPhase('leaving')

  // 1. dispose 所有 peer controller
  for (const [, entry] of peers) {
    entry.controller.dispose()
  }
  peers.clear()

  // 2. 取消房间信令监听
  if (unsubscribeRoomSignaling) {
    unsubscribeRoomSignaling()
    unsubscribeRoomSignaling = null
  }

  // 3. 通知房间信令离开（fire-and-forget）
  try {
    roomSignaling.leave(peerId)
  } catch (error) {
    logger.error('failed to notify room signaling on leave', error)
  }

  // 4. 清理本地轨道列表
  localTracks.length = 0

  setPhase('left')
}
```

### AbortSignal 集成

```ts
if (options.signal) {
  if (options.signal.aborted) {
    setPhase('disposed')
  } else {
    const onAbort = () => {
      leave()
      setPhase('disposed')
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    cleanupFns.push(() => options.signal!.removeEventListener('abort', onAbort))
  }
}
```

## 房间信令适配器设计

### 设计理念

房间信令需要处理两层职责：

1. **成员发现**：join / leave / member-list——知道房间里有谁
2. **P2P 信令路由**：将 SDP/ICE 消息按 peerId 寻址到目标端——让两个特定 peer 能交换信令

大多数实时通信后端（如 Socket.IO 的 room、WebSocket + Redis pub/sub）天然支持这两个能力。`RoomSignalingAdapter` 将其抽象为标准接口，使用者只需桥接到自己的后端即可。

### 示例实现

#### WebSocket + JSON 协议

```ts
function createWebSocketRoomSignaling(ws: WebSocket): RoomSignalingAdapter {
  const handlers: Array<(msg: RoomSignalingMessage) => void> = []

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data) as RoomSignalingMessage
    for (let i = 0; i < handlers.length; i++) {
      handlers[i](message)
    }
  })

  return {
    async join(peerId: string): Promise<string[]> {
      return new Promise((resolve) => {
        const onMessage = (event: MessageEvent) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'member-list') {
            ws.removeEventListener('message', onMessage)
            resolve(msg.members as string[])
          }
        }
        ws.addEventListener('message', onMessage)
        ws.send(JSON.stringify({ type: 'join', peerId }))
      })
    },
    leave(peerId: string) {
      ws.send(JSON.stringify({ type: 'leave', peerId }))
    },
    sendTo(targetPeerId: string, message: PeerSignalingMessage) {
      ws.send(JSON.stringify({
        type: 'peer-signal',
        target: targetPeerId,
        from: message.from,
        signal: message.signal,
      }))
    },
    onMessage(callback) {
      handlers.push(callback)
      return () => {
        const index = handlers.indexOf(callback)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    dispose() {
      handlers.length = 0
    },
  }
}
```

#### BroadcastChannel（同源跨标签页）

```ts
function createBroadcastRoomSignaling(channelName: string): RoomSignalingAdapter {
  const channel = new BroadcastChannel(channelName)
  const handlers: Array<(msg: RoomSignalingMessage) => void> = []
  /** 简易成员列表（本地维护，BroadcastChannel 无服务端） */
  const knownMembers = new Set<string>()

  channel.onmessage = (event) => {
    const msg = event.data as RoomSignalingMessage
    for (let i = 0; i < handlers.length; i++) {
      handlers[i](msg)
    }
  }

  return {
    async join(peerId: string): Promise<string[]> {
      // BroadcastChannel 无服务端，广播 join 通知
      channel.postMessage({ type: 'member-joined', peerId })
      // 等待一小段时间收集其他标签页的响应
      return new Promise((resolve) => {
        const members: string[] = []
        const onReply = (event: MessageEvent) => {
          if (event.data.type === 'member-joined' && event.data.peerId !== peerId) {
            members.push(event.data.peerId)
          }
        }
        channel.addEventListener('message', onReply)
        setTimeout(() => {
          channel.removeEventListener('message', onReply)
          resolve(members)
        }, 500)
      })
    },
    leave(peerId: string) {
      channel.postMessage({ type: 'member-left', peerId })
    },
    sendTo(targetPeerId: string, message: PeerSignalingMessage) {
      // BroadcastChannel 是广播，接收端按 target 过滤
      channel.postMessage({
        type: 'peer-signal',
        target: targetPeerId,
        from: message.from,
        signal: message.signal,
      })
    },
    onMessage(callback) {
      handlers.push(callback)
      return () => {
        const index = handlers.indexOf(callback)
        if (index >= 0) handlers.splice(index, 1)
      }
    },
    dispose() {
      handlers.length = 0
      channel.close()
    },
  }
}
```

## 与 rtc-controller 的协作契约

### Room 对 controller 的依赖

Room 使用 `createRtcController` 创建底层连接，依赖以下公开 API：

- `connect()` / `reconnect()` / `dispose()` — 连接生命周期
- `on()` / `off()` — 事件监听
- `emit()` / `send()` — 数据发送
- `addTrack()` / `removeTrack()` — 媒体轨道
- `phase` — 状态查询
- `getStats()` — 统计信息

### 需要 controller 配合的内部扩展

Room 需要 controller 提供一个**不对外暴露的内部钩子**，用于拦截自定义事件并包装 `from` 字段：

```ts
// 在 RtcControllerOptions 中新增内部选项（不写入公开 API 文档）
interface RtcControllerInternalOptions {
  /**
   * 内部钩子：当 controller 通过 DataChannel 收到自定义事件时回调
   * Room 层注册此钩子，将 payload 包装 from 字段后通过 Room 事件系统分发
   * 不对外暴露
   */
  __onUserEvent?: (event: string, payload: unknown) => void
}
```

实施时在 `rtc-controller` 的 DataChannel 消息解码逻辑中，检测到 `__rtc_event__` 标记后，先调用 `__onUserEvent`（如果存在），再正常触发 controller 自身的事件。Room 层注册此钩子后可以实现自定义事件的 `from` 包装。

## 目录与文件规划

```
src/shared/rtc-room/
├── index.ts                  # 公开导出入口
├── index.mdx                 # 文档
├── _meta.json                # 文档元信息
├── RFC.md                    # 本 RFC 文档
├── IMPLEMENTATION.md         # 实施清单（独立文件）
├── types.ts                  # 公开类型定义
├── errors.ts                 # 错误类型
├── constants.ts              # 常量
├── adapters/
│   └── logger.ts             # resolveLoggerAdapter（复用 rtc-controller 逻辑或直接 import）
├── core/
│   ├── room.ts               # RtcRoom 主体实现
│   ├── event-emitter.ts      # 房间级事件系统（可复用 rtc-controller 的实现）
│   ├── peer-manager.ts       # PeerEntry 管理（createPeerEntry / removePeerEntry / bridgeEvents）
│   ├── signaling-bridge.ts   # deriveSignalingAdapter + handleRoomMessage
│   └── media-manager.ts      # 本地轨道管理（addTrack / removeTrack / applyLocalTracks）
└── __test__/
    ├── index.test.ts             # 入口聚合层单元测试
    ├── index.browser.test.ts     # 浏览器环境完整流程测试
    ├── index.test-d.ts           # 类型测试
    ├── core/
    │   ├── peer-manager.test.ts
    │   ├── signaling-bridge.test.ts
    │   └── media-manager.test.ts
    ├── join-leave.browser.test.ts  # 加入/离开流程测试
    ├── multi-peer.browser.test.ts  # 多成员场景测试
    └── helpers/
        └── mock-room-signaling.ts  # 测试用 mock 房间信令适配器
```

## 测试策略

### 测试分层

| 层级 | 测试文件 | 环境 | 覆盖范围 |
| --- | --- | --- | --- |
| 信令桥接 | `__test__/core/signaling-bridge.test.ts` | Node | `deriveSignalingAdapter` 派生逻辑、消息路由 |
| 成员管理 | `__test__/core/peer-manager.test.ts` | Node | `createPeerEntry` / `removePeerEntry` / 事件桥接 |
| 媒体管理 | `__test__/core/media-manager.test.ts` | Node | 本地轨道列表维护、`applyLocalTracks` |
| 加入/离开 | `__test__/join-leave.browser.test.ts` | Browser | join / leave 完整流程、状态机流转 |
| 多成员 | `__test__/multi-peer.browser.test.ts` | Browser | 3+ 成员场景、动态加入/离开 |
| 入口聚合 | `__test__/index.browser.test.ts` | Browser | 完整房间流程（join → broadcast → leave） |
| 类型契约 | `__test__/index.test-d.ts` | TypeCheck | 泛型推断、事件 payload 类型、`RoomEventPayload` 包装 |

### 测试约定

- 浏览器 API 相关测试使用 `.browser.test.ts` 后缀
- 涉及超时的测试使用 `vi.useFakeTimers()`
- 房间信令适配器使用 mock 实现（内存消息路由，不走真实网络）
- 底层 `RtcController` 在非浏览器测试中可 mock（验证 Room 层逻辑即可）
- 类型测试（`expectTypeOf`）与逻辑测试分离

### Mock 房间信令适配器

```ts
/**
 * 用于测试的内存房间信令适配器
 * 模拟一个简易房间服务：维护成员列表 + 消息路由
 */
function createMockRoomSignaling(): {
  /** 为指定 peerId 创建一个 adapter 视角 */
  createAdapter(peerId: string): RoomSignalingAdapter
  /** 获取当前房间成员列表 */
  getMembers(): string[]
} {
  const members = new Set<string>()
  /** 每个成员的消息处理器 */
  const adapterHandlers = new Map<string, Array<(msg: RoomSignalingMessage) => void>>()

  function broadcastExcept(sender: string, message: RoomSignalingMessage): void {
    for (const [peerId, handlers] of adapterHandlers) {
      if (peerId === sender) continue
      for (let i = 0; i < handlers.length; i++) {
        handlers[i](message)
      }
    }
  }

  function createAdapter(peerId: string): RoomSignalingAdapter {
    const handlers: Array<(msg: RoomSignalingMessage) => void> = []
    adapterHandlers.set(peerId, handlers)

    return {
      async join(id: string): Promise<string[]> {
        members.add(id)
        broadcastExcept(id, { type: 'member-joined', peerId: id })
        return Array.from(members).filter((m) => m !== id)
      },
      leave(id: string) {
        members.delete(id)
        adapterHandlers.delete(id)
        broadcastExcept(id, { type: 'member-left', peerId: id })
      },
      sendTo(targetPeerId: string, message: PeerSignalingMessage) {
        const targetHandlers = adapterHandlers.get(targetPeerId)
        if (!targetHandlers) return
        const routedMessage: RoomSignalingMessage = {
          type: 'peer-signal',
          from: message.from,
          signal: message.signal,
        }
        for (let i = 0; i < targetHandlers.length; i++) {
          targetHandlers[i](routedMessage)
        }
      },
      onMessage(callback) {
        handlers.push(callback)
        return () => {
          const idx = handlers.indexOf(callback)
          if (idx >= 0) handlers.splice(idx, 1)
        }
      },
      dispose() {
        handlers.length = 0
        adapterHandlers.delete(peerId)
      },
    }
  }

  return { createAdapter, getMembers: () => Array.from(members) }
}
```

## 实施清单

> 待 RFC 评审通过后，拆分为独立的 `IMPLEMENTATION.md` 文件。

## 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Mesh 拓扑不适合大规模房间 | N 人房间每人 N-1 条连接，带宽和 CPU 线性增长 | 文档标注推荐 2-6 人；API 预留 `TopologyStrategy` 接口，未来可扩展 SFU |
| 成员加入时序竞争 | 两个成员几乎同时加入，可能出现双向同时发起 offer（glare） | Offerer 决定规则：joiner 始终为 Offerer；`peer-signal` 中 `from` 字段兜底去重 |
| 单个 peer 连接失败影响体验 | 某个成员网络差导致连接失败，用户不确定状态 | `peer-failed` 事件通知 + `reconnectPeer()` API；join 时单 peer 失败不阻塞整体 |
| 自定义事件桥接依赖 controller 内部钩子 | `__onUserEvent` 是非公开 API，controller 实现可能遗漏 | 在 rtc-controller 实施清单中明确标注此依赖；类型约束保证编译期可见 |
| 本地轨道添加时机与连接状态耦合 | `addTrack` 在 controller 已终态（failed/closed）时无意义 | Room 层 `applyLocalTracks` 在 controller 创建后、`connect()` 调用前执行（idle 阶段，SDP 生成时已包含轨道）；运行时 `addTrack` 对 idle/signaling/connecting/connected 均添加（connected 时触发 renegotiation）；仅 disconnected/failed/closed 跳过 |
| 房间信令适配器实现质量 | 外部实现可能有 bug（成员列表不一致 / 消息丢失） | 提供示例实现 + 测试用 mock；文档标注契约要求 |
| `leave` 后重新 `join` 的状态重置 | 残留的事件监听器、轨道列表可能导致状态泄漏 | `leave` 时完整清理所有内部状态；`join` 前置守卫检查 phase |
| BroadcastChannel 房间信令无服务端成员发现 | 纯客户端广播，首个加入的标签页无法发现后续标签页 | BroadcastChannel 示例实现中使用延迟探测（500ms 等待响应）；文档标注局限性 |

## 公开决策记录

### #1 为何在 rtc-controller 之上新建独立模块而非扩展 controller

**决策**：`rtc-room` 作为独立模块（`src/shared/rtc-room/`），依赖 `rtc-controller` 但不修改其代码（除内部钩子外）。

**理由**：
- 单一职责：controller 管理单个 P2P 连接，room 管理多方会话——两个不同层级的抽象
- 可选依赖：不需要多方通信的场景可以只用 controller，不引入 room 的代码
- 独立迭代：room 和 controller 可以独立升级版本，不互相阻塞
- 与 rtc-controller RFC 的非目标一致："未来可引入 `RtcRoom` 上层抽象聚合多个控制器"

### #2 为何 RoomSignalingAdapter 与 SignalingAdapter 是不同接口

**决策**：房间级信令（`RoomSignalingAdapter`）和 P2P 信令（`SignalingAdapter`）使用完全不同的接口定义。

**理由**：
- 职责不同：房间信令处理成员发现 + 消息路由（按 peerId 寻址），P2P 信令处理两个特定 peer 的 SDP/ICE 交换
- 消息类型不同：房间信令包含 `member-joined` / `member-left` 等房间级消息，P2P 信令只有 `offer` / `answer` / `ice-candidate`
- 使用方只需实现一个接口：`RoomSignalingAdapter`；P2P 层的 `SignalingAdapter` 由 Room 内部自动派生
- 避免混淆：如果共用接口，需要额外的类型判断来区分消息层级

### #3 自定义事件为何通过 `from` 包装而非事件名前缀

**决策**：自定义事件到达 Room 时，payload 包装为 `{ from: peerId, payload: 原始payload }`，事件名保持不变。

**理由**：
- 事件名一致：发送方 `room.broadcast('chat-message', payload)` 和接收方 `room.on('chat-message', handler)` 使用相同事件名
- 类型安全：`RoomEventPayload<P>` 在类型层自动推断，无需运行时转换
- `from` 是固定字段：不需要为每个事件类型手动声明 `from`——由类型系统自动包装
- 替代方案（事件名前缀如 `peer:user-123:chat-message`）会破坏类型推断且难以监听

### #4 Offerer 决定规则为何用 "joiner 作为 Offerer"

**决策**：加入房间时，joiner 主动发起 offer（作为 Offerer）；已在房间的成员被动等待。

**理由**：
- 确定性：避免双方同时发起 offer 导致 glare（SDP 冲突）
- 简单：不需要额外的协商协议来决定谁发起
- 与 rtc-controller 的 Answerer 自动处理对齐：controller 的信令适配器内部自动处理收到的 offer，已在房间的成员只需创建 controller + 等待即可

### #5 为何 `join()` 不等待所有 peer 连接成功才 resolve

**决策**：`join()` 在与所有现有成员**发起连接**后 resolve（`Promise.allSettled`），单个 peer 连接失败不导致 join reject。

**理由**：
- 容错性：某个成员网络差不应阻塞整个加入流程
- 及时性：用户尽快进入 `joined` 状态，可以接收新成员加入通知
- 可观测性：失败的 peer 通过 `peer-failed` 事件通知，业务方可决定是否 `reconnectPeer()`
- 替代方案（等待全部 connected）在网络不稳定环境下可能导致 join 永远 pending

### #6 为何本地轨道管理返回 trackId 而非 RTCRtpSender

**决策**：`room.addTrack()` 返回 `string`（trackId）而非 `RTCRtpSender`。

**理由**：
- Room 管理多个 controller，每个 controller 的 `addTrack` 返回不同的 `RTCRtpSender`——无法返回单个 sender
- trackId 是 Room 层的抽象标识，用于后续 `removeTrack(trackId)` 统一移除
- 高级场景可通过 `getPeerController(peerId)` 获取底层 controller 直接操作 sender

### #7 为何需要 controller 层的 `__onUserEvent` 内部钩子

**决策**：在 `rtc-controller` 的 DataChannel 消息解码逻辑中新增内部钩子 `__onUserEvent`，供 Room 层拦截自定义事件。

**理由**：
- TypeScript 泛型在运行时不存在，Room 无法自动获取 `UserEvents` 的 key 列表来逐个注册监听器
- 替代方案 1（在 Room 层监听 `raw-message` 手动解码）会重复 controller 已有的解码逻辑
- 替代方案 2（在 Room 层使用 `Proxy` 拦截 controller 的事件分发）侵入性过强
- `__onUserEvent` 是最小侵入方案：controller 仅在事件分发前增加一个 `if (__onUserEvent)` 判断，不影响公开 API

## 附录 A：完整接口索引

> 以下为所有公开类型的完整签名，实现时以此为准。

```ts
// ── 常量 ──

/** 默认 join 超时时间（ms） */
declare const DEFAULT_JOIN_TIMEOUT: 10000

// ── 基础类型（复用 rtc-controller） ──

// EventMap, EventHandler, SignalingMessage, SignalingAdapter, RtcPhase,
// RtcController, LoggerAdapter, ResolvedLoggerAdapter
// 均从 rtc-controller 导入

// ── 房间状态 ──

type RoomPhase = 'idle' | 'joining' | 'joined' | 'leaving' | 'left' | 'disposed'

// ── 房间信令 ──

interface PeerSignalingMessage {
  readonly from: string
  readonly signal: SignalingMessage
}

type RoomSignalingMessage =
  | { type: 'member-joined'; peerId: string }
  | { type: 'member-left'; peerId: string }
  | { type: 'peer-signal'; from: string; signal: SignalingMessage }

interface RoomSignalingAdapter {
  join(peerId: string): Promise<string[]>
  leave(peerId: string): void | Promise<void>
  sendTo(targetPeerId: string, message: PeerSignalingMessage): void | Promise<void>
  onMessage(callback: (message: RoomSignalingMessage) => void): () => void
  dispose?(): void
}

// ── 事件 ──

interface RoomBuiltinEvents {
  'room-phase-change': { phase: RoomPhase; prevPhase: RoomPhase }
  'member-joined': { peerId: string }
  'member-left': { peerId: string }
  'peer-connected': { peerId: string }
  'peer-disconnected': { peerId: string; reason: string }
  'peer-failed': { peerId: string; error: Error }
  'track': { peerId: string; track: MediaStreamTrack; streams: readonly MediaStream[] }
  'track-removed': { peerId: string; track: MediaStreamTrack }
  'data-channel-ready': { peerId: string; channel: RTCDataChannel; label: string }
  'raw-message': { peerId: string; data: unknown; channel: RTCDataChannel }
  'error': { error: Error; context: string; peerId?: string }
}

type RoomEventPayload<P> = {
  readonly from: string
  readonly payload: P
}

type AllRoomEvents<UserEvents extends EventMap> =
  RoomBuiltinEvents &
  { [K in keyof Omit<UserEvents, keyof RoomBuiltinEvents>]: RoomEventPayload<UserEvents[K]> }

// ── 配置 ──

interface RtcRoomOptions {
  readonly peerId: string
  readonly roomSignaling: RoomSignalingAdapter
  readonly rtcConfig?: RTCConfiguration
  readonly dataChannelLabel?: string
  readonly dataChannelOptions?: RTCDataChannelInit
  readonly autoCreateDataChannel?: boolean
  readonly connectTimeout?: number
  readonly joinTimeout?: number
  readonly signal?: AbortSignal
  readonly logger?: LoggerAdapter
}

// ── 错误 ──

declare class RoomInvalidStateError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RoomSignalingError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RoomDisposedError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RoomTimeoutError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RoomPeerNotFoundError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}

// ── 房间 ──

interface RtcRoom<UserEvents extends EventMap = {}> {
  readonly phase: RoomPhase
  readonly peerId: string
  readonly members: readonly string[]

  // 事件
  on<K extends keyof AllRoomEvents<UserEvents>>(event: K, handler: EventHandler<AllRoomEvents<UserEvents>[K]>): () => void
  once<K extends keyof AllRoomEvents<UserEvents>>(event: K, handler: EventHandler<AllRoomEvents<UserEvents>[K]>): () => void
  off<K extends keyof AllRoomEvents<UserEvents>>(event: K, handler: EventHandler<AllRoomEvents<UserEvents>[K]>): void

  // 房间管理
  join(): Promise<void>
  leave(): void

  // 消息
  broadcast<K extends keyof UserEvents>(event: K, ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]): void
  send<K extends keyof UserEvents>(targetPeerId: string, event: K, ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]): void
  sendRaw(targetPeerId: string, data: string | ArrayBuffer | Blob | ArrayBufferView): void
  broadcastRaw(data: string | ArrayBuffer | Blob | ArrayBufferView): void

  // 媒体
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): string
  removeTrack(trackId: string): void
  getRemoteStreams(peerId: string): readonly MediaStream[]
  getAllRemoteStreams(): ReadonlyMap<string, readonly MediaStream[]>

  // 连接管理
  reconnectPeer(peerId: string): Promise<void>
  reconnectAll(): Promise<void>
  getPeerController(peerId: string): RtcController<UserEvents> | undefined

  // 状态查询
  getPeerStates(): ReadonlyMap<string, RtcPhase>
  getPeerStats(peerId: string): Promise<RTCStatsReport>
}

declare function createRtcRoom<UserEvents extends EventMap = {}>(
  options: RtcRoomOptions,
): RtcRoom<UserEvents>
```

## 附录 B：使用示例

### 场景 1：多人视频会议

```ts
import { createRtcRoom } from '@cmtlyt/lingshu-toolkit/shared'

const roomSignaling = createWebSocketRoomSignaling(
  new WebSocket('wss://signal.example.com/room/meeting-123')
)

const room = createRtcRoom({
  peerId: 'user-alice',
  roomSignaling,
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com', username: 'user', credential: 'pass' },
    ],
  },
})

// 监听成员变动
room.on('member-joined', ({ peerId }) => {
  console.log(`${peerId} 加入了会议`)
  addVideoSlot(peerId)
})

room.on('member-left', ({ peerId }) => {
  console.log(`${peerId} 离开了会议`)
  removeVideoSlot(peerId)
})

// 监听远端视频轨道
room.on('track', ({ peerId, track, streams }) => {
  if (track.kind === 'video') {
    const video = getVideoElement(peerId)
    video.srcObject = streams[0]
  }
})

// 添加本地视频
const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
const tracks = localStream.getTracks()
for (let i = 0; i < tracks.length; i++) {
  room.addTrack(tracks[i], localStream)
}

// 加入房间
await room.join()

// 离开会议
leaveButton.onclick = () => room.leave()
```

### 场景 2：协同编辑（带自定义事件）

```ts
interface EditorEvents {
  'cursor-move': { line: number; column: number; color: string }
  'text-change': { range: { start: number; end: number }; text: string }
  'selection': { start: number; end: number }
}

const room = createRtcRoom<EditorEvents>({
  peerId: `editor-${userId}`,
  roomSignaling: myRoomSignaling,
})

// 类型安全的事件监听
room.on('cursor-move', ({ from, payload }) => {
  // from: string, payload: { line: number; column: number; color: string }
  renderRemoteCursor(from, payload.line, payload.column, payload.color)
})

room.on('text-change', ({ from, payload }) => {
  applyRemoteEdit(from, payload.range, payload.text)
})

await room.join()

// 广播光标位置
editor.onCursorChange((pos) => {
  room.broadcast('cursor-move', {
    line: pos.line,
    column: pos.column,
    color: myColor,
  })
})
```

### 场景 3：跨标签页多人房间

```ts
const roomSignaling = createBroadcastRoomSignaling('my-app-collab-room')

const room = createRtcRoom({
  peerId: `tab-${crypto.randomUUID()}`,
  roomSignaling,
  rtcConfig: { iceServers: [] }, // 同源无需 STUN/TURN
})

room.on('peer-connected', ({ peerId }) => {
  console.log(`标签页 ${peerId} 已连接`)
})

await room.join()
console.log(`当前房间 ${room.members.length} 个其他标签页`)
```

### 场景 4：断线重连

```ts
const room = createRtcRoom({
  peerId: 'user-bob',
  roomSignaling: myRoomSignaling,
})

room.on('peer-disconnected', ({ peerId, reason }) => {
  console.log(`${peerId} 断开: ${reason}`)
  // 3 秒后尝试重连
  setTimeout(() => {
    room.reconnectPeer(peerId).catch((err) => {
      console.error(`重连 ${peerId} 失败`, err)
    })
  }, 3000)
})

room.on('peer-failed', ({ peerId, error }) => {
  console.error(`${peerId} 连接失败`, error)
})

await room.join()
```
