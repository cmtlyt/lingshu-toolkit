# rtcRoom 实施清单

> 基于 RFC.md (0.1.0, draft) 的逐步落地计划
>
> **使用方式**：每完成一项，将 `[ ]` 改为 `[x]`；每个条目末尾的 `→ RFC#xxx` 为对应设计章节的描述，可回 RFC.md 查看源头需求

## 开发守则（Phase 全程生效）

### 测试运行约定 🚨

- **严禁跑全仓库测试** `pnpm run test:ci`（无参数形式会串行跑全部测试文件，每次改动都跑是浪费）
- 改动哪里只测哪里，统一使用 `pnpm run test:ci <path>` 精确执行：
  - **单文件**：`pnpm run test:ci src/shared/rtc-room/__test__/core/signaling-bridge.test.ts`
  - **单目录**：`pnpm run test:ci src/shared/rtc-room/__test__/`
  - **单 Phase**：按 Phase 所属目录精准指定
- 全仓 `pnpm run test:ci` 仅在**用户明确要求**或 **Phase 结束前统一收口**时才执行
- 涉及真实定时器的用例（`setTimeout` / `clearTimeout`）优先用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()` 替代，避免无意义阻塞

### 错误处理与类型约定

- 报错统一走 `shared/throw-error`（`throwError` / `throwType` / `createError`），**禁止 `throw new Error` 直抛**（AGENTS.md 规范）
- 错误子类定义模式：`constructor(message?: string, options?: ErrorOptions) { super(message, options); this.name = '...'; }`
- 调用 `throwError` 传子类时，需 `RoomXxxError as unknown as ErrorConstructor` 局部类型适配

### 代码风格

- 全量走 Biome：`pnpm run check` 在 Phase 结束前必须零错误
- 注释原则：解释"为什么"而非"怎么做"；**严禁 TODO / FIXME 注释**
- 顶级 `export` 统一放文件末尾（`export { xxx }` 形式）
- **路径别名**：跨目录 import 统一使用 `@/shared/...` 别名，**禁止 `../../` 这类多级相对路径**
- **循环形式**：数组/类数组遍历**优先使用索引 `for` 循环**而非 `for...of`
- **空值兜底运算符**：非必要场景优先使用 `||`，仅在需要严格区分 null/undefined 与其他 falsy 值时保留 `??`
- **logger 字段级混合兜底**：复用 `@/shared/logger` 的 `resolveLoggerAdapter`，通过 `adapters/logger.ts` 薄包装绑定 `rtcRoom` 的 ERROR_FN_NAME

### 测试文件组织

- 所有测试文件统一收敛到 `__test__/` 目录，**禁止**在模块根目录放置测试文件
- 类型测试（`.test-d.ts`）与逻辑测试（`.test.ts`）分离
- 浏览器 API 测试使用 `.browser.test.ts` 后缀
- 房间信令适配器使用 mock 实现（内存消息路由，不走真实网络）
- 底层 `RtcController` 在非浏览器测试中可 mock（验证 Room 层逻辑即可）

### 与 rtc-controller 的依赖约定

- `rtc-room` 依赖 `rtc-controller` 但不修改其公开 API → RFC#决策记录#1
- 通过 `RtcControllerInternalOptions.__onUserEvent` 钩子桥接自定义事件 → RFC#决策记录#7
- P2P 信令（`SignalingAdapter`）由 Room 内部自动派生，用户只需实现 `RoomSignalingAdapter` → RFC#决策记录#2

## Phase 1 — 类型与基础件（无浏览器 API 依赖）

- [ ] 1.1 创建 `types.ts`：所有公开类型签名 → RFC#API设计 + RFC#附录A
  - `RoomPhase`：`'idle' | 'joining' | 'joined' | 'leaving' | 'left' | 'disposed'`
  - `PeerSignalingMessage`：`{ readonly from: string; readonly signal: SignalingMessage }`
  - `RoomSignalingMessage`：联合类型（`member-joined` / `member-left` / `peer-signal`）
  - `RoomSignalingAdapter`：房间信令接口（`join` / `leave` / `sendTo` / `onMessage` / `dispose?`）
  - `RoomBuiltinEvents`：11 个内置事件（`room-phase-change` / `member-joined` / `member-left` / `peer-connected` / `peer-disconnected` / `peer-failed` / `track` / `track-removed` / `data-channel-ready` / `raw-message` / `error`）
  - `RoomEventPayload<P>`：`{ readonly from: string; readonly payload: P }` 包装
  - `AllRoomEvents<UserEvents>`：`RoomBuiltinEvents & { [K in keyof Omit<UserEvents, keyof RoomBuiltinEvents>]: RoomEventPayload<UserEvents[K]> }`——合并内置事件 + 用户事件（用户事件自动包装，内置事件始终优先）
  - `RtcRoomOptions`：房间配置项（`peerId` / `roomSignaling` / `rtcConfig` / `dataChannelLabel` / `dataChannelOptions` / `autoCreateDataChannel` / `connectTimeout` / `joinTimeout` / `signal` / `logger`）
  - `RtcRoom<UserEvents>` 接口：事件（`on` / `once` / `off`）/ 房间管理（`join` / `leave`）/ 消息（`broadcast` / `send` / `sendRaw` / `broadcastRaw`）/ 媒体（`addTrack` / `removeTrack` / `getRemoteStreams` / `getAllRemoteStreams`）/ 连接管理（`reconnectPeer` / `reconnectAll` / `getPeerController`）/ 状态查询（`phase` / `peerId` / `members` / `getPeerStates` / `getPeerStats`）
  - 内部类型 `PeerEntry`：`{ peerId; controller; derivedSignaling; trackSenders: Map<string, RTCRtpSender> }` → RFC#成员列表维护
  - 内部类型 `LocalTrackEntry`：`{ trackId; track; streams }` → RFC#本地轨道管理
  - 内部类型 `DerivedSignalingAdapter`：扩展 `SignalingAdapter` 的内部派生适配器，含 `__handlers` 字段供 Room 直接分发信令 → RFC#派生SignalingAdapter
- [ ] 1.2 创建 `constants.ts`：`DEFAULT_JOIN_TIMEOUT`（10000ms）、`ERROR_FN_NAME`（`'rtcRoom'`）等配置常量 → RFC#常量
- [ ] 1.3 创建 `errors.ts`：5 个错误子类（错误消息前缀 `[@cmtlyt/lingshu-toolkit#rtcRoom]`）→ RFC#错误类型
  - `RoomInvalidStateError`：在非法的 phase 下调用操作（如 `idle` 状态下 `broadcast`；`joining` 状态下再次 `join`）
  - `RoomSignalingError`：房间信令 `join` / `leave` / `sendTo` 抛错；`cause` 字段携带原始错误
  - `RoomDisposedError`：`dispose()` 后继续调用任何方法；`signal.aborted` 后任意调用
  - `RoomTimeoutError`：`join()` 超过 `joinTimeout` 仍未获取成员列表
  - `RoomPeerNotFoundError`：`send()` / `sendRaw()` / `reconnectPeer()` / `getPeerStats()` 指定的 peerId 不在成员列表中，或对应 controller 未 connected
- [ ] 1.4 实现 `adapters/logger.ts`：薄包装绑定 `ERROR_FN_NAME = 'rtcRoom'`，复用 `@/shared/logger` 的 `resolveLoggerAdapter` → RFC#logger适配器
- [ ] 1.5 实现 `core/event-emitter.ts`：房间级事件系统（可直接复用 rtc-controller 的 event-emitter 实现，或 re-export）→ RFC#目录规划
- [ ] 1.6 创建 `_meta.json`：文档元信息 → RFC#目录规划
- [ ] 1.7 创建 `__test__/helpers/mock-room-signaling.ts`：`createMockRoomSignaling()` 测试用内存房间信令适配器 → RFC#Mock房间信令适配器
  - 维护成员列表（`Set<string>`）+ 每个成员的消息处理器（`Map<string, Array<callback>>`）
  - `broadcastExcept(sender, message)`：向除发送者外的所有成员分发消息
  - `createAdapter(peerId)` 返回独立的 `RoomSignalingAdapter` 视角（`join` 时广播 `member-joined`；`leave` 时广播 `member-left` + 清理 handlers；`sendTo` 路由到目标 peer 的 handlers 并包装为 `peer-signal`）
  - `getMembers()` 获取当前房间成员列表
- [ ] 1.8 验收：`pnpm run check` + Phase 1 类型编译通过

## Phase 2 — 核心房间逻辑

- [ ] 2.1 实现 `core/signaling-bridge.ts`：P2P 信令适配器派生层 → RFC#派生SignalingAdapter
  - `deriveSignalingAdapter(roomSignaling, localPeerId, remotePeerId)`：返回 `DerivedSignalingAdapter`（扩展 `SignalingAdapter`，含 `__handlers` 内部字段）
  - `send(message)` 委托到 `roomSignaling.sendTo(remotePeerId, { from: localPeerId, signal: message })`
  - `onMessage(callback)` 注册到内部 `__handlers` 数组，返回取消订阅函数
  - `__handlers`：内部字段，**不暴露给外部**，供 Room 收到 `{ type: 'peer-signal', from, signal }` 时直接遍历分发 `signal`
  - `dispatchToAdapter(adapter, signal)` 辅助函数：遍历 `adapter.__handlers` 分发信令消息
- [ ] 2.2 实现 `core/peer-manager.ts`：Peer 连接生命周期管理 → RFC#成员管理 + RFC#Offerer决定规则
  - `createPeerEntry(remotePeerId, options)`：创建单个 peer 的 `PeerEntry`（派生 `SignalingAdapter` + 创建 `RtcController` + 注册事件桥接 + `applyLocalTracks`）
  - 创建 controller 时通过 `RtcControllerInternalOptions` 传入 `__onUserEvent` 钩子：回调签名 `(event: string, payload: unknown) => boolean | undefined`，返回 `true` 表示已消费（不再触发 controller 自身的 on 监听器）；Room 层在钩子内将 payload 包装为 `{ from: remotePeerId, payload }` 后通过 Room 事件系统分发 → RFC#决策记录#7
  - Offerer 决定规则：joiner 始终为 Offerer（`connect()` 主动调用）；已在房间的成员为 Answerer（仅创建 controller 等待 offer，不调用 `connect()`）→ RFC#决策记录#4
  - `bridgeControllerEvents(remotePeerId, controller)`：将 controller 的 8 类内置事件桥接为 Room 级事件（均附加 `peerId` 字段）→ RFC#事件桥接
    - `connected` → `peer-connected: { peerId }`
    - `disconnected: { reason }` → `peer-disconnected: { peerId, reason }`
    - `failed: { error }` → `peer-failed: { peerId, error }`
    - `track: { track, streams }` → `track: { peerId, track, streams }`
    - `track-removed: { track }` → `track-removed: { peerId, track }`
    - `data-channel-ready: { channel, label }` → `data-channel-ready: { peerId, channel, label }`
    - `raw-message: { data, channel }` → `raw-message: { peerId, data, channel }`
    - `error: { error, context }` → `error: { error, context, peerId }`
  - `removePeerEntry(peerId)`：dispose 对应 controller + 从 `peers` Map 移除 + 分发 `member-left: { peerId }` 事件
- [ ] 2.3 实现 `core/media-manager.ts`：本地轨道管理 → RFC#本地轨道管理
  - 内部维护 `localTracks: LocalTrackEntry[]` + `trackIdCounter` 自增计数器
  - `addTrack(track, ...streams)`：守卫 `assertNotDisposed` + `assertJoined`；生成 `trackId = 'local-track-${++trackIdCounter}'`；遍历所有 peer entry，对 `controller.phase === 'connected'` 的调用 `controller.addTrack(track, ...streams)` 并存入 `entry.trackSenders`；返回 trackId → RFC#决策记录#6
  - `removeTrack(trackId)`：守卫 `assertNotDisposed`；从 `localTracks` 移除；遍历所有 peer entry，通过 `trackSenders` 查找对应 `RTCRtpSender` 调用 `controller.removeTrack(sender)` 并清理映射
  - `applyLocalTracks(controller, trackSenders)`：将当前已有的所有本地轨道添加到新创建的 controller（保证后加入的 peer 能收到已有轨道）→ RFC#内部实现要点
- [ ] 2.4 实现 `core/room-state.ts`：房间状态机 → RFC#RoomPhase状态机
  - 合法状态流转：`idle → joining → joined → leaving → left`；`left → idle`（重新 join 时重置）；任意状态可转 `disposed`
  - `setPhase(newPhase)`：更新 phase + `dispatch('room-phase-change', { phase: newPhase, prevPhase: old })`
  - `assertPhase(...allowedPhases)`：当前 phase 不在 allowedPhases 中则 `throwError` 抛 `RoomInvalidStateError`
  - `assertNotDisposed(caller)`：`phase === 'disposed'` 则 `throwError` 抛 `RoomDisposedError`
  - `assertJoined(caller)`：`phase !== 'joined'` 则 `throwError` 抛 `RoomInvalidStateError`
- [ ] 2.5 验收：`__test__/core/signaling-bridge.test.ts` + `__test__/core/peer-manager.browser.test.ts` + `__test__/core/media-manager.test.ts` + `__test__/core/room-state.test.ts` 全通过

## Phase 3 — 房间入口聚合

- [ ] 3.1 实现 `core/room.ts`：聚合所有核心模块，实现 `RtcRoom` 接口 → RFC#API设计 + RFC#内部实现要点
  - **内部状态**：`peers: Map<string, PeerEntry>`（成员映射）、`localTracks: LocalTrackEntry[]`（本地轨道列表）、`unsubscribeRoomSignaling: (() => void) | null`（信令取消订阅）、`cleanupFns: Array<() => void>`（清理函数队列）
  - **`members` getter**：返回 `Array.from(peers.keys())`（只读快照，不含本地成员）
  - **`join()`** → RFC#加入房间流程：
    - 前置守卫：`assertNotDisposed('join')`；若 `phase === 'left'` 则 `setPhase('idle')`（允许重新加入）→ RFC#状态流转（left → idle）
    - 若 `phase !== 'idle'` 则抛 `RoomInvalidStateError`
    - `setPhase('joining')`
    - 通过 `Promise.race` 竞速 `roomSignaling.join(peerId)` 与 `joinTimeout` 超时（超时抛 `RoomTimeoutError`）
    - 获取成员列表失败时回退 `setPhase('idle')` 并 re-throw
    - 注册 `unsubscribeRoomSignaling = roomSignaling.onMessage(handleRoomMessage)`
    - 遍历现有成员：`createPeerEntry` + 作为 Offerer 调用 `controller.connect()`；单 peer 连接失败通过 `.catch` 分发 `peer-failed` 事件 + `logger.warn`（不阻塞整体）→ RFC#决策记录#5
    - `await Promise.allSettled(connectPromises)`
    - `setPhase('joined')`
  - **`handleRoomMessage(message)`** → RFC#房间信令消息路由：
    - `phase === 'disposed'` 时直接 return
    - `member-joined`：跳过自己 + 已有 entry；创建新 entry 作为 Answerer（**不调用 `connect()`**，等待对方 offer）；分发 `member-joined` 事件
    - `member-left`：调用 `removePeerEntry(peerId)`
    - `peer-signal`：查找 `peers.get(message.from)`；**若 entry 不存在**，先 `createPeerEntry(message.from)` + `peers.set` + 分发 `member-joined`（容错：可能在 `member-joined` 消息到达前先收到信令）；然后调用 `dispatchToAdapter(entry.derivedSignaling, message.signal)` 将信令分发到对应的派生适配器 `__handlers`
  - **`leave()`** → RFC#离开房间流程：
    - 幂等语义：`phase` 为 `disposed` / `left` / `idle` 时直接 return（**不抛错**）
    - `setPhase('leaving')`
    - dispose 所有 peer controller + `peers.clear()`
    - 取消房间信令监听（`unsubscribeRoomSignaling()`）
    - 通知房间信令离开 `roomSignaling.leave(peerId)`（fire-and-forget，catch 后 `logger.error`）
    - 清理 `localTracks.length = 0`
    - `setPhase('left')`
  - **`broadcast(event, payload)`**：遍历所有 peer controller，跳过 `phase !== 'connected'` 的 peer（**静默，不抛错**），调用 `controller.emit(event, payload)`
  - **`send(targetPeerId, event, payload)`**：查找目标 peer controller；**不存在或未 connected 时抛 `RoomPeerNotFoundError`**；调用 `controller.emit(event, payload)`
  - **`sendRaw(targetPeerId, data)`**：同 `send` 守卫逻辑；调用 `controller.send(data)`；**目标不存在或未 connected 时抛 `RoomPeerNotFoundError`**
  - **`broadcastRaw(data)`**：同 `broadcast` 静默跳过逻辑；调用 `controller.send(data)`
  - **`addTrack` / `removeTrack`**：委托到 `core/media-manager.ts`
  - **`getRemoteStreams(peerId)`**：查找 peer controller 调用 `controller.getRemoteStreams()`
  - **`getAllRemoteStreams()`**：遍历所有 peer，返回 `ReadonlyMap<string, readonly MediaStream[]>`
  - **`reconnectPeer(peerId)`**：守卫 `assertNotDisposed` + `assertJoined`；查找 peer entry，不存在则抛 `RoomPeerNotFoundError`；调用 `entry.controller.reconnect()` → RFC#RtcRoom接口（"内部调用对应 controller.reconnect()"）
  - **`reconnectAll()`**：守卫 `assertNotDisposed` + `assertJoined`；并行调用所有 `phase !== 'connected'` 的 peer 的 `controller.reconnect()`（`Promise.allSettled`）
  - **`getPeerController(peerId)`**：返回 `peers.get(peerId)?.controller`
  - **`getPeerStates()`**：遍历 peers 返回 `Map<string, RtcPhase>`
  - **`getPeerStats(peerId)`**：查找 peer controller，不存在抛 `RoomPeerNotFoundError`；调用 `controller.getStats()`
  - **dispose**：幂等（首次完整清理：`leave()` + `roomSignaling.dispose?.()` + 清理 `cleanupFns` + `setPhase('disposed')`；第二次起 no-op）
  - **AbortSignal 集成** → RFC#AbortSignal集成：若 `options.signal.aborted` 已 abort 则直接 `setPhase('disposed')`；否则注册 `abort` 监听执行 `leave()` + `setPhase('disposed')`，取消函数存入 `cleanupFns`
- [ ] 3.2 实现 `index.ts`：`createRtcRoom` 公开导出 → RFC#签名
- [ ] 3.3 验收：`__test__/core/room.browser.test.ts`（完整多人连接 join/leave 流程）+ `__test__/index.test.ts`（Node 环境入口层）+ `__test__/index.test-d.ts`（类型契约：泛型推断 / AllRoomEvents 合并 / broadcast 类型安全 / RoomEventPayload 包装）全通过

## Phase 4 — 集成测试与边界场景

> 测试文件路径遵循 RFC#测试策略#测试分层 的规划

- [ ] 4.1 集成测试 `__test__/join-leave.browser.test.ts`：加入/离开完整流程 → RFC#测试分层
  - 两人房间 join → 双方互相 `peer-connected`
  - `leave()` → 对端收到 `member-left` + controller 被 dispose
  - `leave()` 幂等：二次调用不抛错
  - `left` 状态重新 `join()` → 状态重置为 `idle` 再走 `joining → joined` 流程 → RFC#风险（leave后重新join）
- [ ] 4.2 集成测试 `__test__/multi-peer.browser.test.ts`：3+ 人房间完整流程 → RFC#附录B场景1
  - 多人依次加入 → 验证 mesh 连接（每人 N-1 条）
  - 成员离开 → 验证其他成员收到 `member-left` + 对应 controller 销毁
  - 自定义事件 `broadcast` → 验证 `RoomEventPayload` 包装 + `from` 字段正确
  - 自定义事件 `send` → 验证仅目标 peer 收到
- [ ] 4.3 集成测试 `__test__/index.browser.test.ts`：完整房间流程（join → broadcast → leave）→ RFC#测试分层
  - 完整生命周期：`createRtcRoom` → `join` → `broadcast` / `send` / `sendRaw` / `broadcastRaw` → `leave`
  - 媒体轨道：`addTrack` 后所有 peer 收到 `track` 事件；`removeTrack(trackId)` 统一移除；`getRemoteStreams` / `getAllRemoteStreams` 查询
  - 重连：`reconnectPeer` → 调用 `controller.reconnect()` 重建连接；`reconnectAll` → 并行重连所有非 connected peer
- [ ] 4.4 边界场景测试 `__test__/edge-cases.browser.test.ts`：
  - join 超时（`joinTimeout` 触发 `RoomTimeoutError`）
  - 非法状态调用（`idle` 状态下 `broadcast`；`joining` 状态下再次 `join`；`disposed` 后任意调用）
  - AbortSignal 中断 join 流程 → `setPhase('disposed')`
  - AbortSignal 已 aborted 传入 → 直接 `disposed`
  - `send` / `sendRaw` 目标 peer 不存在 → 抛 `RoomPeerNotFoundError`
  - `reconnectPeer` 目标 peer 不存在 → 抛 `RoomPeerNotFoundError`
  - `getPeerStats` 目标 peer 不存在 → 抛 `RoomPeerNotFoundError`
  - `peer-signal` 消息先于 `member-joined` 到达 → 容错创建 entry → RFC#风险（时序竞争）
  - 同时两人加入的 glare 场景（joiner 作为 Offerer 规则避免冲突）→ RFC#风险
  - dispose 幂等：首次完整清理，第二次起 no-op
- [ ] 4.5 验收：`pnpm run test:ci src/shared/rtc-room/__test__/` 全通过

## Phase 5 — 文档与收口

- [ ] 5.1 创建 `index.mdx` 文档 → RFC#附录B使用示例（场景 1-4：多人视频会议、协同编辑、跨标签页房间、断线重连）
- [ ] 5.2 注册导出：在 `src/shared/index.ts` 中导出 `createRtcRoom` 及相关类型（错误子类 + 公开类型）
- [ ] 5.3 `pnpm run check` + `pnpm run build` 全通过
- [ ] 5.4 覆盖率攻坚：`pnpm test:ci src/shared/rtc-room --coverage.enabled` + `pnpm exec esno scripts/analyze-coverage.ts src/shared/rtc-room` → `Files dirty: 0`
- [ ] 5.5 测试时间优化：确认所有涉及超时的测试均使用 `vi.useFakeTimers()`，无真实定时器等待
- [ ] 5.6 创建 `__test__/index.html` 手动测试面板：跨标签页 BroadcastChannel 信令 + 多标签页房间连接 → RFC#附录B场景3
