# rtcRoom 权限控制实施清单

> 基于 RFC.md (0.51.0, draft) 的逐步落地计划
>
> **使用方式**：每完成一项，将 `[ ]` 改为 `[x]`；每个条目末尾的 `→ RFC-xxx#章节` 为对应设计章节的描述，可回子文档查看源头需求

## 前置依赖确认

| 依赖模块 | 状态 | 用途 |
|----------|------|------|
| `@/shared/priority-queue` | ✅ 已就绪 | request 队列（FIFO 入队/出队能力） |
| `@/shared/data-handler` | ✅ 已就绪 | assertDataShape 字段级校验 |
| `@/shared/throw-error` | ✅ 已就绪 | 统一错误抛出 |
| `rtc-room/errors/` | ✅ 已有 5 类 | 需新增 8 类权限错误 |
| `rtc-room/core/` | ✅ 已就绪 | room 核心（通信、组网），权限模块通过 transport 接口对接 |

## 开发守则（Phase 全程生效）

### 测试运行约定 🚨

- **严禁跑全仓库测试** `pnpm run test:ci`（无参数形式）
- 改动哪里只测哪里：`pnpm run test:ci src/shared/rtc-room/__test__/permissions/`
- 涉及定时器的用例（选举梯度延迟、request 超时等）**必须**用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`
- 全仓 `pnpm run test:ci` 仅在 Phase 结束前统一收口时执行

### 错误处理与类型约定

- 报错统一走 `shared/throw-error`（`throwError` / `throwType` / `createError`），**禁止 `throw new Error`**
- 错误子类定义：`constructor(message?: string, options?: ErrorOptions) { super(message, options); this.name = '...'; }`
- 调用 `throwError` 传子类时，需 `RoomXxxError as unknown as ErrorConstructor` 局部类型适配

### 代码风格

- 全量走 Biome：`pnpm run check` 在 Phase 结束前必须零错误
- **严禁 TODO / FIXME 注释**
- 顶级 `export` 统一放文件末尾（`export { xxx }` 形式）
- 跨目录 import 统一使用 `@/shared/...` 别名，**禁止 `../../` 多级相对路径**
- 数组遍历**优先使用索引 `for` 循环**
- 非必要场景优先使用 `||`，仅在严格区分 null/undefined 时保留 `??`

### 测试文件组织

- 测试统一收敛到 `__test__/permissions/` 目录
- 类型测试（`.test-d.ts`）与逻辑测试（`.test.ts`）分离
- PermissionTransport 使用 mock 实现（内存消息路由，不走真实 WebRTC）
- 选举、超时等异步场景必须使用 fake timers

---

## Phase 1 — 类型与错误定义（无运行时依赖）

- [ ] 1.1 创建 `permissions/types.ts`：权限系统所有公开类型 → RFC-core#API设计
  - `RoomSwitches`：`enablePermissions` / `autoDisconnectOnForbiddenBroadcast` / `defaultRoomMute` / `roomMuteAffectsAdmin`
  - `PermissionParameters`：`requestTimeout` / `maxPendingRequests` / `maxCandidates` / `successionDelay` / `nominateTimeout` / `electionTimeout` / `requestIdRetryLimit` / `requestInterceptor`
  - `MuteScope`：`{ channel?: string; event?: string }`
  - `MuteRuleSet`：`{ rules: string[]; exemptions: string[] }`
  - `MuteRegistry`：`{ room: MuteRuleSet; users: Record<string, MuteRuleSet> }`
  - `SerializedMuteRegistry`：serialize 返回类型（与 MuteRegistry 结构相同但为独立浅拷贝） → RFC-sync#serialize
  - `MuteState`：`{ muted; roomRules; roomExemptions; userRules; userExemptions }`
  - `ParsedRule`：`{ channel?: string; event?: string }`
  - `RequestMessage`：`{ type; requestId; action; target; scope?; reason? }`
  - `RequestAck` / `RequestResult`
  - `RoomControlEvent`（联合类型：kick / mute / unmute / host-transfer / admin-add / admin-remove / sync-state）/ `BatchMessage` / `ControlChannelMessage`
  - `HostNominate` / `NominateAck` / `VoteCompare` / `VoteResult`（选举消息）
  - `RequestResultEvent`（discriminated union by success，kick 时 scope 为 undefined）
  - `RoomErrorEvent`（discriminated union by code，9 种错误码）
  - `PermissionTransport` 接口（8 方法 + 1 只读属性）
  - `SyncStatePayload`：buildSyncStatePayload 返回类型（hostId / adminIds / muteRegistry / memberJoinOrder / kickedPeerIds / hostCandidates / voteCount / candidateIndex）
- [ ] 1.2 创建 `permissions/constants.ts`：常量定义 → RFC-core#常量 + RFC-mute#数据结构
  - `MUTE_SEP = '\0'`（组合键分隔符）
  - `CTRL_CHANNEL = '__room_ctrl__'`
  - `DEFAULT_REQUEST_TIMEOUT = 5000`
  - `DEFAULT_MAX_PENDING_REQUESTS = 64`
  - `DEFAULT_SUCCESSION_DELAY = 3000`
  - `DEFAULT_NOMINATE_TIMEOUT = 3000`
  - `DEFAULT_REQUEST_ID_RETRY_LIMIT = 5`
  - `EXCLUDE_CTRL = Symbol('EXCLUDE_CTRL')`
  - `computeDefaultElectionTimeout(candidatesLength, successionDelay, nominateTimeout)` — 默认值公式：`Math.max(candidatesLength * successionDelay + nominateTimeout * 2 + 1000, nominateTimeout * 3)` → RFC-core#PermissionParameters
- [ ] 1.3 新增权限错误类型到 `errors/` → RFC-core#错误类型
  - `RoomPermissionDisabledError`（code: `PERMISSION_DISABLED`）
  - `RoomPermissionDeniedError`（code: `PERMISSION_DENIED`）
  - `RoomMutedError`（code: `MUTED`）
  - `RoomIllegalOperationError`（code: `ILLEGAL_OPERATION`）
  - `RoomForbiddenBroadcastError`（code: `FORBIDDEN_BROADCAST`）
  - `RoomRequestTimeoutError`（code: `REQUEST_TIMEOUT`）
  - `RoomRequestRejectedError`（code: `REQUEST_REJECTED`）
  - `RoomSyncStateInvalidError`（code: `SYNC_STATE_INVALID`）
  - 更新 `errors/index.ts` 导出
- [ ] 1.4 扩展 `types.ts`：向已有 `RtcRoomOptions` 添加 `switches` / `parameters` 字段类型，向 `RoomBuiltinEvents` 追加权限事件类型 → RFC-core#新增事件
- [ ] 1.5 验收：`pnpm run check` + 类型编译通过

## Phase 2 — RoomContext 状态管理

- [ ] 2.1 创建 `permissions/state/context.ts`：RoomContext 权限扩展字段 → RFC-core#RoomContext
  - 源状态字段：`hostId` / `adminIds` / `muteRegistry` / `memberJoinOrder` / `kickedPeerIds` / `hostCandidates`
  - 选举元数据：`electionVoteCount`（初始值 1）/ `electionCandidateIndex`（初始值 -1）/ `electionInProgress` / `pendingPeers`
  - 配置引用：`switches: RoomSwitches`（只读）/ `parameters: PermissionParameters`（只读）— 多处被 checkMute（roomMuteAffectsAdmin）、assertControlPermission（autoDisconnectOnForbiddenBroadcast）、房主协商（defaultRoomMute）等引用
  - `requestQueue`（可选，仅 host 初始化，类型 `PriorityQueue<RequestMessage & { from: string }>`）
  - 派生 getter + 缓存：`isHost`（hostId === localPeerId）/ `hasAdminPermission`（adminIds.includes）/ `ctrlChannelWritable`（adminIds.includes && !checkMute __room_ctrl__，host 永远 true）
  - `invalidateCache()`：清除所有派生状态缓存值（sync-state 处理完成后调用）→ RFC-core#派生状态缓存机制
- [ ] 2.2 创建 `permissions/state/index.ts`：`createPermissionState(transport, switches, parameters)` 工厂函数，返回初始化后的 context 对象
- [ ] 2.3 创建 `permissions/utils/assert-non-null.ts`：`assertNonNull(value, message)` 开发期防御性断言（运行时不应被触发），失败时抛出 `RoomIllegalOperationError` → RFC-core#assertControlPermission 中 request 分支 msg 空值守卫
- [ ] 2.4 编写测试 `__test__/permissions/state.node.test.ts`：getter 派生逻辑（isHost / hasAdminPermission / ctrlChannelWritable）、缓存命中、invalidateCache 后重算、host 免疫 ctrlChannelWritable
- [ ] 2.5 验收：Phase 2 测试通过 + `pnpm run check`

## Phase 3 — 禁言引擎（纯逻辑，无网络依赖）

- [ ] 3.1 创建 `permissions/mute/target-builder.ts` → RFC-mute#数据结构
  - `buildTarget(channel?, event?)` → 组合键字符串
  - `parseRule(rule)` → `ParsedRule`
  - `getRuleGranularity(rule)` → `0 | 1 | 2`
  - `isCtrlChannelRule(rule)` → boolean
- [ ] 3.2 创建 `permissions/mute/rule-matcher.ts` → RFC-mute#checkMute
  - `findHighestGranularityMatch(rules, target)` / `findNarrowestCover`（语义别名）
  - `evaluateRuleSet(ruleSet, target)` → 三态
  - `matchRuleSet(ruleSet, target)` → boolean
  - `hasEffectiveRule(ruleSet)` → 三态
- [ ] 3.3 创建 `permissions/mute/rule-mutator.ts` → RFC-mute#applyMute + applyUnmute
  - `ensureUserRuleSet(users, peerId)` → MuteRuleSet
  - `applyMute(ruleSet, ruleKey)` — 全禁 / 非全禁 两种模式
  - `applyUnmute(ruleSet, ruleKey)` — 精确匹配删除 / 子集豁免 / 不匹配忽略
- [ ] 3.4 创建 `permissions/mute/check-mute.ts` → RFC-mute#checkMute
  - `checkMute(ctx, peerId, channel?, event?)` — host 免疫 / EXCLUDE_CTRL 模式 / `__room_ctrl__` 特殊处理 / 用户层→房间层两级匹配
- [ ] 3.5 创建 `permissions/mute/get-mute-state.ts` → RFC-mute#getMuteState
  - `getMuteState(ctx, targetPeerId)` — 收集 user/room 层规则 + 过滤 `__room_ctrl__` + muted 判断
- [ ] 3.6 编写测试 `__test__/permissions/mute/` → 按子文件拆分
  - `target-builder.node.test.ts`：buildTarget / parseRule / getRuleGranularity 边界
  - `rule-matcher.node.test.ts`：evaluateRuleSet 三态 / matchRuleSet / hasEffectiveRule / 全禁特判
  - `rule-mutator.node.test.ts`：applyMute 全禁/非全禁 / applyUnmute 精确/子集/不匹配 / 级联清除
  - `check-mute.node.test.ts`：host 免疫 / EXCLUDE_CTRL / `__room_ctrl__` 跳过房间层 / roomMuteAffectsAdmin
  - `get-mute-state.node.test.ts`：不存在 peerId 返回空 / host 返回空 / 过滤 ctrl 规则
- [ ] 3.7 创建 `permissions/mute/index.ts`：统一导出
- [ ] 3.8 验收：Phase 3 测试通过 + `pnpm run check`

## Phase 4 — 序列化与 Batch 校验

- [ ] 4.1 创建 `permissions/sync/serialize.ts` → RFC-sync#serialize/deserialize
  - `serialize(muteRegistry)` → 浅拷贝
  - `deserialize(data)` → assertDataShape + 类型断言
  - `assertDataShape(data, context)` — 基于 data-handler 的 dataHandler 逐字段校验
  - `assertRuleSet(value, path)`
  - `assertBatchShape(batch)` — 数组非空 + 末尾为 sync-state
- [ ] 4.2 创建 `permissions/sync/build-payload.ts` → RFC-sync#buildSyncStatePayload
  - `buildSyncStatePayload(ctx, computeHostCandidates)` — 构建 sync-state payload
- [ ] 4.3 编写测试 `__test__/permissions/sync/serialize.node.test.ts`
  - 合法数据 round-trip / 非法结构报错 / 孤立 exemptions 不报错 / assertBatchShape 边界
- [ ] 4.4 验收：Phase 4 测试通过 + `pnpm run check`

## Phase 5 — 权限守卫与前置校验

- [ ] 5.1 创建 `permissions/guards/assert-permissions.ts` → RFC-core#前置开关断言
  - `assertPermissionsEnabled(ctx)`
- [ ] 5.2 创建 `permissions/guards/assert-control-permission.ts` → RFC-core#越权广播检测
  - `assertControlPermission(ctx, from, eventType, msg?)` — 完整校验链路：
    - 空窗期豁免：hostId === '' 时允许选举消息（host-nominate / nominate-ack / vote-compare / vote-result / host-transfer）通过
    - 权限等级判断：host-transfer / admin-add / admin-remove 需 host 权限；其余需 admin 权限
    - `__room_ctrl__` 禁言检测：管理员被禁言该 channel 后拒绝控制消息
    - request 类型走 ack 拒绝路径（非断连）：调用 `assertNonNull(msg)` 防御 + 回复 ack(success=false) + return
    - 非 request 类型越权：dispatch forbidden-broadcast-detected + dispatch error + autoDisconnectOnForbiddenBroadcast 判断是否断连 + throwError
- [ ] 5.3 编写测试 `__test__/permissions/guards.node.test.ts`
  - enablePermissions=false 报错 / 非 admin 越权广播断连 / autoDisconnectOnForbiddenBroadcast=false 不断连 / 空窗期 5 种选举消息豁免 / 空窗期非选举消息仍拦截 / request 分支 ack 拒绝不断连 / `__room_ctrl__` 被禁言后 request 走 ack 拒绝
- [ ] 5.4 验收：Phase 5 测试通过 + `pnpm run check`

## Phase 6 — Request 队列

- [ ] 6.1 创建 `permissions/queue/request-id.ts` → RFC-core#requestId 生成规则
  - `generateRequestId(localPeerId, pendingIds, retryLimit)` — 碰撞重试
- [ ] 6.2 创建 `permissions/queue/admin-queue.ts` → RFC-request-queue#管理员端串行队列
  - 串行发送（前一个 ack 返回或超时后才发下一个）
  - ack 超时处理：dispatch request-timeout + throwError(RoomRequestTimeoutError)
  - ack(success=false) 处理：dispatch error(REQUEST_REJECTED) + throwError(RoomRequestRejectedError)
  - ack(success=true) 后：request 移入 `awaitingResult` 待完结缓冲区，队列流转
  - `awaitingResult: RequestMessage[]`：收到对应 request-result 报文后移除
  - host-changed 自动重发：监听 host-changed 事件，将 awaitingResult 中所有未完结 request **移回发送队列头部**（保持原 requestId），向新房主重发 → RFC-request-queue#host-changed重发
  - admin-removed 内部监听器：检测 target === localPeerId 时自动调用 cancelPendingRequests + 销毁队列 + 清空 awaitingResult → RFC-request-queue#cancelPendingRequests触发时机
  - `cancelPendingRequests()` → `{ cancelled: RequestMessage[], inflight: RequestMessage | null }`
  - `awaitingRequests` 只读属性暴露 awaitingResult
- [ ] 6.3 创建 `permissions/queue/host-queue.ts` → RFC-request-queue#房主端队列
  - FIFO 队列（复用 priority-queue，不使用优先级能力）
  - 容量上限：`maxPendingRequests`（默认 64），超限回复 ack(success=false, error='queue full')
  - 收到 request 后：校验 from 的 ctrlChannelWritable + 队列容量 → 回复 ack → 入队 `{ ...request, from }`（from 字段显式注入）
  - `processNextRequest()` 循环：dequeue → self request 绕过 interceptor（`request.from === localPeerId`）→ requestInterceptor 卡点（超时复用 requestTimeout）→ disposed 守卫（每个 await 返回点后检查）→ validateAndExecute → processNextRequest
  - `destroyRequestQueue()`：`disposed = true` + `requestQueue.clear()`，此后所有 await 返回命中守卫
  - 房主端**不做** requestId 碰撞检测（唯一性由管理员端保证） → RFC-request-queue#房主端队列
- [ ] 6.4 编写测试 `__test__/permissions/queue/`
  - `request-id.node.test.ts`：正常生成 / 碰撞重试 / 超限报错（REQUEST_ID_CONFLICT）
  - `admin-queue.node.test.ts`：串行发送顺序 / ack 驱动流转 / ack 超时 dispatch + throw / ack 拒绝 dispatch + throw / cancelPendingRequests 返回值 / inflight 不可取消 / awaitingResult 收到 result 后移除 / host-changed 重发（移回队列头部 + 保持原 requestId）/ admin-removed 自动销毁
  - `host-queue.node.test.ts`：FIFO 顺序 / 容量上限拒绝 / interceptor 通过 / interceptor 拒绝回复 result / interceptor 超时视为拒绝 / disposed 守卫（interceptor await 期间销毁后静默丢弃）/ self request 绕过 interceptor / from 字段注入
- [ ] 6.5 创建 `permissions/queue/index.ts`：统一导出
- [ ] 6.6 验收：Phase 6 测试通过 + `pnpm run check`

## Phase 7 — 角色管理（房主协商 + 管理员操作 + 候选列表）

- [ ] 7.1 创建 `permissions/roles/host-negotiation.ts` → RFC-roles#房主协商
  - `performHostNegotiation(ctx, existingMembers)` — 首个进房自动成为房主 / defaultRoomMute 初始化
- [ ] 7.2 创建 `permissions/roles/admin-ops.ts` → RFC-roles#管理员操作
  - `addAdmin(ctx, targetPeerId)` — 幂等前置校验 / 广播 batch / dispatch
  - `removeAdmin(ctx, targetPeerId)` — 幂等前置校验 / 不可移除房主
- [ ] 7.3 创建 `permissions/roles/transfer-host.ts` → RFC-roles#transferHost
  - `transferHost(ctx, targetPeerId)` — 原子操作 / 销毁旧队列 / 广播 batch / 新房主 requestQueue 由 sync-state 处理触发
- [ ] 7.4 创建 `permissions/roles/candidates.ts` → RFC-roles#候选列表
  - `computeHostCandidates(ctx)` — 排除条件（`__room_ctrl__` 禁言 + 全禁）/ 管理员优先排序 / maxCandidates 截取
- [ ] 7.5 编写测试 `__test__/permissions/roles/`
  - `host-negotiation.node.test.ts`：首个进房成为房主 / defaultRoomMute 生效
  - `admin-ops.node.test.ts`：幂等添加/移除 / 不可移除房主 / `'*'` 拒绝
  - `transfer-host.node.test.ts`：原子操作 / 旧房主降级 / 队列销毁
  - `candidates.node.test.ts`：排除全禁 / 排除 ctrl 禁言 / 管理员优先 / 截取
- [ ] 7.6 验收：Phase 7 测试通过 + `pnpm run check`

## Phase 8 — 选举机制（投票式选举）

- [ ] 8.1 创建 `permissions/roles/election.ts` → RFC-roles#投票式选举
  - **阶段 1 — 空窗期进入**：
    - 检测 hostId 对应 peer 离开（member-left 触发）→ 所有端进入空窗期
    - `ctx.hostId = ''` / `ctx.electionInProgress = true` / `invalidateCache()`
    - dispatch('host-changed', { prevHost, newHost: '' })
    - 管理请求进入本地缓冲区（不发出）/ `votedFor = null` 初始化
    - 候选者启动梯度延迟：`delay = myIndex * successionDelay`，非候选者等待 host-transfer
    - **选举全局超时计时器**：所有端启动 `electionTimeout` 计时器（默认值由 `computeDefaultElectionTimeout` 计算），超时后若 hostId 仍为空 → 以当前可达成员（PeerConnection 状态 connected）重算候选列表 → 重置选举状态（votedFor / competitor / voteCount / voteLocked / 清除 nominateTimer / voteTimer / compareTimer）→ 新候选列表非空则重启阶段 1 / 仅剩自己则自动当选 / 无人则 performLeave → RFC-roles#全候选者断线
  - **阶段 2 — 自荐与投票收集**：
    - `performNominate()`：guard（votedFor !== null 则 return）→ votedFor = localPeerId → 广播 host-nominate → 初始化 voteCount=1 / voteLocked=false / competitor=null / voterTotal（filter 排除 prevHost + 抹平各端差异）→ 启动 voteTimer（nominateTimeout）
    - 收到 host-nominate：已投票则回复 accept=false，未投票则回复 accept=true + votedFor = candidateId + 清除自身梯度计时器
    - 收到 nominate-ack(accept=true)：voteCount++ → 检查过半（≥ ⌈voterTotal/2⌉）→ 快速当选路径 clearTimeout(voteTimer) + performElected()
    - 收到其他候选者 host-nominate：仅记录第一个 competitor，后续忽略
  - **阶段 3 — 决议（lockVotes）**：
    - 无竞争者 → 不管票数直接当选
    - 有竞争者 → 按 index 决定 A/B 角色：A（index 小，等待 B 发 vote-compare）/ B（index 大，主动发 vote-compare）→ 各自启动比票超时（nominateTimeout）
  - **阶段 3.5 — P2P 比票**：
    - A 收到 vote-compare → 校验总票数 → 比较票数 → 平票则 index 小者胜 → 单播 vote-result → winner 执行 performElected()
    - B 收到 vote-result → winner === self 则 performElected()，否则等待 host-transfer
    - 比票超时（对方断线）→ 直接当选
  - **阶段 4 — performElected() 完整步骤**：
    - a. `ctx.hostId = localPeerId`
    - a2/a3. 记录选举元数据到 ctx（electionVoteCount / electionCandidateIndex）
    - b. `ctx.electionInProgress = false`
    - c. `ctx.adminIds.push(localPeerId)`
    - d. 处理管理员队列 + 初始化房主端 requestQueue（引用 RFC-request-queue 管理员升级流程步骤 1-4，self request 入队但不启动处理循环）
    - e. `memberJoinOrder.filter(id => id !== prevHost)` 移除旧房主
    - e2. `delete muteRegistry.users[prevHost]` 清理旧房主禁言条目
    - f. 处理 pendingPeers：kickedPeerIds 校验 → createCtrlChannel → memberJoinOrder.push（失败跳过等待重连）→ 清空 pendingPeers
    - g. invalidateCache()
    - h. 广播 batch [host-transfer(含 voteCount/candidateIndex), buildSyncStatePayload()]
    - h2. 显式启动 `processNextRequest()` 处理循环（保证步骤 e/h 均完成后才消费队列）
    - i. dispatch('host-changed', { prevHost, newHost: localPeerId })
- [ ] 8.2 创建 `permissions/roles/election-tiebreaker.ts` → RFC-roles#分区恢复仲裁
  - 触发条件：收到 sync-state 且 `payload.hostId !== localPeerId && ctx.isHost === true`（双房主冲突）
  - 仲裁规则（两级确定性比较）：voteCount 大者胜 → 相等时 candidateIndex 小者胜
  - **败者降级完整流程**：
    - a. `ctx.hostId = payload.hostId`
    - b. adminIds 由步骤 d sync-state 覆盖，此处无操作（步骤 a→d 全同步无 await 点 + disposed 守卫覆盖异步路径，中间态不可观测）
    - c. 显式调用 `destroyRequestQueue()`（disposed 守卫，不检查 isHost/hasAdminPermission）
    - d. 接受胜者 sync-state 覆盖源状态
    - e. invalidateCache()
    - f. dispatch('host-changed', { prevHost: localPeerId, newHost: payload.hostId })
  - 胜者处理：忽略对方 sync-state → 向败者单播自己的 sync-state
- [ ] 8.3 编写测试 `__test__/permissions/roles/`（全部使用 fake timers）
  - `election.node.test.ts`：
    - 阶段 1：空窗期进入（hostId 置空 / electionInProgress / 事件 dispatch）/ 非候选者不参与 / 梯度延迟正确性
    - 阶段 2：performNominate guard / 自投 1 票 / 投票收集 / 快速当选（过半立即当选）/ votedFor 阻止重复投票
    - 阶段 3：无竞争者超时直接当选 / 有竞争者进入比票
    - 阶段 3.5：票数不等 / 票数相等 index 小者胜 / 比票超时直接当选
    - 阶段 4：performElected 步骤完整性 / pendingPeers 处理 / createCtrlChannel 失败跳过 / processNextRequest 启动时机
    - 边界：全候选者断线 electionTimeout 重算 / 3+ 竞争者复用分区仲裁 / 单人房间自投即当选 / voterTotal 快照不动态调整
  - `election-tiebreaker.node.test.ts`：
    - 票数不等胜者正确 / 票数相等 index 小者胜 / transferHost candidateIndex=-1 必胜 / 败者降级完整流程 / 败者 requestQueue 销毁 / 胜者向败者单播 sync-state
- [ ] 8.4 验收：Phase 8 测试通过 + `pnpm run check`

## Phase 9 — Kick / Mute / Unmute 操作流程

- [ ] 9.1 创建 `permissions/actions/kick.ts` → RFC-kick#kick流程
  - 前置校验：assertPermissionsEnabled / ctrlChannelWritable / target !== hostId / target !== '*' / 管理员互踢防护（target 在 adminIds 且 localPeerId !== hostId）
  - **房主直接 kick**：
    - memberJoinOrder 移除 target
    - kickedPeerIds.push(target)（广播前更新，防重连绕过）
    - delete muteRegistry.users[target]（清理禁言条目）
    - 广播 batch [kick, sync-state]（含 target，利用 DataChannel reliable+ordered flush 保证送达）
    - dispose target controller + 从 peers 移除
    - dispatch('member-kicked')
  - **管理员 request kick**：入队本地串行队列 → 等待 ack → 最终 result 异步通知
  - **target 收到 kick（target === localPeerId）**：dispatch('kicked') + performLeave()（管理员被 kick 时内部销毁 request 队列 + awaitingResult）
  - **其他端收到 kick（非 target）**：主动断开与 target 的连接 + 移除 target peer entry + dispatch('member-kicked')（源状态由 sync-state 覆盖）
- [ ] 9.2 创建 `permissions/actions/mute.ts` → RFC-mute#mute流程
  - 前置校验：assertPermissionsEnabled / ctrlChannelWritable / target !== hostId（房主不可被禁言）/ target !== '*' 时管理员互禁防护 / `__room_ctrl__` channel 仅房主可禁言
  - **房主直接 mute**：ruleKey = buildTarget(scope) → target === '*' 操作 room 层 / 其他操作 users 层 → applyMute → 广播 batch [mute, sync-state] → dispatch('member-muted') → return（Promise 立即 resolve）
  - **管理员 request mute**：入队 → ack → result 异步通知（resolve 仅表示已接受入队，非最终成功）
  - **非房主端收到 mute 事件**：仅 dispatch（被禁言方 dispatch 'muted'，其他方 dispatch 'member-muted'），不操作 muteRegistry（由 sync-state 覆盖）
- [ ] 9.3 创建 `permissions/actions/unmute.ts` → RFC-mute#unmute流程
  - 前置校验：assertPermissionsEnabled / ctrlChannelWritable / target !== hostId（房主解禁无意义）/ target === localPeerId 且非房主 → 报错（admin 不可自解禁）/ 管理员不可解禁管理员 / `__room_ctrl__` 解禁仅房主
  - **房主直接 unmute**：ruleKey = buildTarget(scope) → target !== '*' 时若 users[target] 不存在则静默返回（不广播不 dispatch）→ applyUnmute → 空条目清理（rules + exemptions 均空则 delete users[target]）→ 广播 batch [unmute, sync-state] → dispatch('member-unmuted') → return（Promise 立即 resolve）
  - **管理员 request unmute**：入队 → ack → result 异步通知；房主端处理时若目标无规则集 → 直接回复 result(success=true) 不广播
  - **非房主端收到 unmute 事件**：仅 dispatch（被解禁方 dispatch 'unmuted'，其他方 dispatch 'member-unmuted'），不操作 muteRegistry（由 sync-state 覆盖）
- [ ] 9.4 编写测试 `__test__/permissions/actions/`
  - `kick.node.test.ts`：房主直接 kick 完整流程 / 管理员 request kick（ack + result）/ 不可踢房主 / 管理员互踢防护 / target === '*' 拒绝 / kickedPeerIds 防重连 / target 收到 kick 执行 performLeave / 其他端收到 kick 断开与 target 连接 / 管理员被 kick 时队列销毁
  - `mute.node.test.ts`：三层粒度（无 scope / channel / channel+event）/ 房主直接 mute / 管理员 request mute / target='*' 全房间禁言 / `__room_ctrl__` 仅房主可禁言 / 管理员互禁防护 / 非房主端仅 dispatch
  - `unmute.node.test.ts`：精确解禁删除规则 / 子集加入豁免 / 无覆盖忽略 / 无规则集跳过广播 / 自解禁防护 / 管理员不可解禁管理员 / 空条目清理 delete users[target] / 非房主端仅 dispatch
- [ ] 9.5 验收：Phase 9 测试通过 + `pnpm run check`

## Phase 10 — Sync-State 处理 + Batch 消息分发

- [ ] 10.1 创建 `permissions/sync/handle-sync-state.ts` → RFC-sync#收到sync-state
  - from 校验：本地 hostId 为空（首次同步）→ 信任 payload.hostId，用 payload.hostId 校验 from；本地 hostId 非空 → 断言 from === ctx.hostId
  - **双房主冲突检测**：`payload.hostId !== localPeerId && ctx.isHost === true` → 交由 election-tiebreaker 仲裁（Phase 8.2），不执行正常覆盖流程
  - 覆盖源状态（不合并，以房主为准）：hostId / adminIds / muteRegistry(deserialize) / memberJoinOrder / kickedPeerIds / hostCandidates / electionVoteCount / electionCandidateIndex
  - invalidateCache()
  - requestQueue 生命周期管理：isHost === true 且无 requestQueue → 初始化；isHost === false 且有 requestQueue → 销毁
  - 空窗期恢复（非房主端）：electionInProgress === true 且 payload.hostId !== '' → electionInProgress = false + pendingPeers = []
- [ ] 10.2 创建 `permissions/sync/handle-batch.ts` → RFC-sync#收到batch
  - **原子性保证**：assertBatchShape + assertDataShape（末尾 sync-state 的 deserialize 校验）前置执行，任一失败整个 batch 丢弃（不处理任何事件），dispatch error 后终止
  - 校验通过后按序处理 events 数组，每个事件先调用 `assertControlPermission(ctx, from, event.type)` 校验发送者权限
  - 各事件类型处理：
    - **kick**：target === localPeerId → dispatch('kicked') + performLeave()；非 target → 断开与 target 连接 + 移除 peer entry + dispatch('member-kicked')
    - **mute**：被禁言方 dispatch('muted')；其他方 dispatch('member-muted')（不操作 muteRegistry）
    - **unmute**：被解禁方 dispatch('unmuted')；其他方 dispatch('member-unmuted')（不操作 muteRegistry）
    - **host-transfer**：非空窗期 → 校验 prevHost === ctx.hostId（不匹配忽略）；空窗期 → 跳过 prevHost 校验（合法性由 assertControlPermission 空窗期豁免保证）→ 临时更新 ctx.hostId = newHost → dispatch('host-changed')
    - **admin-add**：仅 dispatch('admin-added', { peerId: target, from })（源状态由 sync-state 覆盖）
    - **admin-remove**：仅 dispatch('admin-removed', { peerId: target, from })（源状态由 sync-state 覆盖）
    - **sync-state**：交由 handle-sync-state 处理（步骤 10.1）
    - **未知 type**：静默忽略（不 dispatch、不 throwError，兼容版本差异）
- [ ] 10.3 创建 `permissions/sync/handle-member-events.ts` → RFC-sync#成员事件
  - **peer-connected**（所有端执行空窗期检测，仅房主端执行后续步骤）：
    - 空窗期挂起（electionInProgress === true）：先检查 kickedPeerIds → 命中则 disconnect（不加入 pendingPeers）→ 未命中则加入 pendingPeers（不建立 `__room_ctrl__` channel、不加入 memberJoinOrder）
    - 非空窗期（仅房主端）：kickedPeerIds 校验 → 命中则 dispose → 未命中则 memberJoinOrder.push + 单播 batch [sync-state]
  - **peer-reconnected**（仅房主端执行）：kickedPeerIds 校验 → 命中则 dispose → 未命中则单播 batch [sync-state]
  - **member-left**（仅房主端执行，房主离开除外）：
    - 若 leftPeerId === ctx.hostId → 进入选举流程（Phase 8.1 阶段 1），以下步骤不执行
    - memberJoinOrder.filter 移除 leftPeerId
    - adminIds.filter 移除 leftPeerId
    - delete muteRegistry.users[leftPeerId]（清理禁言条目）
    - 清理 requestQueue 中 from === leftPeerId 的残留 request（丢弃不回复 result，对端已断线）
    - invalidateCache() + 广播 batch [sync-state]
- [ ] 10.4 编写测试 `__test__/permissions/sync/`
  - `handle-sync-state.node.test.ts`：覆盖源状态全字段 / 首次同步（hostId 为空信任 payload）/ requestQueue 生命周期（isHost 切换时自动初始化/销毁）/ 空窗期恢复 / 双房主冲突转交仲裁
  - `handle-batch.node.test.ts`：assertBatchShape 失败整个丢弃 / assertDataShape 失败整个丢弃 / 按序处理各事件类型 / 未知 type 静默忽略 / assertControlPermission 越权阻断 / host-transfer 空窗期跳过 prevHost 校验 / host-transfer 非空窗期 prevHost 不匹配忽略
  - `handle-member-events.node.test.ts`：空窗期挂起到 pendingPeers / 空窗期 kick 缓存拦截 / 非空窗期 kick 校验 dispose / memberJoinOrder 维护 / member-left 清理全流程 / member-left requestQueue 残留清理 / 房主离开触发选举入口
- [ ] 10.5 验收：Phase 10 测试通过 + `pnpm run check`

## Phase 11 — 发送拦截 + PermissionController 入口

- [ ] 11.1 创建 `permissions/send-guard.ts` → RFC-mute#发送拦截
  - `checkSendPermission(ctx, channel, event)` — 调用 checkMute(ctx, localPeerId, channel, event)，被禁言时 dispatch error(MUTED, { channel, event }) + throwError(RoomMutedError)
  - 拦截点覆盖：broadcast / send / broadcastTo / sendTo / sendRaw / broadcastRaw，均在发送前调用
- [ ] 11.2 创建 `permissions/index.ts`：`createPermissionController(transport, options)` → RFC-core#模块架构
  - 初始化 permissionState（Phase 2）
  - 注册 transport 事件监听：
    - `onMessage`：解析消息类型 → batch 交由 handle-batch / request 交由 host-queue / request-ack / request-result 交由 admin-queue / 选举消息交由 election
    - `onMemberJoin`：交由 handle-member-events peer-connected
    - `onMemberLeave`：交由 handle-member-events member-left
    - `onMemberReconnect`：交由 handle-member-events peer-reconnected
  - 注册内部事件监听器：admin-removed(target === localPeerId) 自动销毁管理员队列 → RFC-request-queue#cancelPendingRequests触发时机
  - 提供 `dispose()` 方法：清除所有选举计时器（nominateTimer / voteTimer / compareTimer / electionTimer）/ 销毁 admin 队列 + awaitingResult / 销毁 host requestQueue / 注销 transport 事件监听
  - 返回公开 API：
    - 方法：`kick` / `mute` / `unmute` / `getMuteState` / `transferHost` / `addAdmin` / `removeAdmin` / `cancelPendingRequests` / `checkSendPermission` / `dispose`
    - 只读属性：`hostId` / `adminIds` / `isHost` / `hasAdminPermission` / `awaitingRequests`
- [ ] 11.3 编写测试 `__test__/permissions/controller.node.test.ts`
  - enablePermissions=false 时不初始化 / 各 API 正确委托到子模块 / transport onMessage 路由（batch / request / ack / result / 选举消息）/ transport 成员事件路由 / admin-removed 内部监听器自动销毁队列 / dispose 清理所有资源
- [ ] 11.4 验收：Phase 11 测试通过 + `pnpm run check`

## Phase 12 — Transport 适配 + Room 集成

- [ ] 12.1 创建 `core/permission-transport.ts`：实现 `PermissionTransport` 接口 → RFC-core#transport接口
  - `sendTo(peerId, message)`：通过该 peer 的 `__room_ctrl__` DataChannel 发送 JSON 序列化消息
  - `broadcast(message)`：遍历所有已连接 peer，通过各自的 `__room_ctrl__` DataChannel 发送
  - `disconnect(peerId)`：dispose 该 peer 的 PeerController（关闭所有 DataChannel + PeerConnection）+ 从 peers Map 移除（best-effort 语义，底层 ICE 断连失败不影响调用方）
  - `onMessage(handler)`：监听所有 peer 的 `__room_ctrl__` channel message 事件 → JSON 反序列化 → 以 `PeerEntry.peerId`（建连时确定，不可伪造）作为 from 参数调用 handler → 返回取消监听函数
  - `onMemberJoin(handler)` / `onMemberLeave(handler)` / `onMemberReconnect(handler)`：桥接 room core 对应事件到 handler → 返回取消监听函数
  - `createCtrlChannel(peerId)`：调用 `RTCPeerConnection.createDataChannel('__room_ctrl__')` 为指定 peer 建立 DataChannel（调用方为 initiator 端，对端通过 'datachannel' 事件接收）
  - `readonly localPeerId: string`：从 room core 获取本地 peerId
- [ ] 12.2 修改 `core/room.ts`：集成权限模块 → RFC-core#模块架构
  - `enablePermissions=true` 时：
    - performJoin 完成后建立 `__room_ctrl__` DataChannel（所有用户均建立，默认只读）
    - 初始化 `createPermissionController(transport, { switches, parameters })`
    - 调用 `performHostNegotiation(ctx, existingMembers)` 完成房主协商
  - `send()` / `broadcast()` / `sendTo()` / `broadcastTo()` / `sendRaw()` / `broadcastRaw()` 前调用 `permissionController.checkSendPermission(channelLabel, eventName)` 守卫（`__room_ctrl__` channel 的消息由 transport 内部发送，不经过业务侧 send/broadcast，因此不会被误拦截）
  - 公开权限 API 透传到 RtcRoom 接口：
    - 方法：`kick` / `mute` / `unmute` / `getMuteState` / `transferHost` / `addAdmin` / `removeAdmin` / `cancelPendingRequests`
    - 只读属性：`hostId` / `adminIds` / `isHost` / `hasAdminPermission` / `awaitingRequests`
  - `enablePermissions=false` 时：
    - 不建立 `__room_ctrl__` channel，不初始化权限模块（tree-shaking 友好）
    - 权限属性返回 undefined / 空数组
    - 权限方法调用时直接 throwError(RoomPermissionDisabledError)
    - 若意外收到 `__room_ctrl__` channel 消息则静默忽略 → RFC-core#边界行为
  - performLeave 内部调用 `permissionController.dispose()` 清理权限模块全部资源 → RFC-core#performLeave
- [ ] 12.3 创建测试辅助 `__test__/helpers/mock-permission-transport.ts`
  - 内存版 PermissionTransport mock：
    - 维护 peer 列表 + 各 peer 的 message handler
    - sendTo / broadcast：JSON 序列化 + 路由到目标 peer handler（注入 from）
    - disconnect：从 peer 列表移除
    - onMessage / onMemberJoin / onMemberLeave / onMemberReconnect：注册/注销回调
    - createCtrlChannel：记录已建立 channel 的 peerId
    - 辅助方法：`simulateMessage(from, message)` / `simulateMemberJoin(peerId)` / `simulateMemberLeave(peerId)` / `simulateReconnect(peerId)`
- [ ] 12.4 编写集成测试 `__test__/permissions/integration.node.test.ts`
  - 完整房间生命周期：创建 → 加入（房主协商）→ 管理员指派 → 禁言（三层粒度）→ 发送拦截验证 → 解禁 → 踢人 → kick 缓存防重连 → 房主离开触发选举 → 新房主当选 → 房主转让 → 离开
  - 多人房间场景（3-5 peer mock）：管理员 request 流程（ack + result 两阶段）
  - enablePermissions=false 时权限 API 抛错
  - 空窗期新成员挂起 + 选举完成后恢复
- [ ] 12.5 验收：Phase 12 测试通过 + `pnpm run check` + `pnpm run build`

## Phase 13 — 最终验收

- [ ] 13.1 全量回归测试
  - `pnpm run test:ci src/shared/rtc-room/`（含已有 core 测试 + 新增 permissions 全部测试）
  - `pnpm run check`（Biome lint 零错误）
  - `pnpm run build`（构建成功）
- [ ] 13.2 验收：全部通过，无 lint 错误，构建成功
