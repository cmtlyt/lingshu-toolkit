# RFC: 禁言模型重构 — 组合键 + 两层策略

> status: accepted
>
> author: cmtlyt
>
> create time: 2026/05/21 17:21:00
>
> scope: `src/shared/rtc-room/permissions/mute/`
>
> 依赖: RFC-permissions.md（本文档为禁言子系统的重构方案，替换原 MuteEntry 结构体设计）

## 背景与动机

原禁言模型使用结构体（`MuteEntry`）表达禁言状态，包含 5 个字段（`allMuted`、`ignoredChannels`、`ignoredEvents`、`channels`、`events`），匹配逻辑需要 4 层 if-else 判断。随着 bypass 白名单机制的引入，复杂度进一步上升。

本重构将禁言模型统一为**组合键前缀匹配**，大幅简化匹配逻辑和数据结构。

## 设计概览

### 核心思想

1. **组合键**：用 `channel\0event` 格式统一表达禁言/豁免规则，禁言匹配退化为 `startsWith` 前缀匹配
2. **两层策略**：拆分为「用户层」和「房间层」，用户层优先级高于房间层
3. **三态评估**：用户层返回 `muted` / `exempt` / `no_match`，仅 `no_match` 时才 fallthrough 到房间层

### 分隔符

使用 `\0`（NULL 字符）作为 channel 与 event 的分隔符：

- **安全性**：用户不可能在 channel/event 名中使用 `\0`
- **JSON 兼容**：序列化为 `\u0000`，合法且无歧义
- **无冲突**：无需约束业务侧 channel/event 命名

## 数据结构

### MuteRuleSet

```typescript
/**
 * 禁言规则集（单层）
 * rules 和 exemptions 均为组合键字符串数组，通过前缀匹配判断
 */
interface MuteRuleSet {
  /** 禁言规则列表 */
  rules: string[];
  /** 豁免规则列表（优先于 rules） */
  exemptions: string[];
}
```

### MuteRegistry

```typescript
/**
 * 禁言注册表（两层结构）
 */
interface MuteRegistry {
  /** 全房间禁言策略（对所有人生效，host 免疫，admin 是否免疫由开关决定） */
  room: MuteRuleSet;
  /** 用户级禁言策略（key = peerId） */
  users: Record<string, MuteRuleSet>;
}
```

### 序列化类型

```typescript
/**
 * 序列化后的禁言注册表（JSON 兼容，直接传输）
 * 与 MuteRegistry 结构完全一致（所有字段本身就是 JSON 兼容类型）
 */
type SerializedMuteRegistry = MuteRegistry;
```

## 组合键规则

### buildTarget

```typescript
const MUTE_SEP = '\0';

/**
 * 构建匹配目标字符串
 * @param channel - channel 名称（不传表示全禁标记）
 * @param event - event 名称（不传表示 channel 级）
 */
function buildTarget(channel?: string, event?: string): string {
  if (!channel) return MUTE_SEP;              // '\0' — 全禁标记（匹配一切）
  if (!event) return channel + MUTE_SEP;      // 'chat\0' — channel 级
  return channel + MUTE_SEP + event;          // 'chat\0message' — event 级
}
```

### parseRule

```typescript
interface ParsedRule {
  /** 原始规则字符串 */
  readonly raw: string;
  /** 解析后的 channel（全禁时为 undefined） */
  readonly channel?: string;
  /** 解析后的 event（channel 级时为 undefined） */
  readonly event?: string;
}

/**
 * 解析组合键规则为结构化信息
 * @param rule - 组合键字符串
 */
function parseRule(rule: string): ParsedRule {
  if (rule === MUTE_SEP) return { raw: rule };                    // 全禁
  const sepIndex = rule.indexOf(MUTE_SEP);
  if (sepIndex === -1) return { raw: rule };                      // 格式异常，视为无效规则
  const channel = rule.slice(0, sepIndex);
  const event = rule.slice(sepIndex + 1);
  if (!event) return { raw: rule, channel };                      // channel 级
  return { raw: rule, channel, event };                           // event 级
}
```

### 规则格式总结

| 粒度 | 组合键格式 | 示例 | startsWith 匹配范围 |
|------|-----------|------|---------------------|
| 全禁 | `\0` | `'\0'` | 匹配一切（所有 channel 所有 event） |
| channel 级 | `channel\0` | `'chat\0'` | 匹配该 channel 的所有 event |
| event 级 | `channel\0event` | `'chat\0message'` | 仅匹配该 channel 的该 event |

## 匹配逻辑

### checkMute（入口）

```text
checkMute(ctx, peerId, channel?, event?):
  // host 永远免疫
  if (peerId === ctx.hostId) return false

  // __room_ctrl__ 特殊处理：仅用户级具名匹配，跳过 room 层
  if (channel === '__room_ctrl__'):
    userRuleSet = ctx.muteRegistry.users[peerId]
    if (!userRuleSet) return false
    target = buildTarget('__room_ctrl__', event)
    return matchRuleSet(userRuleSet, target)

  target = buildTarget(channel, event)

  // 第一优先级：用户层（细粒度高 → 优先级高）
  userRuleSet = ctx.muteRegistry.users[peerId]
  if (userRuleSet):
    userResult = evaluateRuleSet(userRuleSet, target)
    if (userResult !== 'no_match'):
      // 用户层有明确结论（禁言 or 豁免）→ 直接返回，不看房间层
      return userResult === 'muted'

  // 第二优先级：房间层（仅在用户层无匹配时才看）
  if (ctx.switches.roomMuteAffectsAdmin || !ctx.adminIds.includes(peerId)):
    return matchRuleSet(ctx.muteRegistry.room, target)

  return false
```

### evaluateRuleSet（三态评估）

```text
evaluateRuleSet(ruleSet: MuteRuleSet, target: string): 'muted' | 'exempt' | 'no_match'
  // 先查豁免（优先级高于禁言规则）
  if (ruleSet.exemptions.some(ex => target.startsWith(ex))):
    return 'exempt'
  // 再查禁言
  if (ruleSet.rules.some(rule => target.startsWith(rule))):
    return 'muted'
  // 无匹配
  return 'no_match'
```

### matchRuleSet（二态匹配，用于房间层）

```text
matchRuleSet(ruleSet: MuteRuleSet, target: string): boolean
  // 先查豁免
  if (ruleSet.exemptions.some(ex => target.startsWith(ex))):
    return false
  // 再查禁言
  return ruleSet.rules.some(rule => target.startsWith(rule))
```

## 两层策略语义

### 优先级规则

**用户层优先于房间层**——用户层有明确结论（禁言或豁免）时直接返回，不再查询房间层。

| 用户层结果 | 行为 | 说明 |
|-----------|------|------|
| `'muted'` | return true（禁言） | 用户层说禁 → 最终禁，房间层无关 |
| `'exempt'` | return false（放行） | 用户层说免 → 最终免，**覆盖房间层** |
| `'no_match'` | 继续看房间层 | 用户层无意见 → 决策权交给房间层 |

### 语义解释

- **用户层 exempt 可覆盖房间层**：如果管理者想让某用户免受房间全禁影响，在该用户的 exemptions 中加入对应规则即可。evaluateRuleSet 返回 `'exempt'`，直接放行，不再看房间层
- **用户层 muted 可覆盖房间层 exempt**：即使房间层豁免了某 channel，用户层仍可单独对该用户禁言该 channel
- **两层互不干扰**：每层的 exemptions 仅作用于本层的 rules（用于 bypass），用户层的 exempt 结论则穿透覆盖房间层

### 场景验证

| 场景 | 用户层 | 房间层 | 最终结果 |
|------|--------|--------|----------|
| 房间全禁，用户无规则 | no_match | muted | **禁言** |
| 房间全禁，用户层有 exemption | exempt | — | **放行**（覆盖房间） |
| 房间无禁言，用户被禁 chat | muted | — | **禁言** |
| 房间全禁 + 豁免 chat，用户无规则 | no_match | exempt (chat) | **放行** |
| 房间全禁 + 豁免 chat，用户禁 chat | muted (chat) | — | **禁言**（用户层覆盖） |
| 用户全禁 + 豁免 chat，房间禁 chat | exempt (chat) | — | **放行**（用户层 exempt 覆盖） |
| 用户无规则，房间无禁言 | no_match | no match | **放行** |

## mute / unmute 操作

### mute 操作

```text
mute(target, scope?):
  ruleKey = buildTarget(scope?.channel, scope?.event)

  if (target === '*'):  // 操作房间层
    roomRuleSet = ctx.muteRegistry.room
    // 若不传 scope → 全禁（清空豁免，插入全禁标记）
    if (!scope):
      roomRuleSet.rules = [MUTE_SEP]
      roomRuleSet.exemptions = []
      return
    // 传 scope → 插入精确规则
    if (!roomRuleSet.rules.includes(ruleKey)):
      roomRuleSet.rules.push(ruleKey)
    // 若 exemptions 中有被该规则覆盖的条目 → 移除（恢复被禁言覆盖）
    roomRuleSet.exemptions = roomRuleSet.exemptions.filter(ex => !ex.startsWith(ruleKey))

  else:  // 操作用户层
    userRuleSet = ensureUserRuleSet(ctx.muteRegistry.users, target)
    if (!scope):
      userRuleSet.rules = [MUTE_SEP]
      userRuleSet.exemptions = []
      return
    if (!userRuleSet.rules.includes(ruleKey)):
      userRuleSet.rules.push(ruleKey)
    userRuleSet.exemptions = userRuleSet.exemptions.filter(ex => !ex.startsWith(ruleKey))
```

### unmute 操作

```text
unmute(target, scope?):
  ruleKey = buildTarget(scope?.channel, scope?.event)

  if (target === '*'):  // 操作房间层
    roomRuleSet = ctx.muteRegistry.room
    if (!scope):
      // 不传 scope → 清空整个房间层
      roomRuleSet.rules = []
      roomRuleSet.exemptions = []
      return
    // 查找是否有精确匹配的规则
    exactIdx = roomRuleSet.rules.indexOf(ruleKey)
    if (exactIdx !== -1):
      // 有精确规则 → 直接删除（真正解禁）
      roomRuleSet.rules.splice(exactIdx, 1)
    else:
      // 无精确规则但被更粗粒度规则覆盖 → 添加豁免（bypass）
      if (roomRuleSet.rules.some(rule => ruleKey.startsWith(rule))):
        if (!roomRuleSet.exemptions.includes(ruleKey)):
          roomRuleSet.exemptions.push(ruleKey)

  else:  // 操作用户层
    userRuleSet = ctx.muteRegistry.users[target]
    if (!userRuleSet) return
    if (!scope):
      // 不传 scope → 清空该用户的整个规则集
      delete ctx.muteRegistry.users[target]
      return
    exactIdx = userRuleSet.rules.indexOf(ruleKey)
    if (exactIdx !== -1):
      userRuleSet.rules.splice(exactIdx, 1)
    else:
      if (userRuleSet.rules.some(rule => ruleKey.startsWith(rule))):
        if (!userRuleSet.exemptions.includes(ruleKey)):
          userRuleSet.exemptions.push(ruleKey)
    // 若规则集为空 → 清理
    if (!userRuleSet.rules.length && !userRuleSet.exemptions.length):
      delete ctx.muteRegistry.users[target]
```

### 操作映射表

| API 调用 | 实际操作 |
|----------|----------|
| `mute('*')` | `room.rules = ['\0']`, `room.exemptions = []` |
| `mute('*', { channel: 'chat' })` | `room.rules.push('chat\0')`；移除 exemptions 中被覆盖的条目 |
| `mute('*', { channel: 'chat', event: 'msg' })` | `room.rules.push('chat\0msg')`；移除 exemptions 中被覆盖的条目 |
| `unmute('*')` | `room.rules = []`, `room.exemptions = []` |
| `unmute('*', { channel: 'chat' })` | 若 `'chat\0'` 在 rules → 删除；否则 `room.exemptions.push('chat\0')` |
| `unmute('*', { channel: 'chat', event: 'msg' })` | 若 `'chat\0msg'` 在 rules → 删除；否则 `room.exemptions.push('chat\0msg')` |
| `mute(peerId)` | `users[peerId].rules = ['\0']`, `users[peerId].exemptions = []` |
| `mute(peerId, { channel: 'chat' })` | `users[peerId].rules.push('chat\0')` |
| `unmute(peerId)` | `delete users[peerId]` |
| `unmute(peerId, { channel: 'chat' })` | 若 `'chat\0'` 在 rules → 删除；否则 `users[peerId].exemptions.push('chat\0')` |

## getMuteState

```typescript
interface MuteState {
  /** 是否被禁言（任一层最终命中即为 true） */
  readonly muted: boolean;
  /** room 层对该用户生效的禁言规则（已过滤 __room_ctrl__、已排除被豁免的） */
  readonly roomRules: ParsedRule[];
  /** room 层的豁免规则 */
  readonly roomExemptions: ParsedRule[];
  /** user 层对该用户生效的禁言规则（已过滤 __room_ctrl__、已排除被豁免的） */
  readonly userRules: ParsedRule[];
  /** user 层的豁免规则 */
  readonly userExemptions: ParsedRule[];
}
```

```text
getMuteState(ctx, targetPeerId):
  assertPermissionsEnabled(ctx)

  emptyState = { muted: false, roomRules: [], roomExemptions: [], userRules: [], userExemptions: [] }

  // 不在房间内 → 返回空状态
  if (!ctx.memberJoinOrder.includes(targetPeerId)): return emptyState

  // host 免疫
  if (targetPeerId === ctx.hostId): return emptyState

  result = { ...emptyState }

  // 收集用户层（过滤 __room_ctrl__）
  userRuleSet = ctx.muteRegistry.users[targetPeerId]
  if (userRuleSet):
    result.userRules = userRuleSet.rules
      .filter(r => !isCtrlChannelRule(r))
      .map(parseRule)
    result.userExemptions = userRuleSet.exemptions
      .filter(r => !isCtrlChannelRule(r))
      .map(parseRule)

  // 收集房间层（过滤 __room_ctrl__，admin 免疫时跳过）
  if (ctx.switches.roomMuteAffectsAdmin || !ctx.adminIds.includes(targetPeerId)):
    result.roomRules = ctx.muteRegistry.room.rules
      .filter(r => !isCtrlChannelRule(r))
      .map(parseRule)
    result.roomExemptions = ctx.muteRegistry.room.exemptions
      .filter(r => !isCtrlChannelRule(r))
      .map(parseRule)

  // 计算最终 muted 状态（复用 checkMute 逻辑，但此处已有数据可直接计算）
  result.muted = checkMute(ctx, targetPeerId)

  return result

isCtrlChannelRule(rule: string): boolean
  return rule.startsWith('__room_ctrl__\0')
```

## defaultRoomMute 生效

`switches.defaultRoomMute === true` 时，房主首次创建房间后：

```text
ctx.muteRegistry.room = { rules: ['\0'], exemptions: [] }
```

等价于 `mute('*')`，通过 sync-state 同步给所有端。

## __room_ctrl__ 特殊处理

保持原设计不变：

- `__room_ctrl__` **仅在用户层具名匹配**，房间层的全禁标记 `'\0'` 不影响 `__room_ctrl__`
- 只有 `users[peerId].rules` 中包含 `'__room_ctrl__\0'` 时才命中
- **仅房主可禁言/解禁** `__room_ctrl__` channel
- getMuteState 返回值中过滤所有 `__room_ctrl__` 相关条目（内部实现细节，不对外暴露）

## serialize / deserialize

由于 `MuteRegistry` 的所有字段本身就是 JSON 兼容类型（`string[]` + `Record<string, MuteRuleSet>`），序列化/反序列化的主要职责是**数据校验**：

```text
serialize(muteRegistry: MuteRegistry) → SerializedMuteRegistry:
  return { room: { ...muteRegistry.room }, users: { ...muteRegistry.users } }

deserialize(data: unknown) → MuteRegistry:
  assertDataShape(data, 'muteRegistry')
  return data as MuteRegistry

assertDataShape(data, context):
  // 顶层必须是 object 且含 room + users
  assert(typeof data === 'object' && data !== null)
  assert('room' in data && 'users' in data)

  // room 必须是 MuteRuleSet
  assertRuleSet(data.room, `${context}.room`)

  // users 必须是 Record<string, MuteRuleSet>
  assert(typeof data.users === 'object' && data.users !== null)
  for [key, value] of Object.entries(data.users):
    assertRuleSet(value, `${context}.users[${key}]`)

assertRuleSet(value, path):
  assert(typeof value === 'object' && value !== null, `${path}：期望 object`)
  assert(Array.isArray(value.rules) && value.rules.every(r => typeof r === 'string'), `${path}.rules：期望 string[]`)
  assert(Array.isArray(value.exemptions) && value.exemptions.every(r => typeof r === 'string'), `${path}.exemptions：期望 string[]`)
```

## sync-state payload 变更

sync-state 中 `muteRegistry` 字段的类型从原 `SerializedMuteRegistry`（`Record<string, MuteEntry>`）变更为新的 `MuteRegistry`（`{ room: MuteRuleSet, users: Record<string, MuteRuleSet> }`）。

## 对比原方案

| 维度 | 原方案（MuteEntry 结构体） | 组合键两层方案 |
|------|------|------|
| **数据结构** | 5 字段 object per peerId | 2 个 `string[]` per layer |
| **checkMute** | 4 层 if-else + ignoredChannels/Events 遍历 | 2 次 evaluateRuleSet/matchRuleSet（各 2 个 `some`） |
| **两层冲突** | 需要 early return + 注释解释优先级 | 天然无冲突（三态 + 短路返回） |
| **mute/unmute** | 操作 5 个字段 + 白名单增删 | push/filter/splice 两个数组 |
| **全禁 + 豁免** | allMuted + ignoredChannels + ignoredEvents | `'\0'` in rules + exemptions |
| **新 channel 自动覆盖** | allMuted=true 不在白名单就命中 | `'\0'` 前缀匹配一切，不在 exemptions 就命中 |
| **序列化** | 5 字段 object per entry | 结构本身 JSON 兼容 |
| **可逆解析** | 无需（结构化字段） | `parseRule()` 提供 |
| **代码行数（checkMute）** | ~30 行 | ~10 行 |

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 分隔符 | `\0`（NULL） | 用户不可能在 channel/event 名中使用，JSON 合法（`\u0000`），无冲突 |
| 两层结构 | room + users | 全房间策略与用户级策略物理隔离，语义清晰 |
| 优先级 | 用户层 > 房间层 | 细粒度指向更明确，优先级更高 |
| 三态评估 | muted / exempt / no_match | exempt 可穿透覆盖房间层，no_match 才 fallthrough |
| exemptions 作用域 | 本层 rules 的 bypass + 对下层的覆盖（通过 exempt 短路） | 用户层 exempt 同时实现"bypass 用户层 rules"和"覆盖房间层" |
| `__room_ctrl__` | 仅用户层具名匹配 | 保持原设计不变 |
| mute('*') 重复调用 | 覆盖（rules 重置为 `['\0']`，清空 exemptions） | 幂等语义，与原设计一致 |
| unmute 真正解禁 vs bypass | 有精确规则 → 删除（真正解禁）；被更粗规则覆盖 → 添加 exemption（bypass） | 自动判断，调用方无需区分 |
