# RFC: rtcRoom 权限控制 — 核心架构与配置

> scope: `src/shared/rtc-room/permissions`
>
> parent: [RFC.md](./RFC.md)（版本与状态由主文档统一管理）

## 背景与动机

当前 `rtc-room` 提供了多方通信的基础能力（成员管理、消息收发、媒体流广播），但缺少房间管理权限：

- 无法踢出恶意/违规用户
- 无法对特定用户的特定通道/事件进行禁言
- 无主持人/管理员角色概念

## 设计理念

**权限变更通过独立的房间管理 channel（`__room_ctrl__`）广播同步，接收方以断言模式校验发送者身份合法性。**

房间管理 channel 设计：

1. **独立 channel**：`__room_ctrl__` 是一个独立的内部 DataChannel，专用于房间控制消息通信
2. **全员建立**：`enablePermissions=true` 时所有用户都建立该 channel
3. **读写分离**：默认只读（普通用户仅接收控制消息），管理员/房主拥有写权限
4. **低延迟**：P2P 直连比绕信令服务器更快
5. **减轻信令压力**：信令服务器只负责组网

安全模型：**断言式校验**——在 `__room_ctrl__` channel 收到消息时，`from` 从 `PeerEntry.peerId`（建连时确定的对端身份）获取，**而非消息 payload 中的 `by` 字段**。断言 `from` 的写权限合法性，越权则 dispatch 事件 + 抛错阻断后续逻辑。是否自动断连由配置开关控制。

**前置开关断言**：所有权限和角色相关的 API 调用、事件处理在入口处统一断言 `enablePermissions === true`，未启用时直接 throwError。

## 模块架构

权限系统作为 `rtc-room` 的**子模块**独立实现，通过 transport 接口与 rtc-room 核心解耦：

```text
src/shared/rtc-room/
├── core/              — rtc-room 核心（通信、组网）
├── errors/            — 错误类型定义（所有 room 级错误，含权限相关）
├── permissions/       — 权限管理子模块（独立实现）
│   ├── state/         — RoomContext 状态管理
│   ├── roles/         — 角色：host 协商、admin 管理、候选列表、继位
│   ├── mute/          — 禁言引擎：checkMute、getMuteState、三层粒度
│   ├── queue/         — request 队列：管理员端 + 房主端
│   ├── sync/          — 状态同步：buildSyncStatePayload、batch、serialize/deserialize
│   └── index.ts       — 入口，暴露 createPermissionController(transport, options)
└── index.ts           — rtc-room 入口，整合 core + permissions
```

**transport 接口**（rtc-room core 负责实现，权限子模块通过该接口与外部通信）：

```typescript
interface PermissionTransport {
  /** 向指定 peer 发送控制消息（通过 __room_ctrl__ channel 单播） */
  sendTo(peerId: string, message: ControlMessage): void;
  /** 向所有 peer 广播控制消息（通过 __room_ctrl__ channel 广播） */
  broadcast(message: ControlMessage): void;
  /**
   * 断开指定 peer 的所有连接（best-effort 语义）
   * close 本地 PeerConnection 即完成，无需等待对端确认。
   * 底层 ICE 断连失败不影响调用方逻辑——本地资源已释放，对端通过连接超时自行检测。
   *
   * 与 rtc-room core 中 "dispose controller" 的关系：
   * - dispose = 清理 PeerController 实例（关闭所有 DataChannel + PeerConnection + 从 peers Map 移除）
   * - disconnect = transport 接口暴露给权限模块的方法，内部调用 dispose（权限模块无需感知 dispose 细节）
   * - 伪代码文档中的 "dispose target 对应 peer 的 controller + 从 peers 移除" 等价于调用 transport.disconnect(peerId)
   */
  disconnect(peerId: string): void;
  /** 监听 __room_ctrl__ channel 收到的控制消息 */
  onMessage(handler: (from: string, message: ControlMessage) => void): () => void;
  /** 监听成员加入（首次建连，不含重连） */
  onMemberJoin(handler: (peerId: string) => void): () => void;
  /** 监听成员离开 */
  onMemberLeave(handler: (peerId: string) => void): () => void;
  /**
   * 监听成员重连。重连不触发 onMemberJoin。
   * 触发条件：同一 peerId 的 peer 在 DataChannel 关闭后重新建立连接。
   * transport 层始终触发此回调，不做 kick 缓存判断——
   * 权限模块在 handler 中自行校验 kickedPeerIds，命中则调用 disconnect(peerId) 拒绝重连。
   */
  onMemberReconnect(handler: (peerId: string) => void): () => void;
  /**
   * 为指定 peer 建立 __room_ctrl__ DataChannel（空窗期挂起 peer 恢复时调用）
   * 正常流程中 __room_ctrl__ channel 在 peer-connected 时由 transport 层自动建立，
   * 此方法仅用于空窗期挂起的 peer——它们在 peer-connected 时跳过了 channel 建立，
   * 选举完成后新房主通过此方法补建，使后续广播能送达。
   *
   * 实现说明：调用方为 DataChannel 的 initiator 端（调用 RTCPeerConnection.createDataChannel），
   * 对端通过 RTCPeerConnection 的 'datachannel' 事件接收。WebRTC 中任一端均可发起 createDataChannel，
   * 此处由新房主发起，确保 channel 建立的主动权在房主端。
   */
  createCtrlChannel(peerId: string): void;
  /** 本地 peerId */
  readonly localPeerId: string;
}
```

**设计要点**：

- **子模块定位**：权限模块是 rtc-room 的内部子模块（非平级独立模块），物理目录在 `src/shared/rtc-room/permissions/` 下
- **单向依赖**：权限模块仅依赖 transport 接口，不依赖 rtc-room 的具体实现（DataChannel、PeerConnection 等）
- **发送拦截**：rtc-room core 的 `send()`/`broadcast()` 方法调用前，通过 `permissionController.checkSendPermission(channel, event)` 做禁言守卫（一行调用，耦合极低）
- **API 透传**：rtc-room 对外暴露的权限 API（kick/mute/unmute 等）直接委托给 `permissionController` 对应方法
- **tree-shaking**：`enablePermissions=false` 时不初始化权限子模块，不引入额外开销
- **可测试性**：权限子模块可纯内存测试（mock transport 接口），无需 WebRTC 环境

## 核心概念

| 概念 | 说明 |
|------|------|
| **Host（房主）** | 房间唯一拥有者，最高权限，**不可被禁言/踢出**。由 `hostId` 标识，冗余存在于 `adminIds` 中。默认为第一个进房的用户，组网后自动协商产生 |
| **Admin（管理员）** | 拥有除「转让房主」「指派/移除管理员」「禁言 `__room_ctrl__` channel」外的全部管理权限。可有多个。**权限管理遵循单向链：host → admin → user，仅上游可管理下游，不可互操作、不可反向操作**，不可自解禁 |
| **Kick（踢人）** | 房主/管理员断开目标 peer 的所有连接。房主更新状态后广播 batch（kick + sync-state），target 收到后 performLeave，其他端主动断开与 target 的连接。不可踢房主，管理员不可踢其他管理员（仅房主可踢管理员） |
| **Mute（禁言）** | 三层粒度：用户级 / channel 级 / 事件级。**channel 禁言仅影响写权限（发送拦截），消息接收不受影响**。Host 免疫禁言。全房间禁言使用 `mute('*')` |
| **`__room_ctrl__` channel** | 房间管理 channel，`enablePermissions=true` 时所有用户都建立。默认只读，管理员/房主拥有写权限。仅房主可禁言/解禁他人的该 channel |
| **越权广播（Forbidden Broadcast）** | `from`（从 PeerEntry.peerId 获取，即建连时确定的对端身份）不具备对应操作权限（无 `__room_ctrl__` 写权限）却发送了控制消息。断言式阻断 + dispatch 事件，是否自动断连由配置开关控制（默认开） |
| **performLeave（离开房间）** | 仅断开所有 P2P 连接并清理本地状态的内部操作。**不通过任何 channel 发送消息**（因此无需禁言检测），不触发 `member-left` 广播（其他端通过连接断开事件自行检测）。被 kick 时由 target 端调用，也可由用户主动离开时调用 |

## API 设计

### 新增配置项

```typescript
/**
 * Room 行为开关（通用，不仅限于权限，后续可扩展更多开关）
 */
interface RoomSwitches {
  /**
   * 是否启用权限系统（默认 false）
   * 启用后：建立 __room_ctrl__ channel、房主由组网协商自动产生（首个进房用户）
   */
  readonly enablePermissions?: boolean;
  /** 检测到越权广播时是否自动断开与非法用户的连接（默认 true，仅 enablePermissions=true 时生效） */
  readonly autoDisconnectOnForbiddenBroadcast?: boolean;
  /** 创建房间时是否默认开启房间级别禁言（默认 false，仅 enablePermissions=true 时生效） */
  readonly defaultRoomMute?: boolean;
  /**
   * 全房间禁言是否对管理员生效（默认 false，仅 enablePermissions=true 时生效）
   * 默认 false 的理由：管理员需要维持房间秩序（执行 kick/mute 等操作需要 __room_ctrl__ 写权限），
   * 全房间禁言的典型场景是"全员静音，仅管理员可发言"，管理员默认免疫符合此预期。
   */
  readonly roomMuteAffectsAdmin?: boolean;
}

/**
 * 权限系统可交互参数（所有权限相关的可调参数聚合于此，仅 enablePermissions=true 时生效）
 */
interface PermissionParameters {
  /** 管理员 request 等待 ack 的超时时间（ms，默认 5000） */
  readonly requestTimeout?: number;
  /** 房主端 request 队列最大容量（默认 64，超限时立即回复 ack(success=false, error='queue full')） */
  readonly maxPendingRequests?: number;
  /**
   * 房主候选列表最大长度
   * 默认值 = 房间人数 - 1（房主），即所有非房主成员均为候选者
   * 设为固定数值时，候选列表长度不超过该值（按优先级截取前 N 个）
   */
  readonly maxCandidates?: number;
  /**
   * 投票式选举的梯度自荐延迟（ms，默认 3000）。候选者 i 的等待时间 = i * successionDelay
   * 小房间空窗期体感明显，建议适当调低：2 人房间 1000ms、3-5 人房间 2000ms、6+ 人房间保持默认 3000ms
   */
  readonly successionDelay?: number;
  /**
   * 选举投票超时时间（ms，默认 3000）
   * 候选者发出自荐后，等待 ack 的最大时间。超时后锁定票数进入决议阶段。
   * 同时作为比票阶段的超时（复用同一配置，避免配置膨胀，两阶段对延迟容忍度一致）。
   */
  readonly nominateTimeout?: number;
  /**
   * 选举全局超时时间（ms）
   * 默认值 = Math.max(hostCandidates.length * successionDelay + nominateTimeout * 2 + 1000, nominateTimeout * 3)
   * 所有端进入空窗期时启动此计时器，超时后若仍未收到 host-transfer，
   * 以当前可达成员重新计算候选列表并重启选举（详见 RFC-roles.md「全候选者断线」）。
   * 通常无需手动配置——默认值已覆盖最坏情况（最后候选者梯度到期 + 投票 + 比票 + 1s 网络延迟余量）。
   * Math.max 保证最小值下限（nominateTimeout * 3），防止某端 hostCandidates 为空时
   * 计算出过小的 electionTimeout 导致过早触发重算。
   *
   * 注：各端计算 electionTimeout 依赖本地 hostCandidates（最后一次 sync-state 同步的值），
   * 若进入空窗期前某端尚未收到最新 sync-state，其 hostCandidates.length 可能略有差异，
   * 导致各端 electionTimeout 不完全相同。这不影响正确性——先超时的端重启选举时发出的
   * nominate 会被其他端按正常投票流程处理，最终通过投票机制收敛到唯一房主。
   */
  readonly electionTimeout?: number;
  /** requestId 碰撞重试上限（默认 5）。超过上限抛出 REQUEST_ID_CONFLICT 错误 */
  readonly requestIdRetryLimit?: number;
  /**
   * 房主端 request 拦截器（外部卡点）
   *
   * 房主收到管理员 request 并从队列取出处理时，优先调用此函数。
   * - resolve → 允许执行（继续后续校验和操作）
   * - reject(error) → 拒绝执行（error.message 作为拒绝原因回复给管理员）
   *
   * @param request - 管理员发来的请求消息
   * @param from - 发送者 peerId（从 PeerEntry.peerId 获取，不可伪造）
   *
   * 不传则默认全部允许。
   * 超时时间复用 requestTimeout（默认 5000ms），超时后视为拒绝（error = 'interceptor timeout'）。
   * 注意：当前 interceptor 超时复用 requestTimeout，若业务侧需要更长的人机交互时间
   * （如弹窗确认），建议先调大 requestTimeout，或等待后续版本引入独立的 interceptorTimeout 配置。
   * 适用场景：业务侧弹窗确认、频率限制、自定义业务规则校验等。
   */
  readonly requestInterceptor?: (request: RequestMessage, from: string) => Promise<void>;
}

interface RtcRoomOptions {
  // 以下为权限系统新增配置项（其余已有字段如 roomId、signaling 等省略）
  /** 行为开关 */
  readonly switches?: RoomSwitches;
  /** 权限系统参数配置（仅 enablePermissions=true 时生效） */
  readonly parameters?: PermissionParameters;
}
```

### 新增 RtcRoom 属性与方法

```typescript
interface RtcRoom<UserEvents> {
  // ── 权限控制（enablePermissions=true 时可用） ──

  /** 当前房主 peerId */
  readonly hostId: string;
  /** 当前管理员列表（含房主） */
  readonly adminIds: readonly string[];
  /** 本地 peer 是否有管理权限（getter: adminIds.includes(localPeerId)） */
  readonly hasAdminPermission: boolean;
  /** 本地 peer 是否为房主（getter: hostId === localPeerId） */
  readonly isHost: boolean;

  /**
   * 踢出指定 peer（需管理权限，不可踢房主，管理员间不可互踢。不接受 '*'）
   * - 房主调用：本地同步执行，Promise 立即 resolve
   * - 管理员调用：等待房主 ack 后 resolve（不等待 result），ack 超时则 reject
   */
  kick: (targetPeerId: string, reason?: string) => Promise<void>;

  /**
   * 禁言（三层粒度）
   * target 类型 `(string & {}) | '*'`：TS 技巧——`string & {}` 阻止字面量联合被合并，
   * 使 IDE 在补全时优先提示 '*'，同时仍允许传入任意 peerId 字符串。
   * 注意：'*' 仅在 mute/unmute 中合法（表示操作房间层），kick/addAdmin/removeAdmin/transferHost 不接受 '*'。
   * - 房主调用：本地同步执行，Promise 立即 resolve
   * - 管理员调用：等待房主 ack 后 resolve（不等待 result），ack 超时则 reject
   *
   * **重要**：管理员调用时，resolve 仅表示 request 已被房主接受入队（收到 ack(success=true)），
   * **不代表操作最终成功**。最终执行结果通过 'request-result' 事件异步通知。
   * 若需确认操作是否真正生效，应监听 room.on('request-result', handler) 并匹配 requestId。
   */
  mute: (target: (string & {}) | '*', scope?: MuteScope) => Promise<void>;

  /**
   * 解除禁言（admin 不可自解禁）。'*' 仅在 mute/unmute 中合法（表示操作房间层）
   * - 房主调用：本地同步执行，Promise 立即 resolve
   * - 管理员调用：等待房主 ack 后 resolve（不等待 result），ack 超时则 reject
   *
   * **重要**：管理员调用时，resolve 仅表示 request 已被房主接受入队（收到 ack(success=true)），
   * **不代表操作最终成功**。最终执行结果通过 'request-result' 事件异步通知。
   */
  unmute: (target: (string & {}) | '*', scope?: MuteScope) => Promise<void>;

  /** 查询某 peer 的禁言状态 */
  getMuteState: (targetPeerId: string) => MuteState;

  /** 转让房主（仅房主可调用，不接受 '*'） */
  transferHost: (targetPeerId: string) => void;

  /** 添加管理员（仅房主可调用，不接受 '*'） */
  addAdmin: (targetPeerId: string) => void;

  /** 移除管理员（仅房主可调用，不接受 '*'） */
  removeAdmin: (targetPeerId: string) => void;

  /**
   * 待完结缓冲区中的请求列表（已被房主接受但尚未收到 result 的 request，只读）
   */
  readonly awaitingRequests: readonly RequestMessage[];

  /**
   * 取消所有排队中（尚未发送）的 request（仅管理员端有效）
   * @returns cancelled - 被取消的请求列表；inflight - 当前正在等待 ack 的请求（不可取消），无则为 null
   */
  cancelPendingRequests: () => { cancelled: RequestMessage[]; inflight: RequestMessage | null };
}
```

### 新增事件

```typescript
interface RoomBuiltinEvents {
  /** 有人被踢出（所有端收到） */
  'member-kicked': { peerId: string; from: string; reason?: string };

  /** 禁言状态变更（所有端收到）。peerId 为目标用户 ID，全房间禁言时为 '*' */
  'member-muted': { peerId: string; scope?: MuteScope; from: string };
  'member-unmuted': { peerId: string; scope?: MuteScope; from: string };

  /** 房主变更（所有端收到） */
  'host-changed': { prevHost: string; newHost: string };

  /** 管理员变更（所有端收到） */
  'admin-added': { peerId: string; from: string };
  'admin-removed': { peerId: string; from: string };

  /** 本地被踢出 */
  'kicked': { from: string; reason?: string };

  /** 本地被禁言/解禁 */
  'muted': { scope?: MuteScope; from: string };
  'unmuted': { scope?: MuteScope; from: string };

  /** 检测到越权广播 */
  'forbidden-broadcast-detected': { peerId: string; event: string };

  /** 管理员 request 超时 */
  'request-timeout': { requestId: string; action: string };

  /** 内部错误（所有内部 throwError 均会先 dispatch 此事件再抛出） */
  'error': RoomErrorEvent;

  /** 管理员 request 最终执行结果（收到 result 报文） */
  'request-result': RequestResultEvent;
}

/**
 * request-result 事件 payload——按 success 做 discriminated union
 */
type RequestResultEvent =
  | { success: true; requestId: string; action: string; target: string; scope?: MuteScope }
  | { success: false; requestId: string; action: string; target: string; scope?: MuteScope; error: string };
// 注：scope 字段仅 mute/unmute 操作时有值，kick 操作时为 undefined
```

### 新增错误类型

```typescript
/** 权限系统未启用时调用权限 API */
class RoomPermissionDisabledError extends Error {
  readonly code = 'PERMISSION_DISABLED';
}

/** 无写权限（ctrlChannelWritable 为 false） */
class RoomPermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED';
}

/** 被禁言时尝试发送消息 */
class RoomMutedError extends Error {
  readonly code = 'MUTED';
}

/** 操作目标不合法（踢房主、管理员互踢、自解禁等） */
class RoomIllegalOperationError extends Error {
  readonly code = 'ILLEGAL_OPERATION';
}

/** 收到越权广播（发送方无写权限） */
class RoomForbiddenBroadcastError extends Error {
  readonly code = 'FORBIDDEN_BROADCAST';
}

/** 管理员 request ack 超时 */
class RoomRequestTimeoutError extends Error {
  readonly code = 'REQUEST_TIMEOUT';
}

/** 管理员 request 被房主拒绝（ack(success=false)，如权限不足/队列满/校验失败） */
class RoomRequestRejectedError extends Error {
  readonly code = 'REQUEST_REJECTED';
}

/** sync-state 数据校验失败（结构不匹配、字段类型错误等） */
class RoomSyncStateInvalidError extends Error {
  readonly code = 'SYNC_STATE_INVALID';
}
```

**错误 dispatch 原则**：所有内部 throwError 在抛出前，先 `dispatch('error', payload)`，其中 payload 为 `RoomErrorEvent` 联合类型中的某一项。业务侧可通过 `code` 字段 switch-case 并获得精确的类型推导，无需每个调用点都 try-catch。

```typescript
/**
 * error 事件 payload——按 code 做 discriminated union
 */
type RoomErrorEvent =
  | { code: 'PERMISSION_DISABLED'; error: Error; message: string; context: 'permissions' }
  | { code: 'PERMISSION_DENIED'; error: Error; message: string; context: 'kick' | 'mute' | 'unmute' | 'addAdmin' | 'removeAdmin' | 'transferHost'; target: string }
  | { code: 'FORBIDDEN_BROADCAST'; error: Error; message: string; context: 'assertControlPermission'; from: string; eventType: string }
  | { code: 'MUTED'; error: Error; message: string; context: 'send'; channel?: string; event?: string }
  | { code: 'ILLEGAL_OPERATION'; error: Error; message: string; context: 'kick' | 'mute' | 'unmute' | 'transferHost' | 'addAdmin' | 'removeAdmin' | 'batch'; target?: string; rawData?: unknown }
  | { code: 'REQUEST_TIMEOUT'; error: Error; message: string; context: 'request'; requestId: string; action: string }
  | { code: 'REQUEST_REJECTED'; error: Error; message: string; context: 'request'; requestId: string; action: string; reason: string }
  | { code: 'REQUEST_ID_CONFLICT'; error: Error; message: string; context: 'requestId' }
  | { code: 'SYNC_STATE_INVALID'; error: Error; message: string; context: 'syncState'; rawData?: unknown };
```

**注意**：`error` 事件**仅本地 dispatch**，不通过 `__room_ctrl__` channel 或任何 DataChannel 传输。Error 对象不可序列化，且错误处理属于本地行为。

```typescript
// 业务侧使用示例
room.on('error', (event) => {
  switch (event.code) {
    case 'MUTED':
      // TypeScript 自动推导 event.channel / event.event 可用
      toast(`发送被拦截：channel=${event.channel}`)
      break
    case 'FORBIDDEN_BROADCAST':
      // TypeScript 自动推导 event.from / event.eventType 可用
      console.warn(`越权广播：${event.from} → ${event.eventType}`)
      break
    case 'REQUEST_TIMEOUT':
      // TypeScript 自动推导 event.requestId / event.action 可用
      toast(`操作超时：${event.action}`)
      break
  }
})
```

所有控制消息通过 `__room_ctrl__` channel 传输。所有用户都能接收（只读），仅房主/管理员可发送（写权限）。接收方在 channel 的 message handler 中处理控制消息，不透传给用户事件系统。

**`from` 字段语义**：控制消息中的 `from` 字段含义统一——在广播消息（`RoomControlEvent`）中，`from` 为执行操作的管理员/房主的 peerId；在接收方校验时，`from` 从 `PeerEntry.peerId` 获取（建连时确定的对端身份，不可伪造），两者应一致。`RequestMessage` 中不包含 `from`/`by` 字段，因为房主端通过 `PeerEntry.peerId` 确定发送者身份。

**requestId 生成规则**：格式为 `${localPeerId}:${随机字符串}`，仅用于匹配 ack 响应，不会被解析或拆分。peerId 前缀仅为可读性和调试便利，无结构化语义。若生成的 requestId 与本地已有的 pending request 碰撞（队列内冲突检测），则重新生成随机部分，最多重试 `parameters.requestIdRetryLimit ?? 5` 次；超过重试上限则抛出 `REQUEST_ID_CONFLICT` 错误（此场景在随机字符串长度足够时极不可能发生，属于防御性兜底）。
### 控制消息类型

```typescript
/**
 * 通过 __room_ctrl__ channel 传输的所有消息类型
 *
 * 按传输方式分为：
 * - 广播（房主 → 所有端）：BatchMessage（顶层传输格式，含 events 数组）
 * - 单播（房主 → 特定管理员）：request-ack、request-result
 * - 单播（管理员 → 房主）：request
 * - 广播/单播（选举期间）：host-nominate、nominate-ack、vote-compare、vote-result
 *
 * 注意：BatchMessage 是 __room_ctrl__ channel 上实际传输的顶层消息格式之一，
 * 其内部 events 数组中的每个元素为 RoomControlEvent（含 sync-state）。
 * 接收方先解析顶层消息类型，若为 batch 则按序处理 events。
 */
type ControlChannelMessage =
  | BatchMessage
  | RoomControlEvent | RequestMessage | RequestAck | RequestResult
  | HostNominate | NominateAck | VoteCompare | VoteResult;

/** 房间控制事件（广播消息，通过 batch 合并广播给所有端） */
type RoomControlEvent =
  | { type: 'kick'; target: string; from: string; reason?: string }
  | { type: 'mute'; target: string; from: string; scope?: MuteScope }
  | { type: 'unmute'; target: string; from: string; scope?: MuteScope }
  | {
      type: 'host-transfer';
      prevHost: string;
      newHost: string;
      /**
       * 仲裁权重（用于分区恢复时裁决唯一房主）
       * - 选举继位：实际收到的投票数
       * - transferHost 手动转让：ctx.memberJoinOrder.length（保证 ≥ 任何选举票数，使手动指定的房主在仲裁中始终胜出）
       */
      voteCount: number;
      /**
       * 仲裁优先级（用于分区恢复时 voteCount 相等的 tiebreaker）
       * - 选举继位：当选者在 hostCandidates 中的 index
       * - transferHost 手动转让：-1（保证在 voteCount 相等时仍胜出，-1 < 任何有效 index）
       */
      candidateIndex: number;
    }
  | { type: 'admin-add'; target: string; from: string }
  | { type: 'admin-remove'; target: string; from: string }
  | { type: 'sync-state'; muteRegistry: SerializedMuteRegistry; adminIds: string[]; hostId: string; memberJoinOrder: string[]; kickedPeerIds: string[]; hostCandidates: string[]; voteCount: number; candidateIndex: number }

/** 管理员 → 房主的操作请求（单播） */
interface RequestMessage {
  type: 'request';
  requestId: string;        // 唯一标识，仅用于匹配 ack。格式 `${peerId}:${随机串}`，无结构化语义，不做解析
  action: 'kick' | 'mute' | 'unmute';
  target: string;
  scope?: MuteScope;
  reason?: string;
}

/** 房主 → 管理员的 ack 响应（表示已接受该 request 进入队列，管理员收到 ack 后队列流转，可发送下一个 request） */
interface RequestAck {
  type: 'request-ack';
  requestId: string;        // 对应 request 的 requestId
  success: boolean;         // true = 已接受入队；false = 拒绝（权限不足 / 队列满）
  error?: string;           // success=false 时的拒绝原因
}

/**
 * 房主 → 管理员的 result 响应（通知请求的最终执行结果）
 * 房主从 requestQueue 取出 request 并执行后，向发起该 request 的管理员单播 result 报文。
 * 管理员据此获得操作最终成功/失败的反馈。
 */
interface RequestResult {
  type: 'request-result';
  requestId: string;        // 对应 request 的 requestId
  action: 'kick' | 'mute' | 'unmute';  // 原始请求的 action
  target: string;           // 原始请求的 target
  scope?: MuteScope;        // 原始请求的 scope（mute/unmute 时有值，kick 时为 undefined）
  success: boolean;         // true = 执行成功；false = 执行失败
  error?: string;           // success=false 时的失败原因（如 requestInterceptor 拒绝、校验失败等）
}
```

## 内部实现

### 前置开关断言

```text
function assertPermissionsEnabled(ctx):
  if (!ctx.switches.enablePermissions):
    const err = new RoomPermissionDisabledError('权限系统未启用')
    dispatch('error', { error: err, code: 'PERMISSION_DISABLED', message: '权限系统未启用', context: 'permissions' })
    throwError('permissions', '权限系统未启用，请设置 switches.enablePermissions = true', RoomPermissionDisabledError)
```

### 越权广播检测（断言模式，全局守卫）

```text
function assertControlPermission(ctx, from, eventType, msg?):
  // msg 参数：仅 eventType === 'request' 时必传（需引用 msg.requestId 回复 ack）。
  // 其他 eventType 不使用 msg，传 undefined 即可。
  assertPermissionsEnabled(ctx)

  // 空窗期特殊豁免：hostId 为空时允许选举相关消息通过（投票式选举场景）
  if (ctx.hostId === '' && ['host-nominate', 'nominate-ack', 'vote-compare', 'vote-result', 'host-transfer'].includes(eventType)):
    return

  requiredLevel = getRequiredPermissionLevel(eventType)
    - 'host-transfer' | 'admin-add' | 'admin-remove' → 'host'
    - 'request' → 'admin'（特殊处理，见下方 request 分支）
    - 其余 → 'admin'

  if (requiredLevel === 'host' && from !== ctx.hostId):
    → 越权！
  if (requiredLevel === 'admin' && !ctx.adminIds.includes(from)):
    → 越权！
  // 管理员被禁言 __room_ctrl__ channel 后，即使仍在 adminIds 中也不允许发送控制消息
  // 注：无需额外排除 host——checkMute 入口已有 host 免疫判断（peerId === ctx.hostId → return false）
  if (requiredLevel === 'admin' && checkMute(ctx, from, '__room_ctrl__')):
    // request 类型消息的越权处理：走 ack 拒绝路径而非断连路径
    // 原因：管理员可能因网络延迟尚未收到禁言 batch，此时发出 request 不属于恶意越权，
    // 而是时序差异导致的合法竞态。断连惩罚过重，ack 拒绝已足够阻止操作执行。
    if (eventType === 'request'):
      assertNonNull(msg, 'assertControlPermission: request 分支必须传入 msg 参数')
      // assertNonNull 为开发期防御性断言（运行时不应被触发），
      // 失败时抛出 RoomIllegalOperationError（调用方传参错误属非法操作）
      sendTo(from, { type: 'request-ack', requestId: msg.requestId, success: false, error: '无写权限（__room_ctrl__ 已被禁言）' })
      return  // 不断连、不 throwError，仅拒绝该 request
    → 越权！

  // 越权处理（非 request 类型消息）:
  1. dispatch('forbidden-broadcast-detected', { peerId: from, event: eventType })
  2. dispatch('error', { code: 'FORBIDDEN_BROADCAST', ... })
  3. if ((switches.autoDisconnectOnForbiddenBroadcast ?? true) !== false):
       dispose 与 from 的 controller + 从 peers 移除
  4. throwError（阻断后续逻辑）
```

### performLeave（离开房间）

```text
performLeave():
  1. 断开所有 P2P 连接（close 所有 PeerConnection + DataChannel）
  2. 清理本地状态（peers、memberJoinOrder、muteRegistry、hostId 等归零）
  3. 销毁 requestQueue（若存在）+ 清空 awaitingResult 缓冲区
  4. 清除竞选计时器（若存在）
  5. dispatch('left')（本地事件，通知业务层）
```

**关键特性**：
- **不发送任何消息**：不通过 `__room_ctrl__` channel 或任何 DataChannel 发送消息，因此**无需禁言检测**
- **不广播 `member-left`**：其他端通过底层连接断开事件（ICE disconnected / DataChannel close）自行检测该 peer 离开
- **被 kick 时调用**：target 收到 kick 事件后调用 `performLeave()`，效果等同主动离开
- **主动离开时调用**：用户调用 `room.leave()` 时内部委托给 `performLeave()`

### 新增 RoomContext 字段

```typescript
interface RoomContext {
  // 以下为权限系统新增字段（enablePermissions=true 时初始化）
  // 所有源状态字段均使用 JSON 兼容类型（string[] / Record），便于序列化和 sync-state 传输

  // ── 源状态（由 sync-state 覆盖） ──
  hostId: string;
  /** 管理员列表（含房主） */
  adminIds: string[];
  /** 禁言注册表（两层结构：room 层 + users 层） */
  muteRegistry: MuteRegistry;
  /** 按加入顺序记录成员（数组保持插入顺序） */
  memberJoinOrder: string[];
  /** 被踢用户缓存（阻止断线重连绕过 kick，房间生命周期内有效） */
  kickedPeerIds: string[];
  /** 房主候选列表（房主端生成，按优先级排序，用于投票式选举） */
  hostCandidates: string[];
  /** 行为开关 */
  readonly switches: RoomSwitches;

  // ── 选举元数据（投票式选举产生房主后记录，用于分区恢复仲裁） ──

  /**
   * 当选时的票数（transferHost 手动转让时为 ctx.memberJoinOrder.length，保证 ≥ 任何选举票数）
   * 初始值：首个进房用户自动成为房主时为 1（仅自身），后续通过 sync-state 覆盖
   */
  electionVoteCount: number;
  /**
   * 当选时在 hostCandidates 中的 index（transferHost 手动转让时为 -1）
   * 初始值：首个进房用户自动成为房主时为 -1（非选举产生），后续通过 sync-state 覆盖
   * -1 表示非选举产生（初始房主或手动转让），消费方（分区仲裁）仅比较数值大小，无需区分来源
   */
  electionCandidateIndex: number;
  /** 是否正在进行选举（空窗期标记，true 时挂起新成员连接） */
  electionInProgress: boolean;
  /** 空窗期挂起的 peer 队列（选举完成后由新房主逐个处理） */
  pendingPeers: string[];

  // ── 房主端 request 队列（仅 isHost 时初始化，非房主不创建，避免不必要开销） ──

  /**
   * 房主端待处理 request 队列（复用 `src/shared/priority-queue`，仅使用入队/出队能力，无优先级需求）
   * 按接收顺序 FIFO 处理，房主逐个从队列取出并执行
   * 仅在 isHost === true 时初始化，transferHost 时旧房主销毁、新房主初始化
   */
  /**
   * `from` 字段在房主端收到 request 后从 PeerEntry.peerId 注入（建连时确定的对端身份），
   * RequestMessage 本身不含 from——发送方身份由 transport 层保证，不可伪造。
   */
  requestQueue?: PriorityQueue<RequestMessage & { from: string }>;

  // ── 派生状态（getter + 缓存，sync-state 后清缓存） ──

  /**
   * 本地 peer 是否拥有 __room_ctrl__ channel 写权限（getter）
   * 计算逻辑：adminIds.includes(localPeerId) && !checkMute(ctx, localPeerId, '__room_ctrl__')
   * host 永远为 true（免疫禁言）
   * 注意：__room_ctrl__ 仅在用户层具名匹配，房间层的全禁标记不影响该 channel
   */
  readonly ctrlChannelWritable: boolean;

  /**
   * 本地 peer 是否为房主（getter）
   * 计算逻辑：hostId === localPeerId
   */
  readonly isHost: boolean;

  /**
   * 本地 peer 是否有管理权限（getter）
   * 计算逻辑：adminIds.includes(localPeerId)
   */
  readonly hasAdminPermission: boolean;
}
```

**派生状态缓存机制**：

```text
所有 getter 采用统一的缓存策略：
  - 首次读取时计算并缓存结果
  - 收到 sync-state 后清除所有派生状态缓存
  - 下次读取时重新计算并缓存

invalidateCache():
  清除 ctrlChannelWritable / isHost / hasAdminPermission 的缓存值
  （在 sync-state 处理完成后调用）

ctrlChannelWritable getter:
  if (cache.ctrlChannelWritable !== undefined) return cache.ctrlChannelWritable
  if (localPeerId === ctx.hostId) → cache = true（host 永远可写）
  else → cache = adminIds.includes(localPeerId) && !checkMute(ctx, localPeerId, '__room_ctrl__')
  return cache.ctrlChannelWritable
```

## 边界行为

### 权限系统未启用时（`enablePermissions` 为 false 或未设置）

- 不建立 `__room_ctrl__` channel
- `hostId`、`adminIds`、`isHost`、`hasAdminPermission` 等属性**不暴露**（返回 undefined / 空数组）
- `kick`、`mute`、`unmute`、`transferHost`、`addAdmin`、`removeAdmin` 调用时直接 throwError
- 消息收发正常，无禁言拦截逻辑
- 若意外收到 `__room_ctrl__` channel 消息则静默忽略

### 全房间禁言事件中的 peerId 字段

`member-muted` / `member-unmuted` 事件的 `peerId` 字段：
- 针对特定用户时：值为目标用户的 peerId
- 全房间禁言时：值为 `'*'`

### admin 被禁言后的行为

- admin 被用户级全禁后，**管理能力不受影响**——因 `__room_ctrl__` channel 仅在用户层具名匹配
- admin 被禁言 `__room_ctrl__` channel 后，`ctrlChannelWritable` getter 为 false，失去管理能力
- channel 禁言仅影响写权限，admin 仍能接收消息
- admin 不可自解禁
- **host 永远免疫禁言**

### kick 缓存防重连

- kick 成功后，被踢用户的 peerId 加入 `kickedPeerIds` 缓存
- 新 peer 连接 / 断线重连时，房主端校验 peerId 是否在 `kickedPeerIds` 中
- `kickedPeerIds` 通过 sync-state 同步给所有端
- 房间关闭销毁后缓存随之清除

### 房间仅剩一人时

- 该用户即为房主
- 无需广播 host-transfer
- 本地直接更新状态并 dispatch 事件

### 所有成员离开

- 所有成员离开后房间自动关闭销毁
- 后续以相同 roomId 加入视为全新房间

### 转让房主后旧房主的禁言

- 转让后旧房主降级为普通用户，muteRegistry 中已有禁言条目**立即生效**

## 设计决策

### 模块架构

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 模块定位 | rtc-room 的**子模块** | 权限是房间能力的一部分，非独立实体 |
| 解耦方式 | transport 接口（8 个方法 + 1 只读属性，见上方 `PermissionTransport` 定义） | 单向依赖，无需 DataChannel/PeerConnection |
| 发送拦截 | `permissionController.checkSendPermission()` | 一行守卫调用，耦合极低 |
| API 暴露 | 内部委托 permissionController | 零破坏性，用户无感知 |
| 懒加载 | `enablePermissions=false` 时不初始化 | tree-shaking 友好 |
| 可测试性 | mock transport 纯内存测试 | 无需 WebRTC 环境 |

### 配置与开关

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 权限系统启用 | `enablePermissions` 显式开关（默认 false） | 非默认行为，调用方决定 |
| 前置开关断言 | 所有 API 入口断言 | 统一守卫，未启用时明确报错 |
| 配置方式 | `switches` 通用行为开关对象 | 后续可扩展更多开关 |
| 越权广播断连 | 配置开关（默认 true） | 用户可控 |

### 通信协议

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 传输通道 | 独立房间管理 channel `__room_ctrl__` | 与业务消息物理隔离 |
| channel 建立 | 所有用户都建立 | 全员可接收，管理员可写 |
| 操作流向 | 管理员 → request → 房主执行 + 合并广播 | 节省 channel 流量 |
| 合并广播 | 控制事件 + sync-state 合为 batch | 减少 DataChannel 消息数 |
| 内部/外部事件命名 | 内部动词原形，外部过去分词 | 语义不同 |
| 越权广播处理 | 断言模式 | 降低圈复杂度 |
| kick 送达方式 | 广播通知 | 简化流程 |

### 角色与权限

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 房主产生 | **组网协商**：首个进房用户自动为房主 | 无需外部配置，自然语义 |
| 房主标识 | `hostId: string` | 所有端共享同一 ID，接收方可校验合法性 |
| 房主冗余 | **hostId 同时存在于 adminIds** | 基本权限校验只需 `adminIds.includes(from)`，降低心智 |
| 房主免疫 | **不可被禁言/踢出** | 最高权限保障 |
| isHost / hasAdminPermission | **getter + 缓存** | 可从源状态计算，无需手动维护 |
| 管理员操作 | 仅房主可指派/移除，管理员间无法互操作 | 权限层级清晰（host → admin → user 单向管理链） |
| admin 自解禁 | **禁止** | 防止管理员绕过禁言 |
| 身份校验 | `from` 从 `PeerEntry.peerId` 获取 | 建连时确定的对端身份，不可伪造 |

> 继位相关决策详见 [archive/RFC-succession.md](./archive/RFC-succession.md)、[archive/RFC-election.md](./archive/RFC-election.md)

### 禁言机制

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 禁言粒度 | **三层**：用户级 / channel 级 / 事件级 | channel 禁言 = 该 channel 不可写 |
| channel 禁言效果 | **仅影响写权限**（发送拦截），消息接收不受影响 | 被禁言用户仍能收到消息，只是无法发送 |
| 禁言发送方 | **抛错** | 调用方明确感知，便于 UI 处理 |
| 全房间禁言 | `mute('*', scope?)` | host 免疫，admin 是否免疫由 `roomMuteAffectsAdmin` 开关决定 |
| `__room_ctrl__` 免通配 | **不受** allMuted / 全房间禁言影响 | 管理 channel 只能被具名禁言，防止意外剥夺管理能力 |
| `__room_ctrl__` 禁言/解禁权 | **仅房主** | 管理员不可剥夺其他管理员的管理 channel 写权限 |
| 禁言约束管理操作 | `ctrlChannelWritable` getter 为 false 则拒绝 | 单一判断点 |
| getMuteState 过滤 | 返回值永不包含 `__room_ctrl__` channel 条目 | 内部实现细节，对外不可见 |
| 默认房间禁言 | `defaultRoomMute` 开关（默认 false） | 房主 join 成功后若为 true，自动执行 `mute('*')` |

> 禁言数据结构与匹配算法详见 [RFC-mute.md](./RFC-mute.md)、[RFC-mute-refactor.md](./archive/RFC-mute-refactor.md)

### 队列与超时

> 队列与超时相关的完整设计决策详见 [RFC-request-queue.md](./RFC-request-queue.md) 设计决策表，此处不再重复

### 状态同步

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 派生状态 | getter + 缓存，sync-state 后清缓存 | 降低维护难度 |
| 非房主端状态操作 | 控制事件仅 dispatch，不修改源状态 | 统一由 sync-state 覆盖，避免中间态不一致 |
| 状态同步 | **仅房主发出**，接收方覆盖（不合并） | 以房主为准，避免多端冲突 |
| 断线重连 | 重连后房主主动下发 sync-state | 确保断线期间错过的状态变更被同步 |
| memberJoinOrder | `string[]` | 数组保持插入顺序，JSON 兼容 |
| 序列化无版本字段 | SerializedMuteRegistry 不含 version | 非持久化房间，不考虑跨版本兼容 |

> 同步完整流程详见 [RFC-sync.md](./RFC-sync.md)

### 错误处理

| 决策点 | 选择 | 理由 |
|--------|------|------|
| error 事件类型 | 按 `code` 做 discriminated union | 精确类型推导 |
| kick 缓存 | `kickedPeerIds: string[]` 通过 sync-state 同步 | 防止被踢用户断线重连绕过检测 |
| 房间关闭语义 | 所有成员离开 → 自动销毁 | 不存在重入旧房间 |

## 附录 B TypeScript 类型技巧

### `(string & {}) | '*'` 字面量补全保留

`mute` / `unmute` 的 `target` 参数使用 `(string & {}) | '*'` 类型：

- `string & {}` 接受任意非 null/undefined 的 string，保留 IDE 对 `'*'` 字面量的自动补全提示
- 若直接写 `string | '*'`，TypeScript 会将 `'*'` 拓宽为 string，丢失字面量提示
- 运行时无额外开销，纯类型层面的技巧
