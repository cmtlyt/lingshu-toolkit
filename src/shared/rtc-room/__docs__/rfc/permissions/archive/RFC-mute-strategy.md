# RFC: 禁言策略（从 RFC-permissions.md 抽离）

> status: superseded（已被 RFC-mute-refactor.md 组合键方案替代）
>
> author: cmtlyt
>
> create time: 2026/05/21 17:45:00
>
> source: RFC-permissions.md v0.26.0
>
> scope: `src/shared/rtc-room/permissions/mute/`
>
> 说明: 本文档从 RFC-permissions.md 中完整抽离禁言策略相关内容，作为独立参考。原文档不做修改。

## 概述

禁言系统是权限控制的核心子系统，提供三层粒度的发送拦截能力。禁言仅影响**写权限**（发送拦截），消息接收不受影响。

## API 设计

### 三层禁言粒度

```typescript
/**
 * 禁言范围
 * - 不传 scope：用户级全禁（所有 channel 所有事件）
 * - 传 { channel }：channel 级（该 channel 的自定义事件 + 原始数据均禁）
 * - 传 { channel, event }：事件级（仅禁该 channel 的特定自定义事件）
 */
interface MuteScope {
  /** 目标 channel label。省略表示所有 channel */
  readonly channel?: string;
  /** 目标自定义事件名。省略表示 channel 下所有事件（含原始数据） */
  readonly event?: string;
}

/**
 * 禁言状态查询结果
 */
interface MuteState {
  /** 是否用户级全禁（allMuted=true 时，具体被豁免的 channel/event 见 ignoredChannels/ignoredEvents） */
  readonly allMuted: boolean;
  /** allMuted=true 时被豁免的 channel 列表（这些 channel 不受 allMuted 影响） */
  readonly ignoredChannels: string[];
  /** allMuted=true 时被豁免的 event 列表（这些 channel 的特定 event 不受 allMuted 影响） */
  readonly ignoredEvents: Array<{ channel: string; event: string }>;
  /** channel 级禁言列表 */
  readonly mutedChannels: string[];
  /** 事件级禁言列表：[channel, event] */
  readonly mutedEvents: Array<{ channel: string; event: string }>;
}
```

### mute / unmute 方法签名

```typescript
interface RtcRoom<UserEvents> {
  /**
   * 禁言（三层粒度）
   * - mute(peerId)：用户级全禁
   * - mute(peerId, { channel })：channel 级
   * - mute(peerId, { channel, event })：事件级
   * - mute('*', { channel? })：全房间普通用户禁言（可选指定 channel）
   *
   * host 免疫禁言，admin 不可自解禁
   */
  mute: (target: (string & {}) | '*', scope?: MuteScope) => void;

  /** 解除禁言（admin 不可自解禁） */
  unmute: (target: (string & {}) | '*', scope?: MuteScope) => void;

  /** 查询某 peer 的禁言状态 */
  getMuteState: (targetPeerId: string) => MuteState;
}
```

## 数据结构

### MuteEntry

```typescript
/**
 * 单用户禁言条目（所有字段使用 JSON 兼容类型）
 *
 * MuteEntry:
 *   allMuted: boolean              — 用户级全禁（针对所有人都生效，具体生效内容由后续参数配置决定）
 *   ignoredChannels: string[]      — allMuted 时的 channel 豁免白名单（这些 channel 不受 allMuted 影响）
 *   ignoredEvents: Record<channel, string[]> — allMuted 时的 event 豁免白名单（这些 channel 的特定 event 不受 allMuted 影响）
 *   channels: string[]             — channel 级禁言（该 channel 不可写，但仍可接收消息）
 *   events: Record<channel, string[]> — 事件级禁言（仅禁特定自定义事件的发送）
 */
interface MuteEntry {
  allMuted: boolean;
  /** allMuted 为 true 时的 channel 豁免白名单：这些 channel 不受 allMuted 限制 */
  ignoredChannels: string[];
  /** allMuted 为 true 时的 event 豁免白名单：这些 channel 的特定 event 不受 allMuted 限制 */
  ignoredEvents: Record<string, string[]>;
  channels: string[];
  events: Record<string, string[]>;
}
```

### MuteRegistry

```typescript
/**
 * 禁言注册表（使用 Record 而非 Map，所有字段 JSON 兼容）
 *
 * - peerId → MuteEntry：针对特定用户的禁言
 * - '*' → MuteEntry：全房间禁言（host 免疫，admin 是否免疫由 roomMuteAffectsAdmin 开关决定）
 */
// muteRegistry: Record<peerId | '*', MuteEntry>

/** 全房间禁言特殊 key */
const ROOM_MUTE_KEY = '*';
```

### SerializedMuteRegistry

```typescript
/**
 * 序列化禁言注册表
 * key: peerId | '*'
 * value: { allMuted, ignoredChannels, ignoredEvents, channels, events }
 */
interface SerializedMuteRegistry {
  [peerIdOrAll: string]: {
    allMuted: boolean;
    ignoredChannels: string[];
    ignoredEvents: Record<string, string[]>;
    channels: string[];
    events: Record<string, string[]>;
  };
}
```

## 匹配逻辑（checkMute）

```text
checkMute(ctx, peerId, channel?, event?):
  // host 永远免疫
  if (peerId === ctx.hostId) return false

  // __room_ctrl__ channel 免通配：只能被具名匹配，不受 allMuted / 全房间禁言影响
  // 只有 entry.channels 包含 '__room_ctrl__' 才能禁言该 channel
  if (channel === '__room_ctrl__'):
    userEntry = registry[peerId]
    if (userEntry?.channels.includes('__room_ctrl__')) return true
    // 全房间禁言对 __room_ctrl__ 无效，跳过
    return false

  // 检查用户级禁言
  matched = matchEntry(registry[peerId], channel, event)
  if (matched) return true

  // 检查全房间禁言（admin 是否免疫由 roomMuteAffectsAdmin 开关决定）
  if (ctx.switches.roomMuteAffectsAdmin || !ctx.adminIds.includes(peerId)):
    matched = matchEntry(registry['*'], channel, event)
    if (matched) return true

  return false

matchEntry(entry, channel?, event?):
  if (!entry) return false
  if (entry.allMuted):
    // allMuted 针对所有人都生效，具体生效内容由后续参数配置决定
    if (channel && event && entry.ignoredEvents?.[channel]?.includes(event)) → 跳过（该 channel 的该 event 被豁免）
    if (channel && entry.ignoredChannels.includes(channel)) → 跳过（该 channel 被豁免）
    else return true                                       // 用户级/全房间 全禁
  if (channel && entry.channels.includes(channel)) return true  // channel 级
  if (channel && event):
    eventSet = entry.events[channel]
    if (eventSet?.includes(event)) return true                   // 事件级
  return false
```

### 匹配优先级

用户级禁言优先级高于全房间级——细粒度更高的指向更明确，优先级理应更高。用户级 `allMuted=true` 时直接返回结论，不再合并全房间禁言信息。

## mute 流程

```text
房主/管理员调用 mute(targetPeerId, scope?):
  0. assertPermissionsEnabled(ctx)
  1. 断言 ctx.ctrlChannelWritable === true（无写权限则报错）
  2. 目标确定:
     - targetPeerId === '*' → 全房间禁言，key = '*'
     - 其他值 → 针对特定用户
  3. 权限层级校验（host → admin → user 单向管理链）：
     - target !== '*' 且 target === hostId → 报错（房主不可被禁言）
     - target !== '*' 且 adminIds.includes(target) 且 localPeerId !== hostId → 报错（管理员不可禁言其他管理员，仅房主可操作管理员）
  4. __room_ctrl__ channel 禁言权限校验：
     - scope.channel === '__room_ctrl__' 且 localPeerId !== hostId → 报错（仅房主可禁言管理 channel）
  5. 若 localPeerId === hostId（房主直接执行）:
     a. 更新本地 muteRegistry[key]:
        - scope 未传 → entry.allMuted = true + entry.ignoredChannels = [] + entry.ignoredEvents = {}（清空所有白名单，所有 channel/event 重新被覆盖）
        - scope.channel 且无 event → entry.channels 中添加 channel；若 entry.ignoredChannels 包含 channel → 从 ignoredChannels 中移除（从白名单移出，恢复被 allMuted 覆盖）
        - scope.channel + event → entry.events[channel] 中添加 event（若 key 不存在则初始化为 []）；若 entry.ignoredEvents[channel] 包含 event → 从 ignoredEvents[channel] 中移除（从白名单移出，恢复被 allMuted 覆盖）
     b. 合并广播: { type: 'batch', events: [{ type: 'mute', target: key, from: localPeerId, scope }, { type: 'sync-state', ...payload }] }
     c. dispatch('member-muted', { peerId: key, scope, from: localPeerId })
  6. 若 localPeerId !== hostId（管理员向房主发送请求）:
     将 request 加入本地串行队列（前一个 request 的 ack 返回或超时后即可发送下一个）
     通过 __room_ctrl__ channel 发送给房主: { type: 'request', requestId, action: 'mute', target: key, scope }
     等待 ack 响应（超时时间 = parameters.requestTimeout ?? 5000ms，超时则 dispatch('request-timeout', { requestId, action }) + throwError）
     收到 ack 后队列流转（允许发送下一个 request）。最终执行结果通过 result 报文异步通知

房主收到 request(action=mute) 消息:
  注意：from 从 PeerEntry.peerId 获取（建连时确定的对端身份）
  1. 校验 from 的 ctrlChannelWritable（断言写权限）
  2. 若写权限校验失败 → 回复 ack: { type: 'request-ack', requestId, success: false, error: '无写权限' }
  3. 断言队列未满: requestQueue.size >= maxPendingRequests → 回复 ack: { type: 'request-ack', requestId, success: false, error: 'queue full' }
  4. 写权限校验通过且队列未满 → 回复 ack: { type: 'request-ack', requestId, success: true }（表示已接受）
  5. 将 request（附带 from）加入房主端 requestQueue
  6. 从队列取出处理时：
     a. 调用 requestInterceptor（外部卡点，默认通过）
     b. 若卡点拒绝 → 单播 result 给发起管理员:
        { type: 'request-result', requestId, action: 'mute', target, scope, success: false, error: '拦截器拒绝: ...' }
     c. 校验目标合法性（不可禁言房主、管理员不可禁言管理员、__room_ctrl__ 禁言仅房主可操作等）
     d. 若校验失败 → 单播 result 给发起管理员:
        { type: 'request-result', requestId, action: 'mute', target, scope, success: false, error: '校验失败: ...' }
     e. 校验通过 → 执行 mute 操作:
        - 更新本地 muteRegistry
        - 合并广播给所有端: { type: 'batch', events: [{ type: 'mute', target, from, scope }, { type: 'sync-state', ...payload }] }
        - 单播 result 给发起管理员:
          { type: 'request-result', requestId, action: 'mute', target, scope, success: true }
        - dispatch('member-muted', { peerId: target, scope, from })

非房主端收到 mute 事件（通过 batch）:
  1. 仅 dispatch 事件，不操作 muteRegistry 等源状态（由后续 sync-state 统一覆盖）
  2. 被禁言方（target === localPeerId 或 target === '*' 且受影响）:
     dispatch('muted', { scope, from })
  3. 其他方 dispatch('member-muted', { peerId, scope, from })

发送拦截（本地被禁言时）:
  broadcast/send/broadcastTo/sendTo/sendRaw/broadcastRaw 在发送前:
    isMuted = checkMute(ctx, localPeerId, channelLabel, eventName)
    if (isMuted):
      throwError('send', 'muted: ...', RoomMutedError)

注意：channel 禁言仅影响写权限（发送拦截），消息接收不受影响。
被禁言用户仍能正常接收该 channel 的消息。
```

## unmute 流程

```text
房主/管理员调用 unmute(targetPeerId, scope?):
  0. assertPermissionsEnabled(ctx)
  1. 断言 ctx.ctrlChannelWritable === true（无写权限则报错）
  2. 权限层级校验（host → admin → user 单向管理链）：
     - target !== '*' 且 target === hostId → 报错（房主不可被解禁——房主本身免疫禁言，解禁无意义，明确拒绝避免产生无效广播）
     - target === localPeerId 且 localPeerId !== hostId → 报错（admin 不可自解禁）
     - adminIds.includes(target) 且 localPeerId !== hostId → 报错（管理员不可解禁其他管理员，仅房主可操作管理员）
  3. __room_ctrl__ channel 解禁权限校验：
     - scope.channel === '__room_ctrl__' 且 localPeerId !== hostId → 报错（仅房主可操作管理 channel 的禁言）
  4. 目标确定:
     - targetPeerId === '*' → key = '*'
     - 其他值 → key = targetPeerId
  5. 若 localPeerId === hostId（房主直接执行）:
     a. 更新 muteRegistry[key]:
        - scope 未传 → 清空整个 entry（全部解禁，包括 ignoredChannels 和 ignoredEvents）
        - scope.channel 且无 event 且 entry.allMuted === true → 将 channel 加入 entry.ignoredChannels
          // 语义：绕过策略（bypass）——allMuted 保持 true，仅豁免该 channel，非真正解禁
        - scope.channel 且无 event 且 entry.allMuted === false → 从 channels 中移除 channel + 删除 events[channel]
          // 语义：真正解禁——移除该 channel 的禁言记录
        - scope.channel + event 且 entry.allMuted === true → 将 [channel, event] 组合加入 entry.ignoredEvents（白名单）
          // 语义：绕过策略（bypass）——allMuted 保持 true，仅豁免该 channel 的该 event
        - scope.channel + event 且 entry.allMuted === false → 从 events[channel] 中移除 event
     b. 合并广播: { type: 'batch', events: [{ type: 'unmute', target: key, from: localPeerId, scope }, { type: 'sync-state', ...payload }] }
     c. dispatch('member-unmuted', { peerId: key, scope, from: localPeerId })
  6. 若 localPeerId !== hostId（管理员向房主发送请求）:
     将 request 加入本地串行队列（前一个 request 的 ack 返回或超时后即可发送下一个）
     通过 __room_ctrl__ channel 发送给房主: { type: 'request', requestId, action: 'unmute', target: key, scope }
     等待 ack 响应（超时时间 = parameters.requestTimeout ?? 5000ms，超时则 dispatch('request-timeout', { requestId, action }) + throwError）
     收到 ack 后队列流转（允许发送下一个 request）。最终执行结果通过 result 报文异步通知

房主收到 request(action=unmute) 消息:
  注意：from 从 PeerEntry.peerId 获取（建连时确定的对端身份）
  1. 校验 from 的 ctrlChannelWritable（断言写权限）
  2. 若写权限校验失败 → 回复 ack: { type: 'request-ack', requestId, success: false, error: '无写权限' }
  3. 断言队列未满: requestQueue.size >= maxPendingRequests → 回复 ack: { type: 'request-ack', requestId, success: false, error: 'queue full' }
  4. 写权限校验通过且队列未满 → 回复 ack: { type: 'request-ack', requestId, success: true }（表示已接受）
  5. 将 request（附带 from）加入房主端 requestQueue
  6. 从队列取出处理时：
     a. 调用 requestInterceptor（外部卡点，默认通过）
     b. 若卡点拒绝 → 单播 result 给发起管理员:
        { type: 'request-result', requestId, action: 'unmute', target, scope, success: false, error: '拦截器拒绝: ...' }
     c. 校验合法性（自解禁防护、管理员不可解禁管理员、__room_ctrl__ 解禁仅房主可操作等）
     d. 若校验失败 → 单播 result 给发起管理员:
        { type: 'request-result', requestId, action: 'unmute', target, scope, success: false, error: '校验失败: ...' }
     e. 校验通过 → 执行 unmute 操作:
        - 更新 muteRegistry
        - 合并广播给所有端: { type: 'batch', events: [{ type: 'unmute', target, from, scope }, { type: 'sync-state', ...payload }] }
        - 单播 result 给发起管理员:
          { type: 'request-result', requestId, action: 'unmute', target, scope, success: true }
        - dispatch('member-unmuted', { peerId: target, scope, from })
```

## getMuteState 查询逻辑

```text
getMuteState(targetPeerId):
  0. assertPermissionsEnabled(ctx)
  1. 若 target 不在房间内（!ctx.memberJoinOrder.includes(targetPeerId)）→ 直接返回空 MuteState:
     return { allMuted: false, ignoredChannels: [], ignoredEvents: [], mutedChannels: [], mutedEvents: [] }
  result = { allMuted: false, ignoredChannels: [], ignoredEvents: [], mutedChannels: [], mutedEvents: [] }

  // host 永远免疫禁言，直接返回空状态
  if (targetPeerId === ctx.hostId) return result

  // 1. 检查用户级禁言（用户级优先级高于全房间级——细粒度更高的指向更明确，优先级理应更高）
  userEntry = muteRegistry[targetPeerId]
  if (userEntry):
    if (userEntry.allMuted):
      result.allMuted = true
      // 填充白名单豁免项（过滤 __room_ctrl__）
      for ch of userEntry.ignoredChannels:
        if (ch !== ROOM_CTRL_CHANNEL): result.ignoredChannels.push(ch)
      for [channel, events] of Object.entries(userEntry.ignoredEvents):
        if (channel !== ROOM_CTRL_CHANNEL):
          for event of events: result.ignoredEvents.push({ channel, event })
      // 用户级全禁时直接返回，不再合并全房间禁言信息：
      // 用户级 allMuted 的细粒度高于全房间级（针对特定用户 vs 针对所有人），
      // 其白名单由管理者针对该用户专门配置，语义上已是最终结论，
      // 合并全房间级白名单反而会引入语义混乱（如全房间豁免了某 channel 但管理者专门对该用户全禁）
      return result
    // 过滤 __room_ctrl__：该 channel 为内部实现细节，永不对外暴露
    for ch of userEntry.channels:
      if (ch !== ROOM_CTRL_CHANNEL):
        result.mutedChannels.push(ch)
    for [channel, events] of userEntry.events:
      if (channel !== ROOM_CTRL_CHANNEL):
        for event of events:
          result.mutedEvents.push({ channel, event })

  // 2. 合并全房间禁言（admin 是否免疫由 roomMuteAffectsAdmin 开关决定）
  if (ctx.switches.roomMuteAffectsAdmin || !ctx.adminIds.includes(targetPeerId)):
    allEntry = muteRegistry['*']
    if (allEntry):
      if (allEntry.allMuted):
        result.allMuted = true
        // 填充白名单豁免项（过滤 __room_ctrl__），合并用户级已有的豁免项
        for ch of allEntry.ignoredChannels:
          if (ch !== ROOM_CTRL_CHANNEL && !result.ignoredChannels.includes(ch)): result.ignoredChannels.push(ch)
        for [channel, events] of Object.entries(allEntry.ignoredEvents):
          if (channel !== ROOM_CTRL_CHANNEL):
            for event of events:
              if (!result.ignoredEvents.some(e => e.channel === channel && e.event === event)):
                result.ignoredEvents.push({ channel, event })
        return result
      // 合并 channel（去重，过滤 __room_ctrl__）
      for ch of allEntry.channels:
        if (ch !== ROOM_CTRL_CHANNEL && !result.mutedChannels.includes(ch)):
          result.mutedChannels.push(ch)
      // 合并 events（去重，过滤 __room_ctrl__）
      for [channel, events] of allEntry.events:
        if (channel !== ROOM_CTRL_CHANNEL):
          for event of events:
            if (!result.mutedEvents.some(e => e.channel === channel && e.event === event)):
              result.mutedEvents.push({ channel, event })

  return result
```

## serialize / deserialize

> 由于 MuteEntry 和 muteRegistry 本身已使用 JSON 兼容类型（`Record<string, MuteEntry>`），serialize/deserialize 的主要职责是**数据校验**而非类型转换。

```text
serialize(muteRegistry: Record<string, MuteEntry>) → SerializedMuteRegistry:
  // 数据结构已是 JSON 兼容，直接返回浅拷贝
  return { ...muteRegistry }

/**
 * 断言数据类型（基于 `src/shared/data-handler` 的 dataHandler 函数实现）
 *
 * dataHandler 提供基于 handler 对象的字段级校验能力：
 *   - 传入 data + handler 对象（key → 校验函数）
 *   - 每个校验函数接收 (value, actions) 参数，通过 actions.assert(condition, msg) 断言
 *   - 校验失败时收集 errors 数组
 *   - 配合 strict: true 或自定义 errorHandler 控制错误处理
 *
 * 校验失败时 dispatch error 事件 + throwError
 */
assertDataShape(data: unknown, context: string):
  // 前置校验：顶层必须是 object
  if (typeof data !== 'object' || data === null):
    onAssertFail(`${context}：期望 object`)

  for [key, raw] of Object.entries(data):
    // 使用 dataHandler 对每个 entry 进行字段级校验
    dataHandler(raw, {
      allMuted: (value, actions) => actions.assert(typeof value === 'boolean', `${context}[${key}].allMuted：期望 boolean`),
      ignoredChannels: (value, actions) => actions.assert(
        Array.isArray(value) && value.every(v => typeof v === 'string'),
        `${context}[${key}].ignoredChannels：期望 string[]`
      ),
      ignoredEvents: (value, actions) => {
        actions.assert(typeof value === 'object' && value !== null, `${context}[${key}].ignoredEvents：期望 Record<string, string[]>`)
        if (typeof value === 'object' && value !== null):
          for [channel, events] of Object.entries(value):
            actions.assert(
              Array.isArray(events) && events.every(v => typeof v === 'string'),
              `${context}[${key}].ignoredEvents[${channel}]：期望 string[]`
            )
      },
      channels: (value, actions) => actions.assert(
        Array.isArray(value) && value.every(v => typeof v === 'string'),
        `${context}[${key}].channels：期望 string[]`
      ),
      events: (value, actions) => {
        actions.assert(typeof value === 'object' && value !== null, `${context}[${key}].events：期望 Record<string, string[]>`)
        if (typeof value === 'object' && value !== null):
          for [channel, events] of Object.entries(value):
            actions.assert(
              Array.isArray(events) && events.every(v => typeof v === 'string'),
              `${context}[${key}].events[${channel}]：期望 string[]`
            )
      }
    }, { strict: false, errorHandler: (errors) => onAssertFail(errors.join('; ')) })

  function onAssertFail(message: string):
    const err = new RoomIllegalOperationError(message)
    dispatch('error', { code: 'ILLEGAL_OPERATION', error: err, message, context: 'deserialize' })
    throwError('deserialize', message, RoomIllegalOperationError)

deserialize(data: SerializedMuteRegistry) → Record<string, MuteEntry>:
  assertDataShape(data, 'muteRegistry')
  // 数据结构已是 JSON 兼容，校验通过后直接返回
  return { ...data }
```

## defaultRoomMute 生效

```text
performJoin 完成后（仅 switches.enablePermissions === true 时执行）:
  ...
  3. 若 existingMembers 为空（无人在房间）→ 本地为第一个进房 → 自动成为房主:
     ...
     若 switches.defaultRoomMute === true:
       ctx.muteRegistry['*'] = { allMuted: true, ignoredChannels: [], ignoredEvents: {}, channels: [], events: {} }
```

defaultRoomMute 生效时机说明：
- 仅在**房主首次创建房间**时生效
- 后续加入的用户通过 sync-state 接收 muteRegistry（已包含全房间禁言状态），无需额外处理
- 所有成员离开后房间自动销毁；后续以相同 roomId 加入视为**全新房间**，新房间的首任房主会重新应用 defaultRoomMute 配置
- 即：defaultRoomMute 在每次房间从零创建时都会生效，不限于"首次使用该 roomId"

## 边界行为

### 全房间禁言事件中的 peerId 字段

`member-muted` / `member-unmuted` 事件的 `peerId` 字段：
- 针对特定用户时：值为目标用户的 peerId
- 全房间禁言时：值为 `'*'`（内部 registry 同样使用 `'*'` 作为 key，内外统一）

### 全房间禁言与绕过策略的交互

`allMuted` 表示**针对所有人都生效**，具体生效的内容由后续参数配置决定。`unmute` 在 `allMuted=true` 时的语义是**绕过禁言策略**（bypass），而非"解禁"——避免需要感知所有 channel 带来的复杂度。

- `mute('*')` 将全房间禁言的 MuteEntry 设为 `allMuted=true`，同时**清空 ignoredChannels 和 ignoredEvents 白名单**
- `unmute('*', { channel: 'chat' })` 将 chat 加入 `ignoredChannels` 白名单（绕过禁言策略），`allMuted` 保持为 true。checkMute 匹配时若 `allMuted=true && ignoredChannels.includes(channel)` 则该 channel 豁免（返回 false）
- `unmute('*', { channel: 'chat', event: 'message' })` 同时传递了 channel 和 event → 对所有人都取消对应 channel 的对应 event 禁言：将 `[chat, message]` 组合加入 `ignoredEvents` 白名单（`ignoredEvents['chat'].push('message')`），`allMuted` 保持为 true。checkMute 匹配时若 `allMuted=true && ignoredEvents[channel]?.includes(event)` 则该 event 豁免
- 对已在 `ignoredChannels` 中的 channel 重新 `mute('*', { channel: 'chat' })`（指定相同 channel） → 将该 channel 从 `ignoredChannels` 白名单中移出，恢复被 allMuted 覆盖
- 对已在 `ignoredEvents` 中的 event 重新 `mute('*', { channel: 'chat', event: 'message' })` → 将该 event 从 `ignoredEvents['chat']` 中移出，恢复被 allMuted 覆盖
- 重新 `mute('*')`（不传 scope） → 清空 `ignoredChannels` 和 `ignoredEvents` 白名单，所有 channel 重新被全房间禁言覆盖
- 后续新创建的 channel **自动被 allMuted 覆盖**——因为新 channel 不在 `ignoredChannels` 白名单中，checkMute 自然命中 allMuted，无需额外处理
- `unmute('*')` 不传 scope 则清空整个 `'*'` entry（全部解禁，包括 ignoredChannels 和 ignoredEvents）

### admin 被禁言后的行为

- admin 被用户级全禁后，**管理能力不受影响**——因 `__room_ctrl__` channel 免通配，用户级 `allMuted` 和全房间禁言均不影响该 channel 的写权限。管理能力**只能通过显式禁言 `__room_ctrl__` channel 来剥夺**（即 `mute(peerId, { channel: '__room_ctrl__' })`）
- admin 被禁言 `__room_ctrl__` channel 后，`ctrlChannelWritable` getter 为 false，失去该 channel 的写权限，无法发送任何控制消息（等同失去管理能力）。**仅房主可禁言/解禁 `__room_ctrl__` channel**
- channel 禁言仅影响写权限，admin 仍能接收 `__room_ctrl__` channel 的消息（如 sync-state）
- admin 不可自解禁：调用 `unmute(self)` 时报错
- 仅 host 可解禁 admin 的 `__room_ctrl__` channel 禁言
- **host 永远免疫禁言**，其管理操作不受任何约束

### 转让房主后旧房主的禁言

- 转让前 muteRegistry 中如果存在针对旧房主的禁言条目，由于 host 免疫，这些条目不生效
- 转让后旧房主降级为普通用户，muteRegistry 中已有的禁言条目**立即生效**（checkMute 不再命中 host 免疫分支，自然匹配）

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 禁言粒度 | **三层**：用户级 / channel 级 / 事件级 | channel 禁言 = 该 channel 不可写 |
| channel 禁言效果 | **仅影响写权限**（发送拦截），消息接收不受影响 | 被禁言用户仍能收到消息，只是无法发送 |
| 禁言发送方 | **抛错** | 调用方明确感知，便于 UI 处理 |
| 全房间禁言 | `mute('*', scope?)` → key=`'*'` | host 免疫，admin 是否免疫由 `roomMuteAffectsAdmin` 开关决定 |
| 全房间禁言对 admin | `roomMuteAffectsAdmin` 开关（默认 false） | 灵活控制管理员是否受全房间禁言影响 |
| `__room_ctrl__` 免通配 | `__room_ctrl__` channel **不受** allMuted / 全房间禁言影响 | 管理 channel 只能被具名禁言（`mute(peerId, { channel: '__room_ctrl__' })`），防止用户级全禁意外剥夺管理能力 |
| `__room_ctrl__` 禁言/解禁权 | **仅房主**可禁言/解禁他人的 `__room_ctrl__` channel | 管理员不可剥夺或恢复其他管理员的管理 channel 写权限 |
| 禁言约束管理操作 | `ctrlChannelWritable` getter 为 false 则拒绝 | getter 综合考虑 adminIds + `__room_ctrl__` 禁言状态，单一判断点 |
| getMuteState 过滤 | 返回值永不包含 `__room_ctrl__` channel 条目 | `__room_ctrl__` 为内部实现细节，对外不可见 |
| 匹配优先级 | 用户级 > 全房间级 | 细粒度更高的指向更明确，优先级理应更高 |
| 禁言传播延迟 | 已发出的 request 可能在禁言生效前到达房主 | 房主以收到 request **时刻**的状态校验写权限，禁言 sync-state 尚未覆盖管理员本地时已发送的 request 仍可能被房主拒绝（符合预期） |

## 相关配置

| 配置项 | 位置 | 说明 |
|--------|------|------|
| `switches.enablePermissions` | `RoomSwitches` | 禁言系统的前提开关（权限系统总开关） |
| `switches.defaultRoomMute` | `RoomSwitches` | 创建房间时是否默认开启全房间禁言（默认 false） |
| `switches.roomMuteAffectsAdmin` | `RoomSwitches` | 全房间禁言是否对管理员生效（默认 false） |
| `parameters.requestTimeout` | `PermissionParameters` | 管理员 request 等待 ack 超时（默认 5000ms） |
| `parameters.requestInterceptor` | `PermissionParameters` | 房主端 request 拦截器（外部卡点） |
