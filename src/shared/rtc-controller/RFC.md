# RFC: rtcController — 通用 WebRTC 控制器

> status: accepted
>
> author: cmtlyt
>
> create time: 2026/05/12 09:31:00
>
> rfc version: 0.1.0
>
> scope: `src/shared/rtc-controller`

## 版本历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 0.1.0 | 2026/05/12 | 初稿：核心架构设计、泛型事件系统、信令交换外部化、API 签名、生命周期状态机、错误体系、目录规划、测试策略 |

## 背景与动机

WebRTC 是浏览器原生支持的实时通信技术，但其 API 涉及大量样板代码：

- **信令交换**（Signaling）：SDP offer/answer 的创建与交换、ICE candidate 的收集与传递——这些都依赖外部信令通道（WebSocket / HTTP / 手动复制），没有统一标准
- **连接生命周期管理**：`RTCPeerConnection` 的状态机复杂（`new` → `connecting` → `connected` → `disconnected` → `failed` → `closed`），需要监听多个事件并正确处理
- **媒体流与数据通道**：`addTrack` / `removeTrack` / `createDataChannel` 等操作与连接状态耦合
- **错误处理与重连**：ICE 失败、连接断开等异常情况需要合理的重连策略

现有的 WebRTC 封装库（如 `simple-peer`、`peerjs`）要么过度封装了信令层（强绑 WebSocket / 特定服务器），要么缺乏类型安全的事件系统。

本 RFC 的目标：**提供一个信令无关、类型安全、事件驱动的 WebRTC 控制器**，将"连接生命周期管理 + 类型安全事件系统 + 媒体/数据通道操作"聚合成一个简洁的 API，同时将信令交换逻辑完全外部化，由使用者自行决定信令通道的实现方式。

## 目标与非目标

### 目标

- 提供 `createRtcController<Events>(options)` 单入口，返回 `RtcController<Events>` 实例
- **信令交换完全外部化**：通过 `options.signaling` 注入信令适配器，控制器只关心 SDP/ICE 数据的收发，不关心传输通道
- **泛型事件系统**：通过泛型参数 `Events` 定义自定义事件与 payload 类型，内置事件（连接状态变更、媒体流变更等）类型安全
- **连接生命周期管理**：自动处理 `RTCPeerConnection` 的创建、offer/answer 交换、ICE candidate 收集与应用
- **媒体流操作**：支持添加/移除本地媒体轨道，监听远端媒体流变更
- **数据通道**：支持创建和接收 `RTCDataChannel`，提供类型安全的消息收发
- **状态机**：清晰的连接状态流转，通过事件系统通知外部
- 遵循项目既有风格：`throw-error` 报错、`logger` 日志、无实现细节外泄

### 非目标

- **不**实现具体的信令服务器或信令协议（WebSocket / Socket.IO / HTTP polling 等）
- **不**在本期实现 SFU / MCU 多方通信架构（本期只做点对点 P2P）；但 API 设计预留多方扩展点——控制器管理单个 `RTCPeerConnection`，多方场景通过外部创建多个控制器实例实现（Mesh 模式），未来可引入 `RtcRoom` 上层抽象聚合多个控制器
- **不**实现屏幕共享等高级媒体获取逻辑（`getUserMedia` / `getDisplayMedia` 由调用方自行管理）
- **不**实现自动重连策略（提供 `reconnect()` API 和 `disconnected` / `failed` 事件钩子，重连时机与退避策略由外部决定）
- **不**实现 SRTP / DTLS 等底层安全协议的自定义配置（依赖浏览器原生实现）

## 名词约定

| 名词 | 含义 |
| --- | --- |
| Controller（控制器） | `createRtcController` 返回的实例，管理单个 `RTCPeerConnection` 的完整生命周期 |
| Signaling（信令） | SDP offer/answer 与 ICE candidate 的交换机制；本模块通过适配器抽象，不绑定具体实现 |
| Offer/Answer | SDP 协商的两端角色；Offerer 发起连接请求，Answerer 回复 |
| ICE Candidate | 网络候选路径信息，由浏览器 ICE agent 自动收集，需通过信令通道传递给对端 |
| DataChannel（数据通道） | `RTCPeerConnection` 上的双向数据传输通道，支持任意序列化数据 |
| Track（轨道） | 媒体流中的单个音频/视频轨道 |
| Phase（阶段） | 控制器的连接状态机阶段 |

## API 设计

### 总览

```ts
import { createRtcController } from '@cmtlyt/lingshu-toolkit/shared'

// 基础用法（无自定义事件）
const controller = createRtcController({
  signaling: mySignalingAdapter,
})

// 带自定义事件的泛型用法
interface MyEvents {
  'chat-message': { userId: string; text: string }
  'file-transfer': { fileName: string; data: ArrayBuffer }
}

const controller = createRtcController<MyEvents>({
  signaling: mySignalingAdapter,
  rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
})

// 监听事件（内置 + 自定义，均类型安全）
controller.on('connected', () => console.log('已连接'))
controller.on('chat-message', (payload) => {
  // payload 自动推断为 { userId: string; text: string }
  console.log(payload.text)
})

// 发起连接（作为 Offerer）
await controller.connect()

// 发送自定义事件
controller.emit('chat-message', { userId: '1', text: 'hello' })
```

核心语义：

- `createRtcController` 仅构建控制器实例，**不立即发起连接**
- 连接由 `controller.connect()` 发起（作为 Offerer）；被动接受方（Answerer）由信令适配器内部自动处理收到的 offer，**无需外部手动调用**
- 信令适配器是唯一的外部依赖注入点，控制器通过它发送/接收 SDP 和 ICE candidate；所有信令消息路由（offer / answer / ice-candidate）由控制器在初始化时通过 `signaling.onMessage` 内部注册，对外透明
- 泛型 `Events` 仅约束自定义事件；内置事件（`connected` / `disconnected` / `failed` 等）始终可用且类型安全
- `controller.emit` 仅能发送自定义事件（通过 DataChannel），内置事件由控制器内部触发，外部不可伪造
- `controller.reconnect()` 提供手动重连能力，关闭旧连接并重新走 connect 流程；重连策略（退避 / 间隔 / 条件）由外部控制

### 签名

```ts
function createRtcController<
  UserEvents extends EventMap = {},
>(options: RtcControllerOptions): RtcController<UserEvents>
```

### RtcControllerOptions

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `signaling` | `SignalingAdapter` | — | **必传**。信令适配器，负责 SDP/ICE 的发送与接收 |
| `rtcConfig` | `RTCConfiguration` | `{ iceServers: [] }` | 传给 `new RTCPeerConnection()` 的配置 |
| `dataChannelLabel` | `string` | `'lingshu-rtc'` | 默认数据通道的 label |
| `dataChannelOptions` | `RTCDataChannelInit` | `{ ordered: true }` | 默认数据通道的配置 |
| `autoCreateDataChannel` | `boolean` | `true` | 作为 Offerer 时是否自动创建默认数据通道 |
| `connectTimeout` | `number` | `30000` | `connect()` / `reconnect()` 等待 ICE 连接建立的超时时间（ms）；超时 reject `RtcTimeoutError` 并自动 `dispose()`。被动接受 offer 时同样受此超时保护 |
| `signal` | `AbortSignal` | — | 实例级 abort；aborted 等价于 `dispose()` |
| `logger` | `LoggerAdapter` | — | 日志适配器；`warn` / `error` 必选，`debug` 可选；不传使用 `shared/logger` 默认实现；部分传入时按字段级混合兜底（详见「logger 适配器」章节） |

### SignalingAdapter（信令适配器）

信令适配器是控制器与外部信令通道之间的桥梁。控制器不关心信令如何传输，只通过此接口收发数据。

```ts
interface SignalingAdapter {
  /**
   * 发送信令消息到远端
   * 控制器在需要发送 SDP offer/answer 或 ICE candidate 时调用此方法
   */
  send(message: SignalingMessage): void | Promise<void>

  /**
   * 注册信令消息接收回调
   * 控制器初始化时调用此方法注册回调，当远端信令到达时应调用该回调
   * 返回取消订阅函数
   */
  onMessage(callback: (message: SignalingMessage) => void): () => void

  /**
   * 可选：信令通道销毁时的清理
   */
  dispose?(): void
}

/** 信令消息的联合类型 */
type SignalingMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
```

**设计理由**：

- `send` 支持同步和异步，适配不同的信令通道实现（WebSocket 同步发送 vs HTTP POST 异步发送）
- `onMessage` 返回取消订阅函数，遵循项目内的订阅模式（类似 `lock-data` 的 `listeners`）
- `dispose` 可选，供控制器 `dispose()` 时级联清理信令通道

### 泛型事件系统

#### 事件类型定义

```ts
/** 用户自定义事件映射：事件名 → payload 类型 */
type EventMap = Record<string, unknown>

/** 内置事件（始终可用，不可被用户覆盖） */
interface BuiltinEvents {
  /** 连接状态变更 */
  'phase-change': { phase: RtcPhase; prevPhase: RtcPhase }
  /** 连接成功建立 */
  'connected': void
  /** 连接断开 */
  'disconnected': { reason: string }
  /** 连接失败 */
  'failed': { error: Error }
  /** 连接关闭 */
  'closed': void
  /** 收到远端媒体轨道 */
  'track': { track: MediaStreamTrack; streams: readonly MediaStream[] }
  /** 远端轨道移除 */
  'track-removed': { track: MediaStreamTrack }
  /** 数据通道就绪（默认通道或新接收的通道） */
  'data-channel-ready': { channel: RTCDataChannel; label: string }
  /** 数据通道关闭 */
  'data-channel-closed': { label: string }
  /** ICE 连接状态变化 */
  'ice-state-change': { state: RTCIceConnectionState }
  /** ICE 候选收集完成 */
  'ice-gathering-complete': void
  /** 信令状态变化 */
  'signaling-state-change': { state: RTCSignalingState }
  /** 收到自定义数据通道消息（非事件系统消息） */
  'raw-message': { data: unknown; channel: RTCDataChannel }
  /** 错误事件 */
  'error': { error: Error; context: string }
}

/**
 * 合并后的完整事件类型
 *
 * 类型层冲突处理：用 Omit 先剔除 UserEvents 中与 BuiltinEvents 同名的 key，
 * 再与 BuiltinEvents 交叉——内置事件始终优先，防止用户定义 'connected' 等
 * 同名事件导致类型变 never。运行时在 createRtcController 初始化时检查
 * UserEvents key 是否与 BuiltinEvents 重叠，重叠时 logger.warn 提示并忽略。
 */
type AllEvents<UserEvents extends EventMap> = BuiltinEvents & Omit<UserEvents, keyof BuiltinEvents>
```

#### 事件 API

```ts
interface RtcEventEmitter<UserEvents extends EventMap> {
  /**
   * 监听事件（内置 + 自定义）
   * 返回取消监听函数
   */
  on<K extends keyof AllEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllEvents<UserEvents>[K]>,
  ): () => void

  /**
   * 单次监听
   */
  once<K extends keyof AllEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllEvents<UserEvents>[K]>,
  ): () => void

  /**
   * 取消监听
   */
  off<K extends keyof AllEvents<UserEvents>>(
    event: K,
    handler: EventHandler<AllEvents<UserEvents>[K]>,
  ): void
}

/** payload 为 void 时 handler 无参数，否则携带 payload */
type EventHandler<P> = P extends void ? () => void : (payload: P) => void
```

### RtcController（控制器主体）

```ts
interface RtcController<UserEvents extends EventMap = {}>
  extends RtcEventEmitter<UserEvents> {

  /** 当前连接阶段（只读） */
  readonly phase: RtcPhase

  /** 底层 RTCPeerConnection 引用（只读，供高级场景使用） */
  readonly peerConnection: RTCPeerConnection | null

  // ── 连接管理 ──

  /**
   * 作为 Offerer 发起连接
   * 创建 RTCPeerConnection → 创建 offer → 通过信令发送 → 等待 answer
   * resolve 时机：ICE 连接状态变为 'connected' 或 'completed'
   *
   * 被动接受方（Answerer）无需手动调用任何方法——控制器在初始化时已通过
   * signaling.onMessage 注册内部回调，收到 offer 时自动处理。
   *
   * 边界行为：
   * - phase 非 idle 时抛 RtcInvalidStateError（防止重复连接）
   * - connectTimeout 到期仍未建立 ICE 连接 → reject RtcTimeoutError 并自动 dispose
   * - 信令 send 失败 → reject RtcSignalingError（cause 携带原始错误）
   * - options.signal 已 aborted → reject RtcDisposedError
   */
  connect(): Promise<void>

  /**
   * 手动重连：关闭当前连接并重新走 connect 流程
   *
   * 语义：
   * 1. 关闭现有 RTCPeerConnection（不触发 'closed' 事件，触发 'disconnected'）
   * 2. 清理 ICE candidate 缓冲队列、数据通道
   * 3. phase 回到 idle
   * 4. 重新执行 connect() 流程（创建新的 RTCPeerConnection → offer → 等待连接）
   *
   * 边界行为：
   * - phase 为 idle 时等价于 connect()（未建立过连接，直接发起）
   * - phase 为 closed 时抛 RtcDisposedError（已 dispose，不可复用）
   * - 重连期间触发 'phase-change' 事件（→ idle → signaling → connecting → connected）
   * - connectTimeout 语义同 connect
   */
  reconnect(): Promise<void>

  /**
   * 断开连接并释放资源
   * 关闭 RTCPeerConnection + 取消信令订阅 + 清理所有事件监听 + 关闭数据通道
   *
   * 幂等语义：
   * - 首次调用执行完整清理，phase 变为 closed，触发 'closed' 事件
   * - 第二次及后续调用为 no-op（不抛错、不触发事件）
   * - dispose 后调用任何其他方法（connect / emit / addTrack 等）抛 RtcDisposedError
   */
  dispose(): void

  // ── 媒体流 ──

  /**
   * 添加本地媒体轨道
   * 返回 RTCRtpSender，可用于后续 replaceTrack / removeTrack
   */
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender

  /**
   * 移除本地媒体轨道
   */
  removeTrack(sender: RTCRtpSender): void

  /**
   * 获取所有远端媒体流
   */
  getRemoteStreams(): readonly MediaStream[]

  // ── 数据通道 ──

  /**
   * 创建新的数据通道
   */
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel

  /**
   * 通过默认数据通道发送自定义事件
   * 仅允许发送 UserEvents 中定义的事件（内置事件由控制器内部触发）
   */
  emit<K extends keyof UserEvents>(
    event: K,
    ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]
  ): void

  /**
   * 通过默认数据通道发送原始数据
   */
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void

  // ── 状态查询 ──

  /**
   * 连接统计信息
   */
  getStats(): Promise<RTCStatsReport>
}
```

### RtcPhase（连接状态机）

```ts
type RtcPhase =
  | 'idle'           // 初始状态，未开始连接
  | 'signaling'      // 信令交换中（创建/发送 offer 或 answer）
  | 'connecting'     // ICE 连接建立中
  | 'connected'      // 连接已建立
  | 'disconnected'   // 连接断开（可能恢复）
  | 'failed'         // 连接失败（需要重新连接）
  | 'closed'         // 连接已关闭（调用 dispose 或对端关闭）
```

状态流转图：

```text
                        ┌──────────────────────────────────────┐
                        │                                      ▼
  idle ──► signaling ──► connecting ──► connected ──► disconnected
   ▲                        │              │              │
   │ reconnect()            │              │              ▼
   │                        │              │          connected (ICE 自动恢复)
   │                        ▼              ▼              │
   ├─────── failed ◄────── failed ◄────── failed ◄───────┘
   │           │
   │           ▼
   │         closed (dispose)
   ▼
  closed ◄─── dispose() 从任意状态均可触发
```

**状态语义**：

- **idle → signaling**：调用 `connect()` 或收到远端 offer（信令适配器内部路由）
- **signaling → connecting**：SDP 交换完成，开始 ICE 连接
- **connecting → connected**：ICE 连接建立成功
- **connected → disconnected**：ICE 连接暂时断开（网络抖动等）
- **disconnected → connected**：ICE 自动恢复
- **任意 → failed**：ICE 连接彻底失败
- **signaling / connecting / connected / disconnected / failed → idle**：调用 `reconnect()`，关闭旧连接后回到 idle 重新发起（`idle` 时等价于 `connect()`；`closed` 时抛 `RtcDisposedError`）
- **任意 → closed**：调用 `dispose()`，终态不可逆

## 错误类型

遵循项目约定，所有错误通过 `shared/throw-error` 模块抛出。错误消息统一带 `[@cmtlyt/lingshu-toolkit#rtcController]` 前缀。

> **基础设施约定**：`shared/throw-error` 支持 `options.cause` 参数（基于 ES2022 `new Error(msg, { cause })`），签名兼容既有调用点。本模块的 `RtcSignalingError` 在由底层 `RTCPeerConnection` API 抛错间接触发时，通过 `throwError('rtcController', 'signaling failed', RtcSignalingError as unknown as ErrorConstructor, { cause: originalError })` 统一传递原始错误；业务侧 `catch (err) { err.cause }` 即可读到。
>
> **错误子类与 `throwError` 的适配**：class 语法的错误子类不满足 `ErrorConstructor` 签名（不支持无 `new` 直接调用），传入 `throwError` 时需 `RtcXxxError as unknown as ErrorConstructor` 局部类型适配。
>
> 签名（摘录）：
>
> ```ts
> throwError(fnName, message, ErrorClass?, options?: { cause?: unknown }): never
> throwError(fnName, message, options?: { cause?: unknown }): never    // 重载：省略 ErrorClass
> throwType(fnName, message, options?: { cause?: unknown }): never
> createError(fnName, message, ErrorClass?, options?: { cause?: unknown }): Error
> ```

```ts
/** 在非法状态下调用操作（如 idle 状态下 addTrack、closed 状态下 connect） */
class RtcInvalidStateError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RtcInvalidStateError'
  }
}

/** 信令交换失败（cause 字段携带底层 RTCPeerConnection 的原始错误） */
class RtcSignalingError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RtcSignalingError'
  }
}

/** 控制器已销毁后调用操作（cause 字段在 signal.aborted 触发时携带 abort reason） */
class RtcDisposedError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RtcDisposedError'
  }
}

/** 连接超时（connect / reconnect 的 connectTimeout 到期，或被动接受 offer 时超时） */
class RtcTimeoutError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RtcTimeoutError'
  }
}

/** 数据通道未就绪时发送数据（DataChannel 未创建或 readyState 非 'open'） */
class RtcChannelNotReadyError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RtcChannelNotReadyError'
  }
}
```

| 错误 | 触发时机 |
| --- | --- |
| `RtcInvalidStateError`（`Error`） | 在非法的 phase 下调用操作（如 `idle` 状态下 `addTrack`；`closed` / `failed` 状态下 `connect`；已 `connected` 状态下再次 `connect`） |
| `RtcSignalingError`（`Error`） | SDP offer/answer 创建或设置失败；信令适配器 `send` 抛错；`cause` 字段携带底层原始错误 |
| `RtcDisposedError`（`Error`） | `dispose()` 后继续调用任何方法；`options.signal.aborted` 后任意调用；`cause` 字段在 signal 场景下携带 abort reason |
| `RtcTimeoutError`（`Error`） | `connect()` / `reconnect()` 超过 `connectTimeout` 仍未建立 ICE 连接；被动接受 offer 时超时同理 |
| `RtcChannelNotReadyError`（`Error`） | `emit()` / `send()` 时默认数据通道未创建或 `readyState` 非 `'open'` |

## logger 适配器

### LoggerAdapter 接口

```ts
/**
 * 用户可传入的 logger 形态
 * - warn / error 必选：错误和警告是控制器正常运行必需的日志通道
 * - debug 可选：调试日志可有可无，不传则走默认 shared/logger
 */
interface LoggerAdapter {
  warn(message: string, ...extras: unknown[]): void
  error(message: string, ...extras: unknown[]): void
  debug?(message: string, ...extras: unknown[]): void
}
```

### 字段级混合兜底（resolveLoggerAdapter）

对齐 `lock-data` 的 `resolveLoggerAdapter` 模式：用户传入的 `LoggerAdapter` 可能只实现部分方法，内部通过 `resolveLoggerAdapter(userLogger?)` 做字段级合并，产出三方法齐全的 `ResolvedLoggerAdapter`。

```ts
/**
 * 内部流转的 logger 形态：三方法齐全，下游调用无需判空
 */
interface ResolvedLoggerAdapter extends LoggerAdapter {
  debug: NonNullable<LoggerAdapter['debug']>
}
```

合并规则（字段级）：

- `warn` / `error` / `debug` 每个方法**独立判定**：
  - 用户 logger 的该方法是 `function` → 用用户版本（`.bind(userLogger)` 保证 `this` 正确）
  - 否则 → 用默认 logger（委托 `shared/logger`，带 `[@cmtlyt/lingshu-toolkit#rtcController]` 前缀）
- 一次解析全程复用：`resolveLoggerAdapter` 产出后挂到控制器内部，下游调用 `logger.debug(...)` 无需判空

**默认实现**：委托到 `shared/logger` 的全局 logger（console Proxy），`fnName` 固定为 `'rtcController'`。

```ts
function createDefaultLogger(): ResolvedLoggerAdapter {
  return {
    warn(message: string, ...extras: unknown[]): void {
      globalLogger.warn('rtcController', message, ...extras)
    },
    error(message: string, ...extras: unknown[]): void {
      globalLogger.error('rtcController', message, ...extras)
    },
    debug(message: string, ...extras: unknown[]): void {
      globalLogger.debug('rtcController', message, ...extras)
    },
  }
}

function resolveLoggerAdapter(userLogger?: LoggerAdapter): ResolvedLoggerAdapter {
  const fallback = createDefaultLogger()
  const user = (userLogger || {}) as Partial<LoggerAdapter>
  return {
    warn: typeof user.warn === 'function' ? user.warn.bind(user) : fallback.warn,
    error: typeof user.error === 'function' ? user.error.bind(user) : fallback.error,
    debug: typeof user.debug === 'function' ? user.debug.bind(user) : fallback.debug,
  }
}
```

## 信令适配器设计

### 设计理念

信令是 WebRTC 中唯一没有标准化的部分。不同的应用场景需要不同的信令方案：

- **WebSocket**：最常见的实时信令通道
- **HTTP Polling / SSE**：防火墙友好
- **手动复制粘贴**：调试/演示场景
- **BroadcastChannel**：同源跨标签页场景（配合 `lock-data` 使用）

控制器通过 `SignalingAdapter` 接口将信令层完全抽象，使用者只需实现 `send` 和 `onMessage` 两个方法。

### 信令流程时序

#### 作为 Offerer（主动发起方）

```
Controller                  SignalingAdapter              Remote
    │                              │                        │
    │ ──── connect() ────►         │                        │
    │  create RTCPeerConnection    │                        │
    │  create offer                │                        │
    │  setLocalDescription(offer)  │                        │
    │ ──── send({type:'offer'}) ──►│ ─────── offer ────────►│
    │                              │                        │
    │                              │◄────── answer ─────────│
    │ ◄── onMessage({type:'answer'})                        │
    │  setRemoteDescription(answer)│                        │
    │                              │                        │
    │ ──── send({type:'ice'}) ────►│ ─── ice-candidate ────►│
    │                              │◄── ice-candidate ──────│
    │ ◄── onMessage({type:'ice'})  │                        │
    │  addIceCandidate()           │                        │
    │                              │                        │
    │  ICE connected ✓             │                        │
```

#### 作为 Answerer（被动接受方）

```
Controller                  SignalingAdapter              Remote
    │                              │                        │
    │                              │◄─────── offer ─────────│
    │ ◄── onMessage({type:'offer'})│                        │
    │  create RTCPeerConnection    │                        │
    │  setRemoteDescription(offer) │                        │
    │  create answer               │                        │
    │  setLocalDescription(answer) │                        │
    │ ──── send({type:'answer'}) ─►│ ────── answer ────────►│
    │                              │                        │
    │  (同 Offerer 的 ICE 交换)     │                        │
```

### 示例实现

#### WebSocket 信令适配器

```ts
function createWebSocketSignaling(ws: WebSocket): SignalingAdapter {
  const handlers: Array<(message: SignalingMessage) => void> = []

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data) as SignalingMessage
    for (let i = 0; i < handlers.length; i++) {
      handlers[i](message)
    }
  })

  return {
    send(message) {
      ws.send(JSON.stringify(message))
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

#### BroadcastChannel 信令适配器（跨标签页）

```ts
function createBroadcastSignaling(channelName: string): SignalingAdapter {
  const channel = new BroadcastChannel(channelName)
  const handlers: Array<(message: SignalingMessage) => void> = []

  channel.onmessage = (event) => {
    for (let i = 0; i < handlers.length; i++) {
      handlers[i](event.data as SignalingMessage)
    }
  }

  return {
    send(message) {
      channel.postMessage(message)
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

## 数据通道与自定义事件

### 消息协议

通过默认数据通道传输的自定义事件使用 JSON 编码：

```ts
interface DataChannelEventMessage {
  /** 固定标识，区分事件消息和原始数据 */
  readonly __rtc_event__: true
  /** 事件名 */
  readonly event: string
  /** 事件 payload */
  readonly payload: unknown
}
```

- `controller.emit('chat-message', payload)` → 序列化为 `{ __rtc_event__: true, event: 'chat-message', payload }` 通过 DataChannel 发送
- 收到消息后，检查 `__rtc_event__` 标记：存在则解析为事件分发给 `on` 监听器；不存在则触发 `raw-message` 事件

### DataChannel 生命周期

```
connect() / reconnect() / 收到远端 offer（内部自动路由）
    │
    ▼
  Offerer 创建 DataChannel (autoCreateDataChannel=true)
  Answerer 通过 ondatachannel 接收
    │
    ▼
  DataChannel open → 触发 'data-channel-ready' 事件
    │
    ▼
  可以 emit / send
    │
    ▼
  dispose() → DataChannel close → 触发 'data-channel-closed' 事件
```

## 内部实现要点

> 以下伪代码中使用了若干内部辅助函数，语义约定如下：
>
> | 辅助函数 | 语义 |
> | --- | --- |
> | `assertNotDisposed(caller)` | 若 `phase === 'closed'` 则 `throwError` 抛 `RtcDisposedError`，`caller` 用于错误消息 |
> | `assertPhase(expected, caller)` | 若 `phase !== expected` 则 `throwError` 抛 `RtcInvalidStateError` |
> | `setPhase(next)` | 更新 `phase` 并 `dispatch('phase-change', { phase: next, prevPhase: old })` |
> | `wireConnectionEvents(pc)` | 为 `RTCPeerConnection` 注册 `oniceconnectionstatechange` / `onicecandidate` / `ontrack` / `ondatachannel` 等原生事件，桥接到控制器内部状态机和事件系统 |
> | `wireDataChannelEvents(channel)` | 为 `RTCDataChannel` 注册 `onopen` / `onclose` / `onmessage` 事件，桥接到控制器事件分发（含事件协议解码） |
> | `handleAnswer(sdp)` | 内部函数：`setRemoteDescription` + `flushPendingCandidates`；信令自动路由中收到 `type='answer'` 时调用 |
> | `waitForConnection()` | 内部 Promise 封装：等待 ICE 连接状态变为 `connected` / `completed`，受 `connectTimeout` 保护（超时抛 `RtcTimeoutError`） |
> | `resetConnectionPromise()` | 重置 `connectionEstablished` 内部 Promise（reconnect 清理旧连接后需要新的 Promise 来等待新连接建立） |
> | `abortToPromise(signal, onAbort)` | 将 `AbortSignal` 包装为 Promise：signal aborted 时执行 `onAbort` 回调并 reject |
> | `flushPendingCandidates()` | 异步函数，将 ICE candidate 缓冲队列中暂存的候选通过 `Promise.all` 批量并行添加到 `RTCPeerConnection`（待 `remoteDescription` 设置后 `await` 调用） |

### 连接建立流程（connect）

```ts
async function connect(): Promise<void> {
  // 1. 前置守卫
  assertNotDisposed('connect')
  assertPhase('idle', 'connect')

  // 2. 创建 RTCPeerConnection
  setPhase('signaling')
  peerConnection = new RTCPeerConnection(rtcConfig)
  wireConnectionEvents(peerConnection)

  // 3. 创建默认数据通道（Offerer 侧）
  if (autoCreateDataChannel) {
    defaultChannel = peerConnection.createDataChannel(dataChannelLabel, dataChannelOptions)
    wireDataChannelEvents(defaultChannel)
  }

  // 4. 创建 offer（底层 API 失败走 RtcSignalingError + cause）
  let offer: RTCSessionDescriptionInit
  try {
    offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
  } catch (error) {
    setPhase('failed')
    throwError('rtcController', 'failed to create offer',
      RtcSignalingError as unknown as ErrorConstructor, { cause: error })
  }

  // 5. 通过信令发送 offer（send 失败走 RtcSignalingError + cause）
  try {
    await signaling.send({ type: 'offer', sdp: offer.sdp! })
  } catch (error) {
    setPhase('failed')
    throwError('rtcController', 'failed to send offer via signaling',
      RtcSignalingError as unknown as ErrorConstructor, { cause: error })
  }

  // 6. 等待连接建立（受 connectTimeout 保护）
  //    connectionEstablished 是内部 Promise，在 iceConnectionState
  //    变为 'connected' | 'completed' 时 resolve，变为 'failed' 时 reject
  //    connectTimeout 到期时 reject RtcTimeoutError 并自动 dispose
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), connectTimeout)
  try {
    await Promise.race([
      connectionEstablished,
      abortToPromise(timeoutController.signal, () => {
        dispose()
        throwError('rtcController', `connect timed out after ${connectTimeout}ms`,
          RtcTimeoutError as unknown as ErrorConstructor)
      }),
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}
```

### 接收 offer 流程（内部函数，不对外暴露）

> `handleOffer` 是控制器的**内部函数**，仅由信令消息自动路由（`signaling.onMessage` 回调）调用。
> 外部无需也不应直接调用此方法——所有信令消息的分发由控制器初始化时注册的内部回调处理。

```ts
async function handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
  // 1. 前置守卫
  assertNotDisposed('handleOffer')
  if (phase === 'closed' || phase === 'failed') {
    throwError('rtcController', `cannot handle offer in phase "${phase}"`,
      RtcInvalidStateError as unknown as ErrorConstructor)
  }

  // 2. 首次连接（idle → signaling）或重协商（connected/connecting 不变 phase）
  if (phase === 'idle') {
    setPhase('signaling')
    peerConnection = new RTCPeerConnection(rtcConfig)
    wireConnectionEvents(peerConnection)
  }

  // 3. 设置远端描述 + 创建 answer
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
    await flushPendingCandidates()
    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    await signaling.send({ type: 'answer', sdp: answer.sdp! })
  } catch (error) {
    setPhase('failed')
    throwError('rtcController', 'failed to handle offer',
      RtcSignalingError as unknown as ErrorConstructor, { cause: error })
  }

  // 4. 等待 ICE 连接建立（同 connect，受 connectTimeout 保护）
  if (phase === 'signaling') {
    // 仅首次连接需要等待；重协商场景已 connected，跳过
    await waitForConnection()
  }
}
```

### 手动重连流程（reconnect）

```ts
async function reconnect(): Promise<void> {
  // 1. 前置守卫
  assertNotDisposed('reconnect')

  // 2. 若当前已有连接，先清理旧连接（不触发 'closed'，触发 'disconnected'）
  if (phase !== 'idle') {
    // 关闭旧 RTCPeerConnection
    if (peerConnection) {
      peerConnection.close()
      peerConnection = null
    }
    // 关闭数据通道
    if (defaultChannel) {
      defaultChannel.close()
      defaultChannel = null
    }
    // 清理 ICE candidate 缓冲队列
    pendingCandidates.length = 0
    // 重置 connectionEstablished Promise
    resetConnectionPromise()
    // 触发 'disconnected' 事件（reconnect 导致的断开，reason 标注来源）
    dispatch('disconnected', { reason: 'reconnect' })
    // 回到 idle 状态
    setPhase('idle')
  }

  // 3. 重新走 connect 流程
  await connect()
}
```

### ICE Candidate 处理策略

采用 **Trickle ICE** 策略（默认）：

- ICE candidate 产生时立即通过信令发送，不等待收集完成
- 收到远端 ICE candidate 时立即添加到 `RTCPeerConnection`
- 若 `remoteDescription` 尚未设置，将 candidate 暂存到队列，待设置后批量添加

```ts
// ICE candidate 缓冲队列
const pendingCandidates: RTCIceCandidateInit[] = []

peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    signaling.send({ type: 'ice-candidate', candidate: event.candidate.toJSON() })
  }
}

function handleIceCandidate(candidate: RTCIceCandidateInit): void {
  if (peerConnection.remoteDescription) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
  } else {
    pendingCandidates.push(candidate)
  }
}

async function flushPendingCandidates(): Promise<void> {
  if (!peerConnection) return
  await Promise.all(
    pendingCandidates.map((candidate) => peerConnection.addIceCandidate(new RTCIceCandidate(candidate)))
  )
  pendingCandidates.length = 0
}
```

### 事件系统实现

```ts
// 内部事件存储
interface HandlerEntry<P = unknown> {
  handler: EventHandler<P>
  once: boolean
}

const listeners = new Map<string, HandlerEntry[]>()

function on<K extends keyof AllEvents<UserEvents>>(
  event: K,
  handler: EventHandler<AllEvents<UserEvents>[K]>,
): () => void {
  const key = event as string
  const entries = listeners.get(key) || []
  const entry: HandlerEntry = { handler: handler as EventHandler, once: false }
  entries.push(entry)
  listeners.set(key, entries)

  return () => off(event, handler)
}

/**
 * 事件分发（内部方法，不暴露给用户）
 *
 * 异常隔离契约（对齐 lock-data fanout 模式）：
 * - 单个 handler 同步 throw 通过 try/catch 捕获，走 logger.error 记录，继续向剩余 handler 分发
 * - 不阻断后续 handler 执行
 *
 * 遍历安全：
 * - 先做数组快照（slice），再正向遍历快照；once handler 从原数组中移除
 * - 避免反向遍历中 splice + handler 抛错导致"once 已移除但事件未分发"的问题
 */
function dispatch<K extends keyof AllEvents<UserEvents>>(
  event: K,
  ...args: AllEvents<UserEvents>[K] extends void ? [] : [payload: AllEvents<UserEvents>[K]]
): void {
  const key = event as string
  const entries = listeners.get(key)
  if (!entries || entries.length === 0) return

  // 快照遍历，避免遍历过程中增删导致跳跃
  const snapshot = entries.slice()
  for (let i = 0; i < snapshot.length; i++) {
    const entry = snapshot[i]
    // once handler：先从原数组移除（仅移除首个匹配，保证多次 on 同一 handler 各自独立）
    if (entry.once) {
      const idx = entries.indexOf(entry)
      if (idx >= 0) entries.splice(idx, 1)
    }
    // 异常隔离：handler 抛错不中断后续 handler
    try {
      entry.handler(...(args as [unknown]))
    } catch (error) {
      logger.error(`[rtcController] event handler threw (${key})`, error)
    }
  }
}
```

### 信令消息自动路由

控制器在初始化时通过 `signaling.onMessage` 注册内部回调，按消息类型自动路由到对应的内部处理函数。外部无需也不应手动处理任何信令消息：

```ts
// 在 createRtcController 内部（初始化阶段注册，dispose 时取消）
const unsubscribeSignaling = signaling.onMessage((message) => {
  // 已 disposed 时忽略信令消息
  if (phase === 'closed') return

  switch (message.type) {
    case 'offer':
      // handleOffer 是内部函数，不对外暴露
      handleOffer({ type: 'offer', sdp: message.sdp }).catch((error) => {
        dispatch('error', { error: error as Error, context: 'signaling:offer' })
      })
      break
    case 'answer':
      handleAnswer(message.sdp)
      break
    case 'ice-candidate':
      handleIceCandidate(message.candidate)
      break
  }
})
```

### AbortSignal 集成

```ts
if (options.signal) {
  if (options.signal.aborted) {
    // 已 aborted，直接进入 disposed 状态
    dispose()
  } else {
    const onAbort = () => dispose()
    options.signal.addEventListener('abort', onAbort, { once: true })
    // dispose 时清理 signal 监听，避免内存泄漏
    cleanupFns.push(() => options.signal!.removeEventListener('abort', onAbort))
  }
}
```

## 目录与文件规划

```text
src/shared/rtc-controller/
├── index.ts                  # 公开导出入口
├── index.mdx                 # 文档（自动生成 + 手动追加）
├── RFC.md                    # 本 RFC 文档
├── IMPLEMENTATION.md         # 实施清单（独立文件）
├── types.ts                  # 公开类型定义
├── constants.ts              # 常量
├── adapters/
│   └── logger.ts             # resolveLoggerAdapter 字段级混合兜底
├── core/
│   ├── controller.ts         # RtcController 主体实现（信令路由 + 生命周期编排）
│   ├── controller-context.ts # 控制器内部共享状态（ControllerContext 类型）
│   ├── event-emitter.ts      # 泛型事件系统
│   ├── connection.ts         # RTCPeerConnection 生命周期管理
│   ├── data-channel.ts       # DataChannel 管理
│   └── media.ts              # 媒体轨道管理
├── errors/
│   ├── index.ts                      # 错误类型统一导出
│   ├── rtc-channel-not-ready-error.ts
│   ├── rtc-disposed-error.ts
│   ├── rtc-invalid-state-error.ts
│   ├── rtc-signaling-error.ts
│   └── rtc-timeout-error.ts
└── __test__/
    ├── index.test.ts                     # 节点环境单元测试（入口聚合层）
    ├── index.browser.test.ts             # 浏览器环境集成测试（完整 offer/answer 流程）
    ├── index.test-d.ts                   # 类型测试（泛型事件系统推断）
    ├── index.html                        # 手动测试面板（跨标签页 BroadcastChannel 信令）
    ├── coverage-attack.browser.test.ts   # 覆盖率攻坚测试（防御分支命中）
    ├── reconnect.browser.test.ts         # reconnect 流程测试
    ├── adapters/
    │   └── logger.test.ts
    ├── core/
    │   └── event-emitter.test.ts
    └── helpers/
        └── mock-signaling.ts             # 测试用 mock 信令适配器
```

## 测试策略

### 测试分层

| 层级 | 测试文件 | 环境 | 覆盖范围 |
| --- | --- | --- | --- |
| 事件系统 | `__test__/core/event-emitter.test.ts` | Node | 泛型事件注册/触发/取消/once、类型安全 |
| 连接管理 | `__test__/core/connection.browser.test.ts` | Browser | RTCPeerConnection 创建/关闭、状态机流转 |
| 数据通道 | `__test__/core/data-channel.browser.test.ts` | Browser | DataChannel 创建/收发/事件协议 |
| 重连 | `__test__/reconnect.browser.test.ts` | Browser | reconnect 流程、状态回退、事件触发 |
| 信令集成 | `__test__/index.browser.test.ts` | Browser | 完整的 offer/answer 流程 |
| 类型契约 | `__test__/index.test-d.ts` | TypeCheck | 泛型推断、事件 payload 类型 |

### 测试约定

- 浏览器 API（`RTCPeerConnection` / `RTCDataChannel`）使用 `.browser.test.ts` 后缀，不做 mock
- 涉及超时的测试使用 `vi.useFakeTimers()`
- 信令适配器使用 mock 实现（直接内存回调，不走真实网络）
- 类型测试（`expectTypeOf`）与逻辑测试分离

### Mock 信令适配器

```ts
/** 用于测试的内存信令适配器对，模拟双端通信 */
function createMockSignalingPair(): [SignalingAdapter, SignalingAdapter] {
  const handlersA: Array<(msg: SignalingMessage) => void> = []
  const handlersB: Array<(msg: SignalingMessage) => void> = []

  const adapterA: SignalingAdapter = {
    send(message) { for (let i = 0; i < handlersB.length; i++) handlersB[i](message) },
    onMessage(cb) {
      handlersA.push(cb)
      return () => { const idx = handlersA.indexOf(cb); if (idx >= 0) handlersA.splice(idx, 1) }
    },
  }

  const adapterB: SignalingAdapter = {
    send(message) { for (let i = 0; i < handlersA.length; i++) handlersA[i](message) },
    onMessage(cb) {
      handlersB.push(cb)
      return () => { const idx = handlersB.indexOf(cb); if (idx >= 0) handlersB.splice(idx, 1) }
    },
  }

  return [adapterA, adapterB]
}
```

## 实施清单

> 已拆分为独立文件，详见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)

## 风险与取舍

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 浏览器 WebRTC 实现差异 | ICE 行为 / DataChannel 可靠性在不同浏览器表现不一 | 依赖 `RTCConfiguration` 让用户控制 STUN/TURN；测试覆盖主流浏览器 |
| DataChannel 消息大小限制 | 单条消息超过 ~64KB 可能被截断或报错 | 文档标注限制；不实现分片（非目标） |
| 信令适配器实现质量 | 外部实现可能有 bug（消息丢失 / 乱序） | 提供示例实现 + 测试用 mock；文档标注信令适配器的契约要求 |
| `RTCPeerConnection` 在 Node 环境不可用 | 纯 Node 环境无法使用 | 事件系统等核心逻辑可在 Node 测试；连接相关逻辑使用 `.browser.test.ts` |
| 自定义事件与内置事件命名冲突 | 用户定义了与内置事件同名的事件会导致类型冲突 | 类型层通过 `Omit<UserEvents, keyof BuiltinEvents>` 排除冲突键；运行时警告 |

## 公开决策记录

### #1 信令层为何完全外部化而非提供内置实现

**决策**：信令适配器仅定义接口，不提供任何内置信令实现。

**理由**：
- WebRTC 信令没有标准协议，不同项目的信令方案差异极大
- 内置 WebSocket 信令会引入服务端依赖，与工具库定位不符
- 接口足够简单（`send` + `onMessage`），实现成本低
- 提供示例代码（WebSocket / BroadcastChannel）降低接入门槛

### #2 事件系统为何不复用外部 EventEmitter

**决策**：内建泛型事件系统，不依赖 `events` / `mitt` / `eventemitter3` 等外部库。

**理由**：
- 需要区分"内置事件"与"自定义事件"的类型约束（`emit` 仅允许自定义事件）
- 外部库的类型定义通常不支持这种分层约束
- 实现简单（~60 行），不值得引入外部依赖
- 项目既有风格偏好零外部依赖

### #3 为何提供 `reconnect()` 但不实现自动重连策略

**决策**：控制器提供 `reconnect()` API 实现底层重连能力（关闭旧连接 → 回到 idle → 重新 connect），但**不内置**任何自动重连策略（指数退避 / 固定间隔 / 重试次数限制等）。

**理由**：
- 底层重连能力（清理旧连接 + 重建新连接）是控制器的职责范畴，不应让用户手动 `dispose` + 重新 `createRtcController`——那样会丢失已注册的事件监听器
- 自动重连策略高度业务相关（退避算法 / 重试上限 / 网络状态检测 / UI 提示等），不适合内置
- 用户通过监听 `disconnected` / `failed` 事件，自行决定何时调用 `reconnect()` 即可实现任意策略
- 保持控制器职责单一：管理单个连接的完整生命周期（含重连），不管策略

### #4 `emit` 为何只允许发送自定义事件

**决策**：`controller.emit` 的类型签名仅接受 `keyof UserEvents`，不接受 `keyof BuiltinEvents`。

**理由**：
- 内置事件（`connected` / `failed` 等）由控制器内部状态机驱动，外部伪造会破坏状态一致性
- 自定义事件通过 DataChannel 传输到对端，是"用户空间"的通信；内置事件是"系统空间"的状态通知
- 类型层强制隔离，编译期拦截误用

**运行时守卫**：
- 非字符串事件名：`typeof event !== 'string'` 时 `logger.warn` 并静默返回（DataChannel 协议仅支持字符串事件名）
- 内置事件名：`BUILTIN_EVENT_NAMES.has(eventName)` 时 `logger.warn` 并静默返回（不抛错，避免运行时崩溃）

### #5 DataChannel 事件协议为何用 JSON 而非二进制

**决策**：自定义事件的编解码使用 JSON（`JSON.stringify` / `JSON.parse`），不使用 Protocol Buffers / MessagePack 等二进制格式。

**理由**：
- JSON 是 JavaScript 原生支持的序列化格式，零依赖
- 自定义事件主要是控制/消息类数据，体积通常很小
- 大文件传输应使用 `controller.send(arrayBuffer)` 走原始数据通道，不走事件协议
- 与 `lock-data` 的 JSON 拷贝隔离契约风格一致

## 附录 A：完整接口索引

> 以下为所有公开类型的完整签名，实现时以此为准。

```ts
// ── 常量 ──

/** 数据通道事件消息的标记字段 */
declare const RTC_EVENT_MARKER: '__rtc_event__'

/** 默认数据通道 label */
declare const DEFAULT_DATA_CHANNEL_LABEL: 'lingshu-rtc'

// ── 基础类型 ──

type RtcPhase = 'idle' | 'signaling' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

type EventMap = Record<string, unknown>

type EventHandler<P> = P extends void ? () => void : (payload: P) => void

// ── 信令 ──

type SignalingMessage =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }

interface SignalingAdapter {
  send(message: SignalingMessage): void | Promise<void>
  onMessage(callback: (message: SignalingMessage) => void): () => void
  dispose?(): void
}

// ── 事件 ──

interface BuiltinEvents {
  'phase-change': { phase: RtcPhase; prevPhase: RtcPhase }
  'connected': void
  'disconnected': { reason: string }
  'failed': { error: Error }
  'closed': void
  'track': { track: MediaStreamTrack; streams: readonly MediaStream[] }
  'track-removed': { track: MediaStreamTrack }
  'data-channel-ready': { channel: RTCDataChannel; label: string }
  'data-channel-closed': { label: string }
  'ice-state-change': { state: RTCIceConnectionState }
  'ice-gathering-complete': void
  'signaling-state-change': { state: RTCSignalingState }
  'raw-message': { data: unknown; channel: RTCDataChannel }
  'error': { error: Error; context: string }
}

/** 用 Omit 先剔除 UserEvents 中与 BuiltinEvents 同名的 key，内置事件始终优先 */
type AllEvents<UserEvents extends EventMap> = BuiltinEvents & Omit<UserEvents, keyof BuiltinEvents>

// ── 数据通道消息协议 ──

interface DataChannelEventMessage {
  readonly __rtc_event__: true
  readonly event: string
  readonly payload: unknown
}

// ── 配置 ──

interface RtcControllerOptions {
  readonly signaling: SignalingAdapter
  readonly rtcConfig?: RTCConfiguration
  readonly dataChannelLabel?: string
  readonly dataChannelOptions?: RTCDataChannelInit
  readonly autoCreateDataChannel?: boolean
  readonly connectTimeout?: number
  readonly signal?: AbortSignal
  readonly logger?: LoggerAdapter
}

/** 用户可传入的 logger：warn / error 必选，debug 可选 */
interface LoggerAdapter {
  warn(message: string, ...extras: unknown[]): void
  error(message: string, ...extras: unknown[]): void
  debug?(message: string, ...extras: unknown[]): void
}

/** 内部流转的 logger：三方法齐全，由 resolveLoggerAdapter 产出 */
interface ResolvedLoggerAdapter extends LoggerAdapter {
  debug: NonNullable<LoggerAdapter['debug']>
}

// ── 错误 ──

declare class RtcInvalidStateError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RtcSignalingError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RtcDisposedError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RtcTimeoutError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}
declare class RtcChannelNotReadyError extends Error {
  constructor(message?: string, options?: ErrorOptions)
}

// ── 控制器 ──

interface RtcController<UserEvents extends EventMap = {}> {
  readonly phase: RtcPhase
  readonly peerConnection: RTCPeerConnection | null

  // 事件（on / once 支持内置 + 自定义事件；类型层通过 AllEvents 合并）
  on<K extends keyof AllEvents<UserEvents>>(event: K, handler: EventHandler<AllEvents<UserEvents>[K]>): () => void
  once<K extends keyof AllEvents<UserEvents>>(event: K, handler: EventHandler<AllEvents<UserEvents>[K]>): () => void
  off<K extends keyof AllEvents<UserEvents>>(event: K, handler: EventHandler<AllEvents<UserEvents>[K]>): void

  // 连接
  connect(): Promise<void>
  /** 关闭旧连接 → phase 回 idle → 重新 connect；phase 为 closed 时抛 RtcDisposedError */
  reconnect(): Promise<void>
  /** 幂等：首次执行完整清理；第二次起 no-op */
  dispose(): void

  // 媒体
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender
  removeTrack(sender: RTCRtpSender): void
  getRemoteStreams(): readonly MediaStream[]

  // 数据通道（emit 仅允许 UserEvents，内置事件由控制器内部触发）
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel
  emit<K extends keyof UserEvents>(event: K, ...args: UserEvents[K] extends void ? [] : [payload: UserEvents[K]]): void
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void

  // 状态
  getStats(): Promise<RTCStatsReport>
}
```

## 附录 B：使用示例

### 场景 1：视频通话

```ts
import { createRtcController } from '@cmtlyt/lingshu-toolkit/shared'

// 信令适配器（假设已实现 WebSocket 版本）
const signaling = createWebSocketSignaling(new WebSocket('wss://signal.example.com'))

const controller = createRtcController({
  signaling,
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:turn.example.com', username: 'user', credential: 'pass' },
    ],
  },
})

// 监听远端视频
controller.on('track', ({ track, streams }) => {
  if (track.kind === 'video') {
    const video = document.getElementById('remote-video') as HTMLVideoElement
    video.srcObject = streams[0]
  }
})

// 添加本地视频
const localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
for (let i = 0; i < localStream.getTracks().length; i++) {
  controller.addTrack(localStream.getTracks()[i], localStream)
}

// 发起连接
await controller.connect()
```

### 场景 2：带类型安全的聊天应用

```ts
interface ChatEvents {
  'message': { userId: string; text: string; timestamp: number }
  'typing': { userId: string; isTyping: boolean }
  'read-receipt': { messageId: string }
}

const controller = createRtcController<ChatEvents>({
  signaling: mySignaling,
})

// 类型安全的事件监听
controller.on('message', (payload) => {
  // payload: { userId: string; text: string; timestamp: number }
  appendMessage(payload.userId, payload.text)
})

controller.on('typing', ({ userId, isTyping }) => {
  showTypingIndicator(userId, isTyping)
})

// 类型安全的事件发送
controller.emit('message', {
  userId: 'me',
  text: 'Hello!',
  timestamp: Date.now(),
})

// ❌ 编译期报错：内置事件不可通过 emit 发送
// controller.emit('connected')

// ❌ 编译期报错：payload 类型不匹配
// controller.emit('message', { wrong: 'shape' })
```

### 场景 3：文件传输

```ts
const controller = createRtcController({ signaling: mySignaling })

await controller.connect()

// 发送方：通过原始数据通道发送文件
const fileData = await file.arrayBuffer()
controller.send(fileData)

// 接收方：监听原始消息
controller.on('raw-message', ({ data }) => {
  if (data instanceof ArrayBuffer) {
    saveFile(data)
  }
})
```

### 场景 4：跨标签页 P2P（配合 BroadcastChannel）

```ts
const signaling = createBroadcastSignaling('my-app-rtc-signaling')

const controller = createRtcController({
  signaling,
  rtcConfig: { iceServers: [] }, // 同源无需 STUN/TURN
})

controller.on('connected', () => {
  console.log('跨标签页 WebRTC 连接已建立')
})

await controller.connect()
```
