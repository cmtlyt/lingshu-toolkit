# RFC: rtcRoom 房主继位 — 竞赛式

> status: rejected（已被 RFC-election.md 投票式继位替代）
>
> author: cmtlyt
>
> create time: 2026/05/22 16:40:00
>
> rfc version: 0.1.0
>
> scope: `src/shared/rtc-room/permissions/roles/`
>
> parent: [RFC-permissions.md](./RFC-permissions.md)

## 背景

本文档从 RFC-permissions 中抽离房主离开后的自动继位策略，独立描述竞赛式继位的完整设计。

原 RFC-permissions 中相关章节：「候选列表生成」、「房主离开自动继位（竞赛式）」。

## 相关配置项

```typescript
interface PermissionParameters {
  /**
   * 房主候选列表最大长度
   * 默认值 = 房间人数 - 1（房主），即所有非房主成员均为候选者
   * 设为固定数值时，候选列表长度不超过该值（按优先级截取前 N 个）
   */
  readonly maxCandidates?: number;
  /** 竞赛式继位的梯度延迟（ms，默认 3000）。候选者 i 的等待时间 = i * successionDelay */
  readonly successionDelay?: number;
}
```

## 候选列表生成

房主端在以下时机重新计算 `hostCandidates` 并通过 sync-state 同步：

- 成员变动（peer-connected / member-left / kick）
- 管理员变动（addAdmin / removeAdmin）

```text
computeHostCandidates():
  maxLen = parameters.maxCandidates ?? (ctx.memberJoinOrder.length - 1)

  // 收集有效候选者：排除房主自身 + 排除被禁言 __room_ctrl__ channel 的用户
  eligible = ctx.memberJoinOrder.filter(peerId =>
    peerId !== ctx.hostId &&
    !checkMute(ctx, peerId, '__room_ctrl__')
  )

  // 排序策略：管理员优先 → 按 memberJoinOrder 顺序
  admins = eligible.filter(id => ctx.adminIds.includes(id))
  nonAdmins = eligible.filter(id => !ctx.adminIds.includes(id))
  sorted = [...admins, ...nonAdmins]

  // 截取前 maxLen 个
  return sorted.slice(0, maxLen)
```

## 房主离开自动继位（竞赛式）

```text
检测到 hostId 对应的 peer 已离开（member-left 事件触发）:
  1. 所有 peer 立即进入「房主空窗期」:
     prevHost = ctx.hostId
     ctx.hostId = ''（置空）
     disconnectTimestamp = Date.now()（记录房主断连时刻，用于后续 tiebreaker 校验）
     invalidateCache()
     dispatch('host-changed', { prevHost, newHost: '' })
     注意：空窗期内所有本地管理请求（kick/mute/unmute/addAdmin/removeAdmin/transferHost）
     进入本地缓冲区（不发出），待房主正式确认后按序发出

  2. 各 peer 检查自己是否在 hostCandidates 中:
     myIndex = ctx.hostCandidates.indexOf(localPeerId)
     if (myIndex === -1) → 不参与竞选，等待继任广播

  3. 候选者启动竞选计时器:
     delay = myIndex * (parameters.successionDelay ?? 3000)
     // index=0 的候选者 delay=0，立即执行 performSuccession（不等待）
     successionTimer = setTimeout(delay, performSuccession)

  4. performSuccession（竞选计时器到期，执行继位声明）:
     now = Date.now()
     elapsed = now - disconnectTimestamp（房主断连到发出声明的时间）
     a. ctx.hostId = localPeerId
     b. ctx.adminIds.push(localPeerId)（新房主加入管理员）
     c. 初始化 requestQueue
     d. 处理本地缓冲区中的挂起请求（作为新房主直接执行）
     e. 重新计算: ctx.hostCandidates = computeHostCandidates()
     f. ctx.memberJoinOrder = ctx.memberJoinOrder.filter(id => id !== prevHost)
     g. invalidateCache()
     h. 合并广播: { type: 'batch', events: [
          { type: 'host-transfer', prevHost, newHost: localPeerId, timestamp: now, elapsedSinceDisconnect: elapsed },
          buildSyncStatePayload()
        ] }
     i. dispatch('host-changed', { prevHost, newHost: localPeerId })

  5. 收到其他候选者的 host-transfer 广播时:
     先进行合法性校验（见下方 tiebreaker 规则），通过后再 clearTimeout(successionTimer)
     后续由 batch handler 中的 host-transfer + sync-state 逻辑统一处理
```

## Tiebreaker 规则

收到 host-transfer 事件后：

1. **时序合法性校验**：计算 newHost 在旧 hostCandidates 中的 index（记为 senderIndex），判断 `payload.elapsedSinceDisconnect >= senderIndex * successionDelay`：
   - 若不满足 → 该候选者在其合法窗口期之前就发出了声明，视为**越权广播**：
     dispatch('forbidden-broadcast-detected', { peerId: newHost, event: 'host-transfer' })
     断开与该越权用户的所有连接（走越权广播处理流程）
     不停止本地竞选计时
   - 若满足 → 继续下一步

2. **优先级比较**（本地 hostId 已非空，即已有继任者——此分支仅发生在连续收到多个 host-transfer 时，此时本地竞选计时器已被首次接受时 clear，不存在"不停止计时"的情况）：
   比较两个 host-transfer 的 **elapsedSinceDisconnect**（从检测到断连到发出声明的响应时间）：
   - 若新收到的 host-transfer 的 elapsedSinceDisconnect 更小 → 接受（响应更快，覆盖本地 hostId）
   - 否则 → 忽略（当前继任者响应更快）
   - 相等时比较 hostCandidates 中的 index，index 更小者优先（确定性兜底）

   注：elapsedSinceDisconnect 完全基于各端本地时钟计算（`Date.now() - disconnectTimestamp`），不依赖跨端时钟同步，无时钟偏移问题。它代表 peer 的响应速度——响应越快的 peer 网络状况越好，越适合作为房主

3. **首次收到**（本地 hostId 为空）：时序校验通过后直接接受，clearTimeout

注意：
- tiebreaker 比较的是**触发继位前最后一次 sync-state 中的 hostCandidates**
- disconnectTimestamp 从本地检测到 member-left(hostId) 时记录
- 时序合法性和优先级比较均使用 elapsedSinceDisconnect（发送方自报的响应时间，纯本地时钟计算，无跨端时钟偏移问题）

## assertControlPermission 空窗期豁免

空窗期（`hostId === ''`）时，`host-transfer` 事件豁免权限校验：

```text
function assertControlPermission(ctx, from, eventType):
  assertPermissionsEnabled(ctx)

  // 空窗期特殊豁免：hostId 为空时允许 host-transfer 事件通过（竞赛式继位场景）
  // 此时由 tiebreaker 逻辑负责校验合法性，不在全局守卫中拦截
  if (ctx.hostId === '' && eventType === 'host-transfer'):
    return  // 放行，后续由 host-transfer handler 中的 tiebreaker 校验

  // ... 现有校验逻辑 ...
```

## 败者处理

竞赛失败的候选者（计时器被 clear 或 tiebreaker 比较失败）**保持原有角色不变**——原来是管理员仍为管理员，原来是普通用户仍为普通用户。其本地 request 队列和待完结缓冲区也维持原状，由后续 sync-state 覆盖源状态后自然恢复正常工作流。

## 边界行为

### 网络质量筛选

竞赛机制天然具备网络质量筛选能力——因延迟/断连导致错过竞选窗口的候选者默认视为放弃。这是 by design 的：网络不稳定的 peer 成为房主会导致房间管理不可靠，竞赛让「能最快广播的 peer」胜出，等价于选择当前网络状况最好的候选者。

候选列表长度默认为房间总人数 - 1，保证所有非房主成员都有竞选机会，免除"所有候选者都超时"的兜底逻辑。用户可通过 `parameters.maxCandidates` 配置固定长度。

### successionDelay 默认值

默认 3000ms 是工具方的**保守策略**——为网络分区检测、ICE 超时等场景预留足够的冲突窗口。index=0 的候选者 delay=0ms 不等待直接竞选，实际空窗期仅取决于连接断开检测延迟。

业务侧可根据实际场景通过 `parameters.successionDelay` 配置更激进的延迟（如 500~1000ms），在可控的网络环境中缩短继位耗时。

### 网络分区（脑裂）

极端情况下，若网络分区导致不同分区各自产生继任者（脑裂），此场景依赖**重连后 sync-state 强制覆盖 + tiebreaker** 来最终一致——当分区恢复、peer 重新建立 P2P 连接时，两个"房主"互相发现对方，通过 tiebreaker（比较 elapsedSinceDisconnect，响应更快者优先）确定唯一房主。

败者**保持原有角色**（原来是 admin 就还是 admin，原来是 user 就还是 user），其本地 request 队列和待完结缓冲区维持原状，不销毁不清空。胜者向所有端下发 sync-state 强制覆盖，败者的 requestQueue（若因竞选临时初始化）在收到 sync-state 时由 `requestQueue 生命周期管理` 逻辑自动销毁（检测到 isHost === false 且 requestQueue 已存在 → 销毁）。

## 已知不足

本策略存在以下已知问题，由 [RFC-election.md](./RFC-election.md)（投票式选举）方案替代解决：

- **缺乏共识性**：单方面声明即成为房主，其他端被动接受，无"多数认可"的合法性
- **脑裂风险**：网络分区场景下可能产生多个"房主"，需要复杂的 tiebreaker 逻辑恢复
- **tiebreaker 依赖自报值**：虽然 elapsedSinceDisconnect 基于本地时钟，但比较两端各自的本地计算值仍存在不确定性

## 与其他 RFC 的关系

- **RFC-permissions.md**：本文档内容原属 RFC-permissions 的「候选列表生成」和「房主离开自动继位（竞赛式）」章节
- **RFC-election.md**：投票式选举方案，替代本文档的竞赛式继位策略
