# RFC: rtcRoom 权限控制 — Kick / Host / Admin / Mute

> status: draft
>
> author: cmtlyt
>
> create time: 2026/05/18 10:47:00
>
> rfc version: 0.51.0
>
> scope: `src/shared/rtc-room`

## 概述

本 RFC 定义了 `rtc-room` 的权限控制系统，包括踢人（Kick）、房主（Host）、管理员（Admin）、禁言（Mute）四大能力。权限变更通过独立的房间管理 channel（`__room_ctrl__`）广播同步，接收方以断言模式校验发送者身份合法性。

## 模块索引

本 RFC 已按模块拆分为以下子文档。**各子文档的版本和状态由本文件统一管理**，子文档内不再独立维护。

| 子文档 | status | 内容 |
|--------|--------|------|
| [RFC-core.md](./RFC-core.md) | draft | **核心架构与配置** — 模块架构、transport 接口、配置项（RoomSwitches / PermissionParameters）、API 签名、事件定义、错误类型、传输通道（`__room_ctrl__`）、控制消息类型、越权广播检测、performLeave、RoomContext、边界行为、设计决策总表 |
| [RFC-roles.md](./RFC-roles.md) | draft | **角色管理** — 房主协商（组网自动产生）、管理员指派/移除（addAdmin / removeAdmin）、房主转让（transferHost）、候选列表生成（computeHostCandidates）、房主离开自动继位（竞赛式）、tiebreaker 规则、管理员升级为房主流程 |
| [RFC-mute.md](./RFC-mute.md) | draft | **禁言系统** — 三层禁言粒度、禁言数据结构（组合键两层策略）、mute/unmute 流程、checkMute 匹配逻辑（evaluateRuleSet 三态 / matchRuleSet 二态）、getMuteState 查询、发送拦截、全房间禁言与绕过策略交互 |
| [RFC-kick.md](./RFC-kick.md) | draft | **Kick 流程** — 房主直接 kick、管理员 request kick（两阶段）、kick 缓存防重连（kickedPeerIds） |
| [RFC-sync.md](./RFC-sync.md) | draft | **状态同步** — batch 合并广播格式、buildSyncStatePayload、sync-state 处理逻辑、memberJoinOrder 维护、serialize/deserialize 数据校验、后续版本规划 |
| [RFC-request-queue.md](./RFC-request-queue.md) | draft | **Request 队列** — 管理员端串行队列、房主端 FIFO 队列、ack + result 两阶段、待完结缓冲区（awaitingResult）、cancelPendingRequests、host-changed 自动重发 |

### 归档文档

历史方案已移至 `archive/` 目录：

| 文档 | 说明 |
|--------|------|
| [archive/RFC-mute-strategy.md](./archive/RFC-mute-strategy.md) | 禁言旧方案（MuteEntry 结构体），已被 RFC-mute.md 组合键方案替代 |
| [archive/RFC-mute-refactor.md](./archive/RFC-mute-refactor.md) | 组合键方案独立 RFC（已合入 RFC-mute.md） |
| [archive/RFC-succession.md](./archive/RFC-succession.md) | 竞赛式继位（已废弃），后续演化为投票式选举（[archive/RFC-election.md](./archive/RFC-election.md)），最终合入 RFC-roles.md |
| [archive/RFC-election.md](./archive/RFC-election.md) | 投票式选举独立 RFC（已合入 RFC-roles.md） |

## 版本历史

<details>
<summary>早期版本（0.1.0 — 0.28.0）</summary>

| 版本 | 日期 | 变更摘要 |
|------|------|----------|
| 0.1.0 | 2026/05/18 | 初稿 |
| 0.2.0 | 2026/05/18 | RTC 传输、房主 ID 化、违法广播检测、管理员角色、接收方丢弃、状态同步 |
| 0.3.0 | 2026/05/18 | 控制开关聚合、三层禁言粒度、断言式违法检测、房主冗余入 adminIds、继承优先级、状态同步由房主发出、管理员互操作限制 |
| 0.4.0 | 2026/05/18 | 房主由组网协商产生（首个进房）、配置改为行为开关、isHost 改 getter、全房间禁言、host 免疫、admin 无法自解禁 |
| 0.5.0 | 2026/05/18 | switches 通用化（非仅权限）、默认房间禁言开关、memberJoinOrder 改 Set、禁言约束权限管理行为 |
| 0.6.0 | 2026/05/18 | 明确转让后旧房主为普通用户、状态变更均触发全量同步、默认 channel 禁言阻断管理操作、kick 同步清理 memberJoinOrder |
| 0.7.0 | 2026/05/18 | 权限管理抽离为独立内部 channel、enablePermissions 显式开关（默认 false）、权限 channel 仅对房主/管理员可见 |
| 0.8.0 | 2026/05/18 | 房间管理 channel 语义修正（所有用户建立、默认只读、管理员可写）、前置开关断言、管理员无 ctrl channel 禁言权、channel 禁言仅影响写权限 |
| 0.9.0 | 2026/05/18 | 管理操作改为请求→房主合并广播、ctrlChannelWritable 等可计算状态改 getter+缓存、禁言约束改为 ctrlChannelWritable 判断、非房主端不操作源状态（统一由 sync-state 覆盖） |
| 0.10.0 | 2026/05/18 | request ack 机制、`__room_ctrl__` 免通配匹配、错误类型定义、error dispatch 原则、getMuteState host 免疫、时序图、竞态安全性说明 |
| 0.11.0 | 2026/05/18 | requestTimeout 配置（默认 5s）、断线重连同步、from 身份校验明确、transferHost 禁言立即生效、管理员串行 request 队列、房间关闭语义、全房间禁言统一用 `*`、移除 `__default__` channel、roomMuteAffectsAdmin 开关、Admin 收 batch 显式说明、压缩/冗余后续版本规划 |
| 0.12.0 | 2026/05/19 | ctrlChannelWritable 语义与免通配自洽、kick 先送达再 dispose、host-transfer 临时更新 hostId 解决 sync-state 校验、request-ack 校验后立即回复、transferHost 原子操作、mute('*') 显式 API、error 事件 payload 统一、__room_ctrl__ 可靠有序模式、sync-state 增量同步移入后续规划 |
| 0.13.0 | 2026/05/19 | kick 改先单播 target 再广播剩余端、cancelPendingRequests API、继位竞态有序性说明、禁言传播延迟说明、error 事件仅本地说明、mute target union type、deserialize 类型校验、batch sync-state 顺序强约束、requestId 8 位随机串、超时 ack 忽略说明、performLeave 免禁言检测 |
| 0.14.0 | 2026/05/19 | deserialize 统一断言方法 assertDataShape、管理员单向管理链（host→admin→user）强化、房主端 FIFO requestQueue（引入优先级队列）、request 流程改为 ack+result 两阶段（ack 表示已收到、result 表示执行结果）、requestInterceptor 外部卡点配置 |
| 0.15.0 | 2026/05/19 | unmute 补充 target===hostId 校验、kick 单播等待 flush 再 dispose、RequestMessage 移除 by 字段统一用 from、cancelPendingRequests 返回 RequestMessage[]、getMuteState 对不存在 peerId 报错、batch 运行时断言 sync-state 末尾、requestId 拼接 peerId 隔离命名空间+碰撞重试、队列仅复用队列能力无优先级、transferHost 补充 requestQueue 初始化/销毁 |
| 0.16.0 | 2026/05/19 | kick 改用 kick-ack 确认送达（移除 bufferedAmount 等待）、maxPendingRequests 配置（默认 64，超限回复 queue full）、transferHost 原子操作步骤 e 移至 sync-state 处理说明、cancelPendingRequests 返回 `{ cancelled, inflight }`、getMuteState 过滤 `__room_ctrl__` 条目（永不对外暴露）、单条 sync-state 也用 batch 包装说明、requestId 碰撞重试上限 3 次超出报错、error context 定义为 union type 枚举、时序图 request payload 修正 |
| 0.17.0 | 2026/05/19 | 可交互参数聚合到 `PermissionParameters` 子对象、request 流程简化为 ack 即完成、unmute('\*', { channel }) 支持部分解禁、设计决策表按主题分组、defaultRoomMute 生效时机说明 |
| 0.18.0 | 2026/05/19 | kick-ack 超时断开所有连接、继位脑裂重连 sync-state 覆盖、forbidden-broadcast 命名、unmute 已知 channel 定义+ignore 方案、getMuteState 返回空状态、cancelPendingRequests 场景补充、defaultRoomMute 时序图、error detail 联合类型、performLeave 集中描述、kick 时序图顺序修正、requestId 约束放宽 |
| 0.19.0 | 2026/05/19 | request 流程改为 ack+result 两阶段（result 报文通知最终执行结果）、host 处理 self request 绕过 requestInterceptor 和前置校验、kick 缓存防重连（kickedPeerIds）、assertDataShape 基于 data-handler 实现、unmute 白名单语义修正为绕过策略（重新 mute 移出白名单、重新 mute(*) 清空白名单）、error 事件改为按 code 做 discriminated union（RoomErrorEvent）、新增 request-fulfilled/request-rejected 事件 |
| 0.20.0 | 2026/05/20 | request-fulfilled/request-rejected 合并为 request-result（success 字段区分）、error 示例改用 Error.code 匹配、房间信息字段全部改用 JSON 兼容类型（Array/Record 替代 Set/Map）、serialize/deserialize 简化为校验+浅拷贝、明确使用 data-handler 的 dataHandler API 进行字段级校验 |
| 0.21.0 | 2026/05/20 | 房主选举策略重构：竞赛式继位（候选列表 hostCandidates + 梯度延迟竞选 + tiebreaker），替换原确定性算法；新增 maxCandidates / successionDelay 配置；房主空窗期管理请求本地挂起；候选列表排除被禁言 __room_ctrl__ 的用户 |
| 0.22.0 | 2026/05/20 | 模块架构决策：权限系统作为 rtc-room 子模块独立实现（`permissions/`），通过 PermissionTransport 接口与 core 解耦；新增设计决策「模块架构」分组 |
| 0.23.0 | 2026/05/20 | 管理员端待完结缓冲区（awaitingResult）+ host-changed 自动重发、tiebreaker 时序合法性校验（断连时长 vs 下标延迟，不合法走越权广播）、RoomControlEvent 直接引用 RequestResult、PermissionTransport 补充 onMemberReconnect、errors 目录明确放在 room 级别、时序图标注 Others 含 Admin、successionDelay 保守策略说明 |
| 0.24.0 | 2026/05/21 | tiebreaker 优先级比较分支明确计时器已不存在、ControlChannelMessage 聚合类型+广播/单播注释、管理员升级为房主完整流程集中描述、unmute bypass/真正解禁语义注释、memberJoinOrder 去重校验、onMemberReconnect 精确触发条件、新增 RoomSyncStateInvalidError、kick 流程 kickedPeerIds 更新时机注释 |
| 0.25.0 | 2026/05/21 | kick 流程简化为广播通知（移除 kick-ack）、竞赛式继位引入 timestamp/elapsedSinceDisconnect + 败者保持原状 + 空窗期缓冲区、tiebreaker 改用 timestamp 比较、self request 按新角色权限校验、addAdmin/removeAdmin 幂等前置校验、requestId 碰撞重试上限（REQUEST_ID_CONFLICT）、unmute allMuted+channel+event 组合 bypass（ignoredEvents 白名单）、requestQueue 去 readonly、MuteEntry/MuteState 新增 ignoredEvents 字段、PermissionParameters 新增 requestIdRetryLimit 配置、deserialize 补充 ignoredEvents 校验、getMuteState 返回白名单豁免项 |
| 0.26.0 | 2026/05/21 | getMuteState 用户级优先级说明（高细粒度=高优先级）、ControlChannelMessage 拆分 RequestResult 为独立单播类型（RoomControlEvent 仅含广播事件）、补充时序图（kick 直接/request 两阶段、竞赛式继位）、新增 performLeave 独立小节集中描述、defaultRoomMute 生效时机补充（房间从零创建时均生效） |
| 0.27.0 | 2026/05/22 | 禁言模型重构：MuteEntry 结构体替换为组合键两层策略（MuteRuleSet + MuteRegistry { room, users }），checkMute 从 4 层 if-else 简化为 evaluateRuleSet（三态）/ matchRuleSet（二态）前缀匹配，MuteState 返回 ParsedRule 结构（roomRules/roomExemptions/userRules/userExemptions），serialize/deserialize 简化为 assertRuleSet 校验，分隔符 \0 |
| 0.28.0 | 2026/05/22 | evaluateRuleSet 改为禁言/豁免同级匹配+细粒度优先级比较（matchRuleSet 复用 evaluateRuleSet）、tiebreaker 改用 elapsedSinceDisconnect 比较（纯本地时钟无偏移）、空窗期 assertControlPermission 豁免 host-transfer、getMuteState.muted 改为有效规则数判断、设计决策表补充 request 执行时刻权限声明、awaitingResult 改为 readonly 属性暴露、deserialize 错误码改为 SYNC_STATE_INVALID、移除冗余注释、TS 技巧说明移至附录 |

</details>

<details>
<summary>中期版本（0.29.0 — 0.43.0）</summary>

| 版本 | 日期 | 变更摘要 |
|------|------|----------|
| 0.29.0 | 2026/05/26 | assertControlPermission 增加 `__room_ctrl__` 禁言校验（防止被禁言管理员绕过本地拦截发送控制消息）、mute/unmute 返回类型统一为 `Promise<void>`（与 kick 一致，房主立即 resolve、管理员 ack 后 resolve）、host-transfer 消息 voteCount/candidateIndex 补充 JSDoc 说明两种场景语义、electionVoteCount/electionCandidateIndex 补充初始值说明、全禁语义补充"赋值覆盖清除已有细粒度规则"说明、后续版本规划补充 exemptions 增长控制 |
| 0.30.0 | 2026/05/26 | mute/unmute 伪代码标注 async function、管理员升级为房主补充执行顺序（先收集+销毁队列再 dispatch host-changed，防止重发竞争）、assertControlPermission 移除冗余 `from !== ctx.hostId`（checkMute 入口已有 host 免疫）、voterTotal 快照显式说明计算基础、全禁数据丢失语义警告、后续版本规划补充 kickedPeerIds 容量控制、RFC-roles/RFC-mute 设计决策表去重（引用 RFC-core）、RequestResult.scope JSDoc 补充 kick 场景、archive 引用路径一致性修正、electionCandidateIndex 注释补充 -1 两种含义的区分方式 |
| 0.31.0 | 2026/05/26 | getMuteState.muted 修复——EXCLUDE_CTRL 模式从前缀匹配改为 hasEffectiveRule 遍历判断（解决 channel/event 级禁言无法被检测的问题）、requestQueue 销毁增加 disposed 异步守卫（防止 requestInterceptor 异步返回后操作已销毁状态）、assertControlPermission 对 request 类型消息走 ack 拒绝路径而非断连（解决管理员因网络延迟被误判越权断连的竞态）、mute/unmute JSDoc 强调管理员 resolve 仅表示已接受入队非最终结果、ControlChannelMessage 联合类型补充 BatchMessage |
| 0.32.0 | 2026/05/26 | unmute 豁免逻辑重构（applyUnmute：先判断 ruleKey 是否被已有禁言规则覆盖——相等则直接删除规则、子集则加入豁免、不匹配则忽略）、hasEffectiveRule 简化为 rules 非空即有效（与 applyUnmute 精确删除语义一致）、挂起 peer 不建立 `__room_ctrl__` channel（无法参与选举投票和控制消息收发）、transferHost 补充 target===localPeerId 前置校验、mute/unmute 房主端伪代码补充 return 说明（无 await 点，Promise 立即 resolve）、版本历史移除"评审修复"前缀 |
| 0.33.0 | 2026/05/26 | 补充 applyMute 伪代码定义（全禁赋值覆盖 + 非全禁追加去重 + 清除被覆盖的豁免条目）、移除 RFC-roles.md 重复的 ControlChannelMessage 定义（改为引用 RFC-core.md）、断线重连章节补充非房主端守卫说明（`if (!ctx.isHost) return`）、比票 voterTotal 偏差显式说明（A 使用自己快照，不影响确定性结果）、applyUnmute 子集分支补充冗余豁免说明、requestInterceptor JSDoc 补充超时复用提示、assertRuleSet 补充孤立 exemptions 防御性说明 |
| 0.34.0 | 2026/05/26 | 全禁语义重构：applyMute 全禁改为追加 `'\0'` + 清空 exemptions 但保留已有细粒度 rules（全禁作为开关，不丢失已有规则）；unmute 不传 scope 改为走 applyUnmute 精确删除 `'\0'`（保留其他细粒度 rules），与 mute 的开关语义对称 |
| 0.35.0 | 2026/05/27 | 评审修正：全禁警告文案与 applyMute v0.34.0 语义对齐（保留 rules、仅清空 exemptions）、unmute('*') 交互示例修正为精确删除语义、EXCLUDE_CTRL 模式 hasEffectiveRule 返回 exempt 不再短路房间层（孤立豁免穿透）、computeHostCandidates checkMute 参数补充注释、voterTotal 注释精简为表格、performElected 步骤 e 改为引用 RFC-request-queue.md、RFC-core.md 队列决策表去重（引用子文档）、electionCandidateIndex -1 注释简化、PermissionTransport.disconnect 补充 best-effort 语义、assertBatchShape 可选链改为 Array.isArray 防御性检查 |
| 0.36.0 | 2026/05/27 | 评审修正：assertControlPermission 补充 msg? 可选参数（request 分支需引用 msg.requestId）、performElected 合并重复的 requestQueue 初始化（原 d+e 合并为 d 引用 RFC-request-queue.md 步骤 1-4）、performElected 步骤编号连续化（d→e→e2→f→g→h→i）、RFC-roles.md「管理员升级为房主」重复章节改为引用 RFC-request-queue.md、房主协商 ctrlChannelWritable 直接赋值改为注释说明（getter 派生语义一致）、addAdmin/removeAdmin 伪代码 dispatch 和广播中变量引用修正（peerId→targetPeerId、target→targetPeerId） |
| 0.37.0 | 2026/05/27 | 评审修正：新增 electionTimeout 配置（全候选者断线兜底，超时后重算候选列表重启选举）、EXCLUDE_CTRL 模式管理员免疫路径注释补充（'exempt' 穿透到 return false 的预期行为说明）、performElected 步骤 d/e 边界注释（self request target===prevHost 校验失败预期行为）、败者降级步骤 b 注释简化（无操作，由 sync-state 覆盖）、findHighestGranularityMatch 性能说明（O(n) P2P 场景可接受）、host-changed 重发时序保证注释（dispatch 在广播之后，新房主已完成 requestQueue 初始化） |
| 0.38.0 | 2026/05/27 | 评审修正：PermissionTransport 补充 createCtrlChannel 方法定义（空窗期挂起 peer 恢复用）、disconnect JSDoc 补充与 dispose 的关系说明（等价关系）、RFC-request-queue.md 补充重发幂等性保证说明（各操作前置校验/去重逻辑天然保证）、cancelPendingRequests 补充 inflight 生命周期说明（cancel 仅影响排队项不影响已发出请求）、electionTimeout 重算补充各端独立计算一致性说明（投票机制保证最终收敛）、checkMute 补充空窗期行为注释（hostId='' 时不存在免疫者） |
| 0.39.0 | 2026/05/27 | 评审修正：findHighestGranularityMatch 全禁标记特殊处理（JS 中 `startsWith('\0')` 无法匹配非 `\0` 开头字符串，增加 `rule === MUTE_SEP` 显式判断）、performElected 补充 ctx.electionVoteCount/electionCandidateIndex 赋值（修复选举元数据未持久化到 ctx 的遗漏）、performElected 步骤 h 的 voteCount/myIndex 来源注释（闭包持有）、assertControlPermission msg 参数补充使用约束注释（仅 request 分支必传）、getMuteState 不存在 peerId 返回空状态的设计选择注释（v0.15.0 行为变更说明）、performNominate 自荐时设 `votedFor = localPeerId`（修复自荐者收到他人 nominate 后误投的 bug） |
| 0.40.0 | 2026/05/27 | 评审修正：assertControlPermission request 分支增加 msg 空值守卫（防御性 throwError）、computeHostCandidates 补充全禁用户排除逻辑（`!checkMute(ctx, peerId)` 全禁也应排除出候选列表）、hasEffectiveRule 三态返回值补充保留理由注释（为未来扩展预留）、kickedPeerIds 补充非房主端作为状态备份的说明、electionTimeout 补充各端偏差不影响正确性的注释、RFC-sync.md member-left 补充房主离开交叉引用（→ RFC-roles.md 选举流程）、版本历史表折叠旧版本（0.1.0—0.28.0） |
| 0.41.0 | 2026/05/27 | 评审修正：computeHostCandidates 注释条件 2 标题修正为"被全禁（用户级或房间级）"消除歧义、transferHost 步骤 3d 补充引用 destroyRequestQueue 流程（disposed 守卫）、electionTimeout 默认值公式增加 +1000 网络延迟余量、requestQueue 类型补充 from 字段注入说明注释、unmute 对无规则用户补充幂等语义注释、RFC-sync.md 设计决策表去重（与 RFC-core.md 重复项改为引用）、后续版本规划补充 awaitingResult TTL 和 sync-state payload 大小预估 |
| 0.42.0 | 2026/05/28 | 评审修正：performElected 步骤 e 补充注释（确保 computeHostCandidates 不含 prevHost）、electionTimeout 重算补充完整选举状态重置列表（votedFor/competitor/voteCount/voteLocked/计时器）、unmute 不存在用户规则集时跳过广播直接返回（房主直接执行和 request 路径均一致）、successionDelay 设计决策表补充小房间调低建议、PermissionTransport 方法数修正为 8 个方法 + 1 只读属性 |
| 0.43.0 | 2026/05/28 | 评审修正：applyUnmute find 逻辑修复（`ruleKey.startsWith(rule)` 对全禁标记无效，补充 `rule === MUTE_SEP` 显式判断，与 findHighestGranularityMatch 一致）、applyUnmute 删除全禁标记时级联清除逻辑修复（startsWith 无法匹配子级条目，改为全禁标记特殊处理直接清空 exemptions）、交互示例中 `unmute('*')` 描述修正（删除"以 '\0' 为前缀的条目"错误表述）、computeHostCandidates 条件 2 补充 channel/event 级禁言不影响候选资格的说明、选举全局超时重算 votedFor 重置补充已投给断线候选者的票自然失效注释、RequestResultEvent 补充 scope 在 kick 时为 undefined 注释、PermissionTransport.createCtrlChannel 补充 DataChannel initiator 方向说明 |

</details>

| 版本 | 日期 | 变更摘要 |
|------|------|----------|
| 0.44.0 | 2026/05/29 | 评审修正：applyUnmute find 优先精确匹配再走前缀/全禁匹配（修复全禁+细粒度规则共存时 unmute 细粒度规则误入子集分支的问题）、computeHostCandidates 补充管理员用户级全禁排除候选资格的设计意图注释（管理能力与候选资格分离）、performElected 步骤 d 注释修正（明确 self request 是延迟处理，执行时步骤 e 已完成）、awaitingResult 补充 ⚠️ 内存泄漏风险警告（requestInterceptor Promise 永不 settle 场景）、electionTimeout 默认值公式增加 Math.max 最小值下限（防止 hostCandidates 为空时过早触发重算）、空窗期挂起前增加 kickedPeerIds 校验（非房主端也可提前拦截被踢用户，减少安全窗口）、assertBatchShape 补充 batch 本身的 null/undefined 防御、successionDelay JSDoc 补充小房间建议值、版本历史归档 v0.29.0—v0.43.0 |
| 0.45.0 | 2026/05/29 | 评审修正：applyUnmute 子集/全禁匹配从 `find` 改为 `findNarrowestCover`（语义精确化——查找覆盖 ruleKey 的最细粒度规则，避免依赖数组顺序）、performNominate guard 注释修正为"已参与投票（含自投）"（原注释"已投票给他人"不准确，votedFor 也可能是 localPeerId）、版本历史归档 details 样式统一（v0.29.0—v0.43.0 折叠标题格式与 v0.1.0—v0.28.0 对齐） |
| 0.46.0 | 2026/05/29 | 评审修正：`findLowestGranularityCover` 重命名为 `findNarrowestCover`（修复函数名与实现矛盾——实现取最细粒度覆盖者，但 "Lowest" 暗示最粗粒度，改为 "Narrowest" 语义一致）、归档表 RFC-succession.md 描述补充中间步骤引用路径（succession → election → RFC-roles.md）、RFC-roles.md 选举配置项定义改为引用 RFC-core.md（消除重复定义） |
| 0.47.0 | 2026/05/29 | 评审修正：删除 `findLowestGranularityCover` 残留旧定义（v0.46.0 重命名后遗漏）、修复 `findNarrowestCover` 伪代码中 `target` 变量名笔误为 `ruleKey`、补充 `findHighestGranularityMatch` 伪代码定义（evaluateRuleSet 依赖但缺失定义）、transferHost voteCount 注释补充含房主自身说明（明确 ≥ voterTotal + 1）、performElected 步骤 f `createCtrlChannel` 补充异常处理（失败时跳过该 peer 等待重连）、`assertNonNull` 补充开发期断言注释（抛出 RoomIllegalOperationError）、voterTotal 注释补充 filter 用于抹平各端 memberJoinOrder 差异的说明、member-left 流程补充房主端清理 requestQueue 中离开用户残留 request 的步骤、归档表 RFC-succession.md 描述格式统一、`findNarrowestCover` 注释去重精简 |
| 0.48.0 | 2026/06/01 | 评审修正：`findNarrowestCover` 注释修正——"匹配方向相反"改为"匹配逻辑相同，使用场景不同"（两者均为 `输入.startsWith(rule)`，区别在于调用语境）、`findNarrowestCover` JSDoc 补充缺失的 `/**` 开头标记、管理员升级为房主步骤 4 补充 `from = localPeerId` 等价于房主身份的注释（`ctx.hostId === localPeerId` 已成立）、败者降级步骤 c 改为显式调用 `destroyRequestQueue()`（避免与步骤 d sync-state 处理的自动检测产生时序依赖）、voterTotal 注释补充空窗期之前已在 memberJoinOrder 中的断线成员仍计入的说明、选举全局超时重算"可达成员"定义明确为"本地 PeerConnection 状态为 connected 的 peer"、归档表 RFC-succession.md 描述修正为方案演进时间线表述、unmute 重发幂等性补充子集场景说明（ruleKey 被更粗粒度规则覆盖时产生幂等 exemption 条目） |
| 0.49.0 | 2026/06/01 | 评审修正：`processNextRequest` 伪代码补充 self request 绕过 `requestInterceptor` 的分支（`request.from === localPeerId` 时跳过 interceptor 直接进入校验执行）、`findNarrowestCover` 注释明确声明实现时应为 `findHighestGranularityMatch` 的语义别名（避免维护两份相同实现）、RFC-mute.md 归档文档引用措辞从"详见"改为"历史背景参考"（已合入当前文档的归档不应暗示需要去读） |
| 0.50.0 | 2026/06/01 | 评审修正：败者降级步骤 c 补充 disposed 守卫约束声明（仅检查 disposed 标记，不检查 ctx.isHost/hasAdminPermission，消除步骤 a→d 窗口的状态依赖隐患）、performElected 新增步骤 h2 显式启动 processNextRequest（保证 memberJoinOrder 清理和广播均在队列消费之前完成）、RFC-request-queue.md 管理员升级步骤 4 补充 processNextRequest 启动时机说明、重发幂等性措辞修正为"最终一致性"（区分旧房主已广播/未广播/未执行三种场景，精确描述幂等与首次执行的差异） |
| 0.51.0 | 2026/06/01 | 评审修正：RFC-mute.md 补充 `findHighestGranularityMatch` 显式别名声明（`const findHighestGranularityMatch = findNarrowestCover`，消除 evaluateRuleSet 调用但无定义的问题）、RFC-request-queue.md `processNextRequest` 中 `validateAndExecute` 补充各 action 校验逻辑的交叉引用注释（RFC-kick.md / RFC-mute.md）、房主端 request 入队步骤补充 `from` 字段显式注入（`{ ...request, from }`）、`cancelPendingRequests` 触发时机措辞修正（"用户主动调用"明确仅清空排队中未发送的 request，不影响 awaitingResult）、RFC-roles.md 败者降级步骤 b 注释补充步骤 a→d 窗口安全性说明（全同步执行无 await 点 + disposed 守卫覆盖异步路径） |

> 版本变更摘要仅记录设计演化过程，若子文档正文与变更摘要存在差异，**以子文档正文为准**。

## 阅读指南

- **首次阅读**：建议先读 [RFC-core.md](./RFC-core.md) 了解整体架构和概念，再按需深入具体模块
- **实施参考**：各模块的伪代码流程和时序图在对应子文档中，设计决策表也按模块分布在各子文档末尾
- **原始完整版**：拆分前的完整 RFC 备份在 [RFC.md.bak](./RFC.md.bak)
