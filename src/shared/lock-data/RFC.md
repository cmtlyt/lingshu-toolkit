# RFC: lockData — 受控只读数据锁

> status: review
>
> author: cmtlyt
>
> create time: 2026/04/27 11:50:00
>
> rfc version: 0.1.0
>
> scope: `src/shared/lock-data`

## 版本历史

RFC 版本独立维护，不跟随包版本。语义：

- **0.x.y**（`draft` / `review` 阶段）：
  - `x` → 重大设计变更（新增 / 删除 / 语义翻转一级字段或协议）
  - `y` → 澄清、措辞、示例调整
  - `status` 迁移（draft → review → accepted）本身**不触发版本递增**；只有对应分支已推送 / 已被外部引用后的再次变更才需递增
- **1.0.0**：评审通过（`status: accepted`）后一次性升级
- **1.x.y** 及以后：仅在已 accepted 的 RFC 再做追加或修订时递增

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 0.1.0 | 2026/04/27 | 初稿（含 30 条决策记录、依赖倒置适配器聚合、`persistence` + epoch 探测、`StorageAuthority` 权威副本、文档结构重组为「正文 + 附录 A 完整接口索引 + 附录 B 完整示例集」）；随后在同一版本内由 `draft` 转入 `review` |
| X.Y.Z | YYYY/MM/DD | 一句话变更摘要；涉及字段 / 协议变更时列明新增、删除、重命名；对应的决策追加到「公开决策记录」并引用决策编号（如 #31） |

## 背景与动机

在构建工具库、状态管理、配置中心等场景时，经常会遇到这样的诉求：

- 某份数据在"持有方"视角下**只读**，防止被外部（插件、业务代码）直接篡改
- 修改行为必须收敛到一组**受控 API**（鉴权 / 埋点 / 审计 / 校验）
- 在多 Worker、多 Tab 同时持有"同一份逻辑数据"时，需要一把**互斥锁**来保证修改的串行化

现有的 `Object.freeze`、`Proxy` 读写拦截、`immer` 都只能解决**同线程同文档内**的只读语义，对跨线程 / 跨标签页场景无能为力。
WebAPI 里的 [`navigator.locks`](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) 天然提供了跨 Worker / 跨同源 Tab 的互斥锁原语，但它只管**调度**不管**数据**；而 `BroadcastChannel`、`storage` 事件提供了跨上下文广播能力。
本 RFC 的目标：**将"数据只读代理 + 受控写入 actions + 跨上下文互斥锁"三者聚合成一个简洁的单入口 API `lockData`**，并对不同浏览器能力做好降级。

## 目标与非目标

### 目标

- 提供 `lockData(data, options?)` 单入口，**初始化恒同步（除非 `getValue` 返回 Promise）**，返回 `[readonly, actions]` 元组
- 初始化阶段只构建只读视图，**不抢锁**；只有 `actions` 的写入类方法才会去抢锁
- `readonly` 是一个**强制深只读**视图，任何写入操作直接抛错（无开关）
- `actions.update(recipe, opts?)`、`actions.replace(next, opts?)`、`actions.getLock(opts?)`、`actions.read()`、`actions.dispose()` 作为**唯一合法修改通道**
- 当传入 `id` 时启用跨上下文锁，支持排队等待、超时、强制抢占（`force` 由 action 调用侧传入）
- 支持可选的数据同步 `syncMode`，基于 `localStorage` 维护权威副本（`storage-authority`）+ 单调 `rev`，保证跨 Tab 同源场景下"拿到锁 = 拿到最新值"，并覆盖后台 Tab / bfcache / freeze 唤醒等边缘时序
- 可配置 `persistence`（默认 `'session'`）控制权威副本的生命周期：会话级（所有 Tab 关闭即重置）或长期持久化
- 支持 `getValue` 自定义初始化（可同步、可异步），返回值类型决定 `lockData` 是否为 Promise
- 能力检测 + 多级降级：`navigator.locks` → `BroadcastChannel` + token → `localStorage` + token
- 遵循项目既有风格：`throw-error` 报错、`dataHandler` 校验、`logger` 日志、无实现细节外泄

### 非目标

- **不**实现 CRDT 级别的冲突合并（`syncMode` 基于锁序列化的权威副本 + 单调 `rev` 单向覆盖，CRDT 留给未来）
- **不**实现 SharedArrayBuffer / Atomics 级别的共享内存互斥
- **不**实现持久化存储（宿主进程退出锁自动释放）
- **不**替代 `immer` / `mobx` / `pinia`，只做"锁 + 只读视图 + 受控写入"这三件事

## 名词约定

| 名词 | 含义 |
| --- | --- |
| Holder（持有者） | 当前通过 `lockData` 成功获取锁的上下文（一个标签页 / Worker / 进程实例） |
| Waiter（等待者） | 已发起 `lockData` 但尚未获得锁的调用 |
| Scope（作用域） | 由 `id` 唯一标识的逻辑锁域；未传 `id` 则作用域局限在当前上下文 |
| Instance（实例） | 一次 `lockData(...)` 调用产出的 `[readonly, actions]` 元组；同 `id` 多实例共享同一份 `data` |
| Entry（单例条目） | 进程内 `InstanceRegistry` 中与某个 `id` 关联的共享状态（data 引用 / driver / 引用计数 / listeners fanout） |
| ReadonlyView（只读视图） | `readonly` 代理，任何写操作抛 `TypeError` |
| Actions（受控 API） | 修改数据的唯一合法通道 |
| Draft（草稿） | `update(recipe)` 中 recipe 接收的可写代理，写入落在 working copy 上，不污染底层 data |
| Working Copy（工作副本） | 每次 `update` 内部为 draft 绑定的影子对象，commit 成功才会原子地落到底层 data |
| Mutation Log（变更日志） | draft 的 set / delete 操作按路径记录的最小变更集；commit 时回放，abort 时丢弃 |

## API 设计

### 总览

```ts
import { lockData, NEVER_TIMEOUT } from '@cmtlyt/lingshu-toolkit/shared'

// 同步初始化（默认场景：无 getValue 或 getValue 同步返回，且 syncMode !== 'storage-authority'）
const [readonly, actions] = lockData(initialData, options?)

// 异步初始化 —— 触发条件任一：
//   1. getValue 返回 Promise
//   2. syncMode === 'storage-authority'（需要在 resolve 前完成 localStorage 权威副本的首次 pull）
const [readonly, actions] = await lockData(undefined, { getValue: () => fetch(...) })
const [readonly, actions] = await lockData(initialData, { id: 'x', syncMode: 'storage-authority' })
```

核心语义：

- `lockData` 的**初始化阶段永远不抢锁**，仅构建只读视图 + 预注册锁驱动
- 是否异步**由 `getValue` 的返回值 与 `syncMode` 共同决定**：
  - `getValue` 返回 Promise → Promise
  - `syncMode === 'storage-authority'` → Promise（resolve 前完成 localStorage 权威副本的首次 pull，让 readonly 拿到跨 Tab 最新值）
  - 其他 → 同步
- 抢锁发生在 `actions.update` / `actions.replace` / `actions.getLock` 被调用时
- **同 `id` 在同进程内自动共享同一份 `data` 引用**：多次 `lockData(initial, { id })` 返回独立的 `actions` 和 `readonly` 代理，但底层 `data` 是**同一个对象引用**；任一实例 commit 后，其他实例的 `readonly` 读到的就是最新值，无需开启 `syncMode`
- **`AbortSignal` 生命周期管理**：
  - `options.signal.aborted` 后整个实例等价于 `dispose()`，后续所有 action 调用直接 reject `LockDisposedError`
  - `actionCallOptions.signal.aborted` 只影响本次调用：`acquiring` 阶段中止等价于 `LockAbortedError`；`holding` 阶段中止会丢弃本次 working copy 并 release 锁

### 签名

```ts
// 分支 A：同步初始化
function lockData<T extends object>(
  data: T,
  options?: LockDataOptions<T> & {
    getValue?: (() => T) | undefined
    syncMode?: 'none' | undefined
  },
): LockDataTuple<T>

// 分支 B：异步初始化（getValue 返回 Promise）
function lockData<T extends object>(
  data: T | undefined,
  options: LockDataOptions<T> & { getValue: () => Promise<T> },
): Promise<LockDataTuple<T>>

// 分支 C：异步初始化（syncMode 需要在 resolve 前完成 localStorage 权威副本的首次 pull）
function lockData<T extends object>(
  data: T,
  options: LockDataOptions<T> & { syncMode: 'storage-authority' },
): Promise<LockDataTuple<T>>

type LockDataTuple<T extends object> = readonly [ReadonlyView<T>, LockDataActions<T>]
```

说明：

- 当 `getValue` 存在时，`data` 入参可作为"fallback 初始值"；`getValue` resolve 前 `readonly` 读到的是 `data`（或空对象 + 项目 logger warn 提示）
- `getValue` 返回值的 Promise/同步状态在运行时通过 `value && typeof (value as any).then === 'function'` 判定
- 当 `syncMode === 'storage-authority'` 时，Promise 会在以下三个条件都满足时 resolve：
  1. localStorage 权威副本的 `storage` 事件订阅已就绪，`BroadcastChannel` 的 `session-probe` 订阅已就绪
  2. **会话 epoch 解析完成**（仅 `persistence === 'session'` 阶段）：
     - sessionStorage 已有 `${LOCK_PREFIX}:${id}:epoch` → 直接继承（刷新 / bfcache 恢复 / 单 Tab 刷新）
     - 否则广播 `session-probe` 并等待最多 `sessionProbeTimeout`（默认 100ms）：
       · 收到 `session-reply` → 继承响应方的 epoch，视作"同会话组新开 Tab"
       · 探测超时 → 视作"首个 Tab / 所有 Tab 关闭后重启"，清空 localStorage 权威副本并生成新 epoch
     - `persistence === 'persistent'` 时：epoch 固定为常量 `'persistent'`，不做探测
  3. 对 `localStorage` 权威 key 同步 `getItem` + lazy parse + **epoch 校验**：
     - 命中且 `snapshot.epoch === entry.epoch` → 原地更新 `entry.data`
     - 命中但 epoch 不一致 → 丢弃（视为上一会话组残留，已被步骤 2 的"清空"清理）
     - 未命中（首次启动 / localStorage 不可用）→ 以本地 `data` / `getValue` 为准

### LockDataOptions

字段总览（完整类型签名见「附录 A：完整接口索引」）：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | — | 锁作用域标识；传入即启用进程内单例池 + 跨进程互斥；不传仅实例内互斥 |
| `timeout` | `number \| typeof NEVER_TIMEOUT` | `5000` | `acquireTimeout` / `holdTimeout` 的默认值；action 调用可拆开覆盖 |
| `mode` | `'auto' \| 'web-locks' \| 'broadcast' \| 'storage'` | `'auto'` | 锁驱动选择；`adapters.getLock` 存在时被忽略 |
| `syncMode` | `'none' \| 'storage-authority'` | `'none'` | 跨进程数据同步模式；非 `'none'` 时 `lockData` 返回 Promise |
| `persistence` | `'session' \| 'persistent'` | `'session'` | 权威副本生命周期；仅 `syncMode === 'storage-authority'` 生效 |
| `sessionProbeTimeout` | `number` | `100` | `'session'` 策略首次启动的 session-probe 窗口（ms） |
| `getValue` | `() => T \| Promise<T>` | — | 自定义初始化；返回 Promise 时 `lockData` 返回 Promise |
| `adapters` | `LockDataAdapters` | `{}` | 依赖倒置聚合入口；详见「依赖倒置与适配器」章节 |
| `signal` | `AbortSignal` | — | 实例级 abort；aborted 等价于 `dispose()` + refCount -1 |
| `listeners` | `LockDataListeners` | `{}` | 事件回调（`onLockStateChange` / `onRevoked` / `onCommit` / `onSync`） |

**关键字段补充**：

- **`id` 的双重语义**：① 进程内单例键（同 id 共享 data 引用 + driver）；② 跨进程唯一标识（自动拼接为 lock name `lingshu:lock-data:<id>`）
- **`timeout` 作用对象**：① 抢锁排队超时；② 拿到锁后的持有期（recipe 执行 + 持锁）的最长时长；`NEVER_TIMEOUT`（导出的 `unique symbol`）表示永不超时
- **`syncMode: 'storage-authority'` 语义**：commit 后写入 `${LOCK_PREFIX}:${id}:latest`；其他 Tab 通过 `authority.subscribe` 按 `rev` 去重后原地更新；acquire / `pageshow` / `visibilitychange` 时主动 pull，保证"拿到锁 = 拿到最新值"
- **`persistence: 'session'` 语义**：同会话组所有 Tab 关闭即重置；sessionStorage 维护 Tab 级 epoch，启动时通过 `session-probe` 探测同会话组；刷新 / bfcache 恢复直接继承 epoch 不走探测
- **`signal` 语义**：`aborted` 后所有在途 action reject `LockAbortedError`，后续调用 reject `LockDisposedError`，并从 InstanceRegistry -1 引用计数

**关键调整**：

- ✅ `adapters` 聚合所有依赖倒置注入点（`getLock` / `getAuthority` / `getChannel` / `getSessionStore` / `logger` / `clone`），详见「依赖倒置与适配器」章节
- ✅ 锁状态观察迁移至 `listeners.onLockStateChange`；`onRevoked` 收敛进 `listeners`；新增 `listeners.onSync` / `listeners.onCommit`（审计钩子，携带 mutation log + snapshot）
- ✅ `NEVER_TIMEOUT` 为导出的 `unique symbol`，可用于 `timeout` / `acquireTimeout` / `holdTimeout` 任意位置
- ❌ `force` 从 options 移除（改为 action 调用侧参数，见下）
- ❌ `deepReadonly` 移除（深只读强制执行，无开关）
- ❌ 顶层 `getLock` 移除（收敛进 `adapters.getLock`，RFC 未发布非 breaking，见决策 #30）

### ReadonlyView\<T\>

```ts
type ReadonlyView<T> = T extends (...args: any[]) => any
  ? T
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyView<T[K]> }
    : T
```

实现语义：

- 基于 `Proxy` 的 `set` / `deleteProperty` / `defineProperty` 拦截器直接抛错
- `get` 命中对象类型时惰性包一层代理，避免一次性深拷贝
- `actions` 修改后，`readonly` 对同一引用的读取始终看到最新值（actions 会原地更新底层数据）

### LockDataActions\<T\>

```ts
interface ActionCallOptions {
  /** 抢锁超时（ms / NEVER_TIMEOUT），覆盖 options.timeout。默认 5000 */
  acquireTimeout?: number | typeof NEVER_TIMEOUT
  /** 持有超时（ms / NEVER_TIMEOUT），覆盖 options.timeout；超时后锁自动释放并 reject recipe promise。默认 5000 */
  holdTimeout?: number | typeof NEVER_TIMEOUT
  /** 是否强制抢占当前持有者；原持有者收到 LockRevokedError */
  force?: boolean
  /**
   * 本次调用专用 abort 信号（不影响 actions 整体生命周期）
   *   - acquiring 阶段 abort → reject LockAbortedError
   *   - holding 阶段 abort → 丢弃本次 working copy、释放锁、reject recipe Promise
   * 与 options.signal 是"与"的关系：任一 abort 都会中止本次调用
   */
  signal?: AbortSignal
}

interface LockDataActions<T extends object> {
  /**
   * 以 recipe 形式修改数据；draft 是可写草稿，返回值会被忽略
   * 有 id：返回 Promise（需抢锁）；无 id：同步执行
   * holdTimeout 超时会自动释放锁，recipe 的剩余逻辑视作"已被 revoked"
   */
  update(
    recipe: (draft: T) => void | Promise<void>,
    opts?: ActionCallOptions,
  ): void | Promise<void>

  /** 直接替换整份数据；同样走抢锁流程 */
  replace(next: T, opts?: ActionCallOptions): void | Promise<void>

  /**
   * 主动抢锁并持有（直到调用 dispose 或 holdTimeout 到期）
   * 用于"多次修改事务"：手动抢一次锁，中间连续调用 update/replace 时复用该锁
   * 返回 Promise（有 id 时）或 void（无 id 时）
   */
  getLock(opts?: ActionCallOptions): void | Promise<void>

  /** 读取一份结构化克隆的数据快照（与 readonly 解耦，可随意修改而不影响锁；不抢锁） */
  read(): T

  /** 主动释放当前持有的锁；未持有时为 no-op。dispose 后本 actions 仍可再次 getLock */
  dispose(): Promise<void> | void

  /** 当前是否仍然持有锁 */
  readonly isHolding: boolean

  /** 当前 actions 实例的唯一 token（force 抢占时用来识别持有者） */
  readonly token: string
}
```

调用语义要点：

- `update` / `replace` 如果**当前已持锁**（通过 `getLock` 或上一个未 `dispose` 的事务），直接在锁上执行，不重新抢锁
- `update` 若传入异步 recipe，`holdTimeout` 会对整个 recipe 的完成时间计时
- `getLock` 的典型用法：

  ```ts
  await actions.getLock({ holdTimeout: 10_000 })
  try {
    await actions.update((d) => { d.a = 1 })
    await actions.update((d) => { d.b = 2 })
  } finally {
    await actions.dispose()
  }
  ```

### 错误类型

所有错误经由 `shared/throw-error#throwError` / `throwType` 抛出，错误消息统一带 `[@cmtlyt/lingshu-toolkit#lockData]` 前缀。

| 错误 | 触发时机 |
| --- | --- |
| `LockTimeoutError`（`Error`） | 超过 `timeout` 仍未获得锁 |
| `LockRevokedError`（`Error`） | 持有锁期间被 `force` 抢占 / `holdTimeout` 触发；当前 working copy 被丢弃，持有者后续写入 draft 立即抛错 |
| `LockDisposedError`（`Error`） | `dispose()` 后继续调用 actions；或 `options.signal.aborted` 后任意调用 |
| `LockAbortedError`（`Error`） | `ActionCallOptions.signal` 在 acquiring / holding 阶段 abort |
| `ReadonlyMutationError`（`TypeError`） | 直接修改 `readonly` 视图 |
| `InvalidOptionsError`（`TypeError`） | `options` 不合法（如 `timeout < 0`） |

## 使用示例

### 本地只读锁（不传 id，初始化 & 写入均同步）

```ts
const [user, actions] = lockData({ name: 'cmt', age: 18 })

user.name // 'cmt'
user.name = 'x'
// ❌ TypeError: [@cmtlyt/lingshu-toolkit#lockData]: cannot mutate readonly view

actions.update((draft) => {
  draft.age = 19
})
user.age // 19
```

### 异步初始化（getValue 返回 Promise）

```ts
const [config, actions] = await lockData<Config>(undefined as any, {
  getValue: () => fetch('/api/config').then((r) => r.json()),
})

config.theme // 从接口拿到的值
```

### 跨标签页互斥锁（传 id）

lockData 本身**仍是同步**返回，仅 actions 写入时抢锁：

```ts
// Tab A —— 初始化同步，无 await
const [configA, actionsA] = lockData({ theme: 'dark' }, {
  id: 'app:config',
  timeout: 3000,   // 默认 5000 的基础上调低
})

// 真正抢锁发生在这里
await actionsA.update((draft) => { draft.theme = 'light' })

// Tab B
const [configB, actionsB] = lockData({ theme: 'dark' }, { id: 'app:config' })
try {
  await actionsB.update((d) => { d.theme = 'auto' }, { acquireTimeout: 1000 })
} catch (err) {
  // LockTimeoutError: 1s 内没抢到锁
}
```

### 强制抢占（force 由 action 调用传）

```ts
// Tab A 已通过 getLock / 正在 update 中持有锁
// Tab B
const [, actionsB] = lockData(initial, { id: 'app:config' })
await actionsB.update((d) => { d.hot = true }, { force: true })

// Tab A 侧
actionsA.update(() => {})
// ❌ LockRevokedError: lock has been forcibly acquired by another holder
// actionsA.isHolding === false；listeners.onRevoked('force') 被触发
```

### 多步事务（getLock + 连续 update）

```ts
const [, actions] = lockData(data, { id: 'tx', timeout: 5000 })

await actions.getLock({ holdTimeout: 10_000 })
try {
  await actions.update((d) => { d.step1 = true })
  await actions.update((d) => { d.step2 = true })
  await actions.replace({ ...snapshot, committed: true })
} finally {
  await actions.dispose()
}
```

### 同进程同 id 自动共享数据（无需 syncMode）

```ts
// 同一 Tab 内，两个不同模块各自调用 lockData
// 模块 A
const [userA, actA] = lockData({ name: 'cmt', age: 18 }, { id: 'user' })

// 模块 B（同进程，同 id）
const [userB, actB] = lockData({ name: 'fallback', age: 0 }, { id: 'user' })
// 注意：模块 B 传入的 initial 会被忽略，data 引用直接取首次注册的那份
// 若显式字段冲突（如 timeout / mode），logger.warn 并以首次注册为准

// A 修改 → B 立刻读到
await actA.update((d) => { d.age = 19 })
userB.age // 19（同一底层对象，非广播）
```

### 跨进程数据同步（syncMode: 'storage-authority'，lockData 返回 Promise）

```ts
// Tab A（默认 persistence: 'session'）
const [viewA, actA] = await lockData({ count: 0 }, {
  id: 'shared',
  syncMode: 'storage-authority',
})
await actA.update((d) => { d.count = 1 })
// commit 后 localStorage 权威副本被写入 `{"rev":1,"ts":...,"epoch":"<uuid>","snapshot":{"count":1}}`

// Tab B（与 A 同源，同 id；默认 persistence: 'session'）
const [viewB] = await lockData({ count: 0 }, {
  id: 'shared',
  syncMode: 'storage-authority',
})
// 首次初始化：Promise 在 sessionStorage epoch 解析 + 订阅 storage 事件 + 首次 getItem + lazy parse 完成后 resolve
// B 广播 session-probe，A 回复 session-reply 携带自己的 epoch → B 继承同一 epoch
// resolve 时 viewB.count 已经同步到 1（权威副本 rev=1 大于 entry.lastAppliedRev=0，且 epoch 匹配）
// A 的后续 commit 会通过 storage 事件实时 push 给 B，viewB 原地更新
// B 被切到后台 / 进入 bfcache 期间 A 的多次 commit 会错过 storage 事件，
// 但 B 重新被 visible / pageshow 时会主动 pull 一次，自动补齐为最新值

// ⚠️ A、B 全部关闭后第二天重新打开：
// - sessionStorage.epoch 已被浏览器清空
// - 新 Tab 广播 session-probe 无响应（超时 100ms）
// - 视为"所有 Tab 关闭后重启"：主动 removeItem 清空 localStorage 权威副本，生成全新 epoch
// - readonly 回到 initial data { count: 0 }
```

### 跨会话长期持久化（persistence: 'persistent'）

```ts
// 适用场景：用户草稿、个人偏好、需要跨日 / 跨浏览器重启保留的协作数据
const [view, actions] = await lockData({ theme: 'light', draft: '' }, {
  id: 'user-pref',
  syncMode: 'storage-authority',
  persistence: 'persistent',  // 关闭会话级重置
})

await actions.update((d) => { d.theme = 'dark' })
// 第二天重开：localStorage 权威副本仍在（epoch 固定常量 'persistent'）
// view.theme === 'dark'，自动恢复到最后 commit 状态
```

### 同会话组刷新页面（epoch 继承）

```ts
// 用户正在 Tab A 内操作，此时刷新页面（F5）：
// - sessionStorage.epoch 不会被清空（浏览器规范：刷新保留同 Tab 的 sessionStorage）
// - resolveEpoch 走快路径：直接继承 sessionStorage 中的 epoch，跳过 session-probe 探测
// - readonly 初始化 pull localStorage，epoch 匹配，同步到最新 snapshot
// - 用户刷新后看到的是刷新前的协作状态，无感恢复
```

### 审计 commit + 跨 Tab 同步事件（携带 rev）

```ts
const [, actions] = await lockData({ form: {} }, {
  id: 'form',
  syncMode: 'storage-authority',
  listeners: {
    onCommit: ({ source, token, rev, mutations, snapshot }) => {
      console.log(`commit rev=${rev} by ${token} via ${source}`, mutations)
    },
    onSync: ({ source, rev, snapshot }) => {
      // source: 'pull-on-acquire' | 'storage-event' | 'pageshow' | 'visibilitychange'
      console.log(`synced rev=${rev} from ${source}`, snapshot)
    },
  },
})
```

### AbortSignal 控制生命周期

```ts
// 1. 实例级：options.signal 负责整个 lockData 实例的卸载
const controller = new AbortController()
const [, actions] = lockData(data, { id: 'k', signal: controller.signal })

// 业务触发销毁（如组件卸载）：一次 abort 等价于 dispose，所有在途 action 都会 reject
controller.abort()
await actions.update(() => {}) // ❌ LockDisposedError

// 2. 调用级：ActionCallOptions.signal 只影响本次调用
const callController = new AbortController()
setTimeout(() => callController.abort(), 500)

try {
  await actions.update(
    async (d) => { await syncToRemote(d) },
    { signal: callController.signal },
  )
} catch (err) {
  // err instanceof LockAbortedError: 500ms 内没完成就中止本次 recipe
  // 本次 working copy 被丢弃，底层 data 保持不变；actions 整体仍然可用
}
```

### 自定义锁驱动（adapters.getLock）

```ts
import { lockData, NEVER_TIMEOUT } from '@cmtlyt/lingshu-toolkit/shared'

const [readonly, actions] = lockData(initial, {
  id: 'redis:user:1',
  timeout: NEVER_TIMEOUT,            // 交给业务自行控制超时
  adapters: {
    getLock: async (ctx) => {
      const leaseId = await myRedisLock.acquire(ctx.name, {
        owner: ctx.token,
        force: ctx.force,
        ttlMs: ctx.holdTimeout === NEVER_TIMEOUT ? undefined : ctx.holdTimeout,
        signal: ctx.signal,
      })
      return {
        release: () => myRedisLock.release(ctx.name, leaseId),
        onRevokedByDriver: (cb) => {
          myRedisLock.on('evicted', (id) => id === leaseId && cb('force'))
        },
      }
    },
  },
})
```

> 更多适配器示例（`adapters.logger` + `adapters.clone` 接入 Sentry / `lodash.cloneDeep`、Electron 主进程 IPC 适配、单元测试内存适配器、`listeners.onLockStateChange` 状态观察、`listeners.onCommit` 审计）见「附录 B：完整示例集」。

### 永不超时（NEVER_TIMEOUT）

```ts
import { lockData, NEVER_TIMEOUT } from '@cmtlyt/lingshu-toolkit/shared'

// 全局默认永不超时
const [, actions] = lockData(data, { id: 'never', timeout: NEVER_TIMEOUT })

// 仅某一次 action 调用永不超时
await actions.getLock({ acquireTimeout: NEVER_TIMEOUT, holdTimeout: NEVER_TIMEOUT })
```

## 实现思路

### 架构分层

```
┌───────────────────────────────────────────────────────────┐
│  lockData(data, options)                                  │ 入口 & 参数校验
├───────────────────────────────────────────────────────────┤
│  InstanceRegistry (Map<id, Entry>)                        │ 同 id 进程内单例池
│   · data 引用共享                                         │
│   · driver 共享                                           │
│   · listeners fanout                                      │
│   · 引用计数 (new instance +1 / dispose -1，归零销毁)     │
├───────────────────────────────────────────────────────────┤
│  createReadonlyView<T>(data)       createActions<T>(...)  │ 只读代理 / 受控 actions
│                                     · 事务式 Draft         │
│                                     · Mutation Log         │
│                                     · validityRef          │
├───────────────────────────────────────────────────────────┤
│  LockDriver 接口                                          │ 锁调度抽象
│   ├─ CustomDriver          (adapters.getLock 自定义)      │
│   ├─ LocalLockDriver       (无 id，进程内互斥)            │
│   ├─ WebLocksDriver        (navigator.locks)              │
│   ├─ BroadcastDriver       (BroadcastChannel + token)     │
│   └─ StorageDriver         (localStorage + storage 事件)  │
└───────────────────────────────────────────────────────────┘
```

### InstanceRegistry（同 id 进程内单例）

**Entry 结构关键字段**：

| 字段 | 说明 |
| --- | --- |
| `data` | 共享底层对象引用 |
| `driver` | 共享锁驱动（由 `pickDriver` 决定） |
| `adapters` | 经 `pickDefaultAdapters` 解析后的最终适配器（authority / channel / sessionStore / logger / clone） |
| `refCount` | 已发出未 dispose 的实例数；归零时销毁 Entry |
| `listenersSet` | `Set<LockDataListeners>`，每实例独立；driver 事件向全部 fanout |
| `initOptions` | 首次注册时的冻结配置（用于冲突检查） |
| `dataReadyPromise` | `getValue` 异步初始化时共享的就绪 Promise |
| `dataReadyState` | `'pending' \| 'ready' \| 'failed'` |
| `rev` | 当前 data 的权威单调序号；commit 成功 +1，初始 0 |
| `lastAppliedRev` | 最近一次应用 authority snapshot 的 rev，用于去重 |
| `authority` | `syncMode: 'storage-authority'` 时存在；承载权威副本读写 + 订阅 |
| `epoch` | 当前 Tab 所属会话纪元（`'session'` 策略用），`null` 或 `'persistent'` 表示不做 epoch 过滤 |

**注册 / 释放流程要点**：

- `getOrCreateEntry(id, options, initialData)`：
  - 命中已存在 Entry → `refCount++` + 加入 `listenersSet` + 非 listeners 字段冲突检查
  - 首次创建 → 调用 `pickDriver` / `pickDefaultAdapters` 组装；按 `options.getValue` 返回同步值 / Promise 设置 `dataReadyState`
- `releaseEntry(id, listeners)`：`refCount--` + 从 `listenersSet` 移除 listeners；归零时 `driver.destroy()` + 解绑所有订阅 + `registry.delete(id)`

**行为规则**：

- **data 引用以首次注册为准**：后续 `lockData(newInitial, { id })` 传入的 `newInitial` 直接忽略（不做浅合并）；需要改数据请走 `actions.update`
- **`options` 冲突策略**：非 `listeners` 字段若与 `initOptions` 不一致，`logger.warn('[lockData] option conflict on id=<id>, using first registered value')`
- **listeners 不冲突**：每个实例独立保留一份 listeners，driver 触发事件时向全部 listeners fanout
- **引用计数回收**：每次 `lockData(...)` 产出新实例时 `refCount +1`；`actions.dispose()` 或 `options.signal.aborted` 时 `-1`；归零时销毁 Entry、释放 driver、清理数据通道
- **`dataReadyPromise` 共享**：
  - `getValue` 返回 Promise 时由首次注册的 Entry 统一持有；后续同 id 实例直接 `await entry.dataReadyPromise`，不重复调用 `getValue`
  - 并发初始化下所有实例看到的 data 引用一致，避免各自触发独立请求
  - 已 `'ready'` 后新实例走同步分支，不再创建新 Promise
  - `'failed'` 终态下新实例 `lockData` 立即 reject，并触发 `refCount -1`
- **无 id**：不进入 InstanceRegistry，每次 `lockData` 完全独立；`dataReadyPromise` 仅存在于 actions 内部

### 能力检测与降级

```
pickDriver(adapters, options, id):
  if (adapters.getLock)             -> CustomDriver(adapters.getLock)  // 最高优先级
  if (!id)                          -> LocalLockDriver
  if (options.mode === 'auto'):
    if (navigator.locks)            -> WebLocksDriver
    else if (BroadcastChannel)      -> BroadcastDriver
    else                            -> StorageDriver
  else                              -> 强制使用指定 driver

pickDefaultAdapters(userAdapters, ctx):
  // 按字段逐个解析：用户提供 > 默认实现探测成功 > null（由调用方降级）
  return {
    authority:   userAdapters.getAuthority?.(ctx)   ?? tryDefaultLocalStorageAuthority(ctx),
    channel:     userAdapters.getChannel?.(ctx)     ?? tryDefaultBroadcastChannel(ctx),
    sessionStore: userAdapters.getSessionStore?.(ctx) ?? tryDefaultSessionStore(ctx),
    logger:      userAdapters.logger               ?? defaultLogger,
    clone:       userAdapters.clone                ?? defaultStructuredClone,
  }
  // tryDefaultXxx 函数内部检查对应全局 API 可用性；不可用返回 null
```

`pickDriver` 与 `pickDefaultAdapters` 仅在 `getOrCreateEntry` 首次创建 Entry 时调用；同 id 后续实例直接复用 Entry 中的 driver 与 adapters。降级策略仅影响**锁调度 / 跨进程同步**层，`readonly` / `actions` 的行为对使用者完全透明。

**降级触发矩阵**：

| 场景 | 触发条件 | 降级行为 |
| --- | --- | --- |
| 自定义锁驱动 | `adapters.getLock` 提供 | 覆盖默认能力检测 |
| 权威副本不可用 | `adapters.getAuthority` 未提供 且 `localStorage` 不可用 | `entry.authority = null`，`syncMode: 'storage-authority'` 退化为同进程共享 + `logger.warn` |
| 广播通道不可用 | `adapters.getChannel` 未提供 且 `BroadcastChannel` 不可用 | session-probe 跳过（按"首个 Tab"语义） + `logger.warn` |
| 会话存储不可用 | `adapters.getSessionStore` 未提供 且 `sessionStorage` 不可用 | `persistence: 'session'` 降级为 `'persistent'` + `logger.warn` |
| 克隆失真 | 默认 `structuredClone` 对含 `Function` / `Symbol` / DOM 的值抛错 | JSON fallback + `logger.warn`；用户可注入 `adapters.clone` 规避 |

### CustomDriver

- 当 `adapters.getLock` 存在时，一切能力检测被跳过，driver 仅作为适配层把 `LockAcquireContext` 传给用户回调
- 内部仍负责：
  - 拼接 `name`（`lingshu:lock-data:<id>`）并透传
  - 准备 `AbortSignal`（在 dispose / revoked / acquireTimeout 时触发 abort）
  - 把返回的 `LockHandle.release` 接入状态机的 release 链路
  - 把 `onRevokedByDriver` 回调桥接到 `listeners.onRevoked('force' | 'timeout')`
- `syncMode: 'storage-authority'` 在 CustomDriver 下仍由 `StorageAuthority` 独立管理权威副本（经 `adapters.authority` 读写），**与锁调度完全解耦**（CustomDriver 只管谁持锁，不参与数据同步）

### LocalLockDriver

- 进程内单例的 `Map<id, Holder>`；由于 id 不存在，这里退化为"每次调用都直接获得锁"
- 排队语义不启用，`force`、`timeout` 在此模式下被忽略（由 dataHandler 校验时给出 warn）

### WebLocksDriver（首选）

核心 API：`navigator.locks.request(name, { mode: 'exclusive', steal, signal }, callback)`，`name = lingshu:lock-data:<id>`。

- `force` → `steal: true`；原持有者回调被 reject `AbortError`，捕获后触发 `onRevoked('force')` + `isHolding = false`
- `timeout` → `AbortController.abort()`，`request` reject
- `dispose` → resolve 内部 `holdPromise`，锁自动释放，队列中下一个 waiter 激活

### BroadcastDriver（降级）

当 `navigator.locks` 不可用时，用 `BroadcastChannel('lingshu:lock-data:<id>')` 模拟互斥锁：

- 持有者维护随机 `token` + 200ms `alive` 心跳
- 新 waiter 广播 `acquire-request` 并附带 `requestId`（时间戳 + 随机数）；队列按 `requestId` 排序，所有成员本地维护 mirror
- 心跳连续丢失 N 次视为持有者崩溃，队列 FIFO 晋升
- `force`：广播 `force-acquire`，持有者立即 `onRevoked('force')` + 自毁

### StorageDriver（兜底降级）

`BroadcastChannel` 也不可用时用 `localStorage` + `storage` 事件模拟：

- key `lingshu:lock-data:<id>`，value `{ token, heartbeat, queue }`
- 心跳基于 `setInterval`；其他语义与 BroadcastDriver 一致
- 已知局限：同 Tab 内多实例不会触发 `storage` 事件，需要自行补发

### 只读代理实现要点

- 缓存：用 `WeakMap<object, Proxy>` 保证同一对象多次访问拿到同一个代理（避免身份比较失效）
- 惰性：只在 `get` 访问到对象时才递归包裹，避免初始化时深度遍历
- 写拦截：`set` / `deleteProperty` / `defineProperty` 统一调用 `throwType('lockData', 'cannot mutate readonly view')`
- `actions.update` commit 后会原地变更底层 `data`，因此 `readonly` 对同一引用的读取始终看到最新值
- 同 id 共享：所有共享同一 Entry 的实例，各自构建独立的 `readonly` 代理，但底层指向同一个 `data`；任一实例 commit 完成后，其他实例 `readonly` 立即可读

### 事务式 Draft（抢锁污染防御）

**动机**：force 抢占 / holdTimeout / signal abort 时，如果 recipe 已经对底层数据做了部分写入，新 holder 拿到的是"半成品"。通过"working copy + mutation log + 原子 commit"保证要么全部生效，要么全部丢弃。

#### 数据结构

```ts
interface MutationLog {
  // 路径为 (string | symbol)[]；value 为 set 的新值；op 'delete' 时 value 为 undefined
  entries: Array<{ path: PropertyKey[]; op: 'set' | 'delete'; value?: unknown }>
}

interface DraftContext<T extends object> {
  /** 指向 Entry.data 的引用（commit 时原地改写） */
  readonly target: T
  /** 本次 recipe 的有效性开关 */
  readonly validity: { isValid: boolean }
  /** 本次变更的最小路径集 */
  readonly log: MutationLog
}
```

#### Draft Proxy 行为

```
createDraft(target, ctx, parentPath = []):
  return new Proxy(target, {
    get(obj, key) {
      const v = Reflect.get(obj, key)
      if (isObject(v)) {
        // 惰性递归，子 draft 共享同一个 ctx（共享 validity / log）
        return createDraft(v, ctx, [...parentPath, key])
      }
      return v
    },
    set(obj, key, value) {
      if (!ctx.validity.isValid) {
        throwError('lockData', 'draft is no longer valid (lock revoked / aborted)', LockRevokedError)
      }
      ctx.log.entries.push({ path: [...parentPath, key], op: 'set', value })
      return Reflect.set(obj, key, value)  // 同时写到 target（见下方"选项权衡"）
    },
    deleteProperty(obj, key) {
      if (!ctx.validity.isValid) {
        throwError('lockData', 'draft is no longer valid (lock revoked / aborted)', LockRevokedError)
      }
      ctx.log.entries.push({ path: [...parentPath, key], op: 'delete' })
      return Reflect.deleteProperty(obj, key)
    },
  })
```

**注意**：上述 set/delete 同时改动 `target`（原 data）——这样做仅当 recipe 成功 commit 时等价于直接写入；一旦 revoke / abort，**需要按 mutation log 回滚**，见下。

#### 提交流程（commit）

```
async runUpdateRecipe(recipe, callOpts):
  ensureHolding(callOpts)               // 抢锁 / 复用锁
  const snapshot = snapshotFor(log)     // 浅快照：log 中 set 路径的"旧值"预先记录，供回滚用
  const ctx = { target: entry.data, validity: { isValid: true }, log: createEmptyLog() }
  const draft = createDraft(entry.data, ctx)

  try {
    await recipe(draft)                  // 执行 recipe
    if (!ctx.validity.isValid) {
      // recipe 执行过程中被 revoke：回滚已写入的变更
      rollback(entry.data, snapshot)
      throwError('lockData', 'revoked during recipe', LockRevokedError)
    }
    // commit 阶段：此时所有写入已落到 entry.data
    entry.rev++                           // 权威单调序号递增
    entry.lastAppliedRev = entry.rev      // 本 Tab 发起的 commit 不会再被自己的 storage 事件误判
    const commitEvent = {
      source,                             // 'update' | 'replace'
      token,
      rev: entry.rev,                     // 当前权威序号
      mutations: freezeLog(ctx.log),      // 深冻结，防止外部 mutate
      snapshot: structuredCloneSafe(entry.data),
    }
    listenersFanout.onCommit(commitEvent) // 审计 / 派生状态钩子
    if (entry.authority):                 // syncMode === 'storage-authority' 时写入 localStorage 权威副本
      entry.authority.write(entry.rev, Date.now(), commitEvent.snapshot)
  } catch (err) {
    // recipe 抛错 / revoked / aborted → 回滚到 snapshot；不触发 onCommit
    rollback(entry.data, snapshot)
    throw err
  } finally {
    ctx.validity.isValid = false         // 让遗留 draft 引用后续写入立即抛错
    if (acquiredBySelf) await driver.release()
  }
```

#### 关键实现要点

- **snapshot 按 mutation log 的路径做最小深拷贝**：进入 set 拦截器时先记录"该路径的旧值"到 snapshot；rollback 时按路径逆序写回。这样避免整树克隆大对象
- **validity 置否的时机**：
  - `driver.onRevokedByDriver('force' | 'timeout')` 触发
  - `holdTimeout` 定时器触发
  - `options.signal.aborted` 或 `callOpts.signal.aborted` 触发
  - recipe 正常结束（进入 finally）
- **validity 置否后的 draft 写入**：依旧抛 `LockRevokedError`，即便此时 recipe 已结束——防止 recipe 闭包捕获的 draft 引用被外部再次使用
- **`replace(next, opts?)` 的等价语义**：在一个隐式的 update 事务里执行 `Object.keys(draft).forEach(k => delete draft[k])` + `Object.assign(draft, next)`；享有同样的 working copy / 回滚保护
- **同步 recipe 也走事务**：语义一致、测试路径统一；同步 recipe 的额外开销仅限于 Proxy 访问与 mutation log 的数组 push

### Actions 实现要点

- 内部状态机：`idle` → `acquiring` → `holding` → `committing` → `released` / `revoked` / `disposed`
- 写入方法流程：`update` / `replace` / `getLock` 入口统一走 `ensureHolding(opts)`：
  1. 若 `state === 'holding'` 且锁未被 revoke → 直接复用当前锁
  2. 否则构造**合并 AbortSignal**（`options.signal` + `callOpts.signal` + 内部 acquireTimeout controller），调用 `driver.acquire({ acquireTimeout, holdTimeout, force, signal })` 拿锁
  3. 拿到锁后启动 `holdTimeout` 定时器（`holdTimeout === NEVER_TIMEOUT` 时跳过），到期后主动 release、置 `validity.isValid = false`、state 置 `revoked`
  4. 每一步状态流转都通过 `listenersFanout.onLockStateChange(event)` 分发到所有实例的 listeners
- `update(recipe)`：见"事务式 Draft"章节
  - recipe 执行完：若该次是 `update` 自己抢的锁则立即 release；若是 `getLock` 抢的则保留
  - recipe 结束一律将当次 `ctx.validity.isValid = false`，防止闭包泄露
- `read()`：不抢锁，直接 `structuredClone(entry.data)` / JSON fallback
- `getLock`：只抢锁、启动 `holdTimeout`，不执行 recipe；释放后的"空持锁期"没有 draft，所以不涉及 validity
- `dispose`：
  - 清理 `holdTimeout`、release 锁、清理 driver 侧监听
  - 从 InstanceRegistry 释放引用计数；归零时销毁 Entry
  - **不销毁** actions 本体在"dispose 后"仅限 `isHolding === false` 下的 no-op；但一旦 `options.signal.aborted` 为 true，则整个 actions 进入 `disposed` 终态，任何后续调用 reject `LockDisposedError`
- **NEVER_TIMEOUT 处理**：`acquireTimeout === NEVER_TIMEOUT` 时不注册抢锁超时 AbortSignal；`holdTimeout === NEVER_TIMEOUT` 时不注册 hold 定时器
- **AbortSignal 组合**：内部用 [`AbortSignal.any`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static)（或等价 polyfill）把 `options.signal` / `callOpts.signal` / 超时 / dispose 四路信号合成一个派生 signal，传递给 driver
- **getValue 异步期间的抢锁**：
  - `getValue` 返回 Promise 时，**由 `Entry.dataReadyPromise` 统一持有**；同 id 多个实例共享同一个 Promise，不会重复触发 `getValue`
  - 此期间如调用 `update` / `replace` / `getLock`，action 将**等待 `entry.dataReadyPromise` resolve 后再进入抢锁流程**（而不是直接 reject）
  - `acquireTimeout` 计时从"进入抢锁流程"时开始计算，等待 `dataReadyPromise` 的时间不计入抢锁超时
  - 若 `entry.dataReadyState === 'failed'`，任何 action 调用直接 reject `LockDisposedError`（视为初始化失败，所有共享该 Entry 的实例一并不可用）
  - 无 id 场景下 `dataReadyPromise` 由 actions 内部持有，语义与上述一致

### syncMode 实现要点

- `'none'`（默认）：driver 只传输锁信号，不传数据；**但同进程同 id 仍通过 InstanceRegistry 共享 data 引用**，跨进程才真正"不同步"
- `'storage-authority'`：见下方「StorageAuthority」章节，由 `Entry.authority` 负责全部跨 Tab 数据同步职责

### 依赖倒置与适配器

**动机**：`lockData` 涉及多个环境 API（localStorage / sessionStorage / BroadcastChannel / structuredClone / logger / navigator.locks）。为支持非浏览器环境（Node / SSR / RN / Electron / Worker）、生产日志集成、测试内存替身等场景，把所有"对外部环境的依赖"收敛到 `options.adapters` 单一入口，内部提供默认实现，用户按需覆盖。

#### 设计原则

- **单一入口**：所有可外部化的依赖统一聚合到 `options.adapters`（而非平铺到顶层 options），减少 `LockDataOptions` 表面积
- **工厂函数风格**：涉及 id 作用域的依赖（锁 / 权威副本 / 通道 / 会话存储）通过 `getXxx(ctx) => Adapter` 形式注入，与现有 `getLock` 对齐；无 id 作用域的依赖（`logger` / `clone`）直接传实例
- **默认实现兜底**：`adapters` 各字段均可缺省；内部在 Entry 初始化时调用 `pickDefaultAdapters(ctx)` 组合默认实现（浏览器原生 API），用户提供的字段优先级最高
- **能力等价契约**：所有默认实现与用户注入的 adapter 必须满足同一接口契约（同步 / 异步语义、订阅 / 取消语义、幂等性）。内部不对 adapter 做能力探测，**语义正确性由提供方负责**
- **跨 Tab 对齐**：同一 id 的所有 Tab 必须使用语义等价的 adapter（否则权威副本互不可见）；`StorageAuthority` 的存储格式（rev → ts → epoch → snapshot 的字段顺序契约）由内部 `codec` 固化，不开放给 adapter 层

#### 接口定义

```ts
/** 权威副本存储适配器：StorageAuthority 通过此对象读写权威副本 + 订阅外部更新 */
interface AuthorityAdapter {
  /**
   * 读取当前权威副本的原始字符串（未解析）
   * 返回 null 表示 key 不存在（首个 Tab / 已被清空）
   */
  read(): string | null

  /**
   * 写入权威副本；raw 为内部 codec 序列化后的字符串，适配器不应修改其内容
   * 超配额 / 写入失败时建议 throw，内部会捕获并走 logger.warn 降级
   */
  write(raw: string): void

  /** 删除权威副本（session 策略首个 Tab 清理上一会话组残留用） */
  remove(): void

  /**
   * 订阅外部（其他进程 / Tab / 设备）对权威副本的写入 / 删除
   * - 写入事件：newValue 为新的 raw 字符串
   * - 删除事件：newValue 为 null
   * - 自进程写入是否触发回调由适配器决定；内部通过 lastAppliedRev 做幂等去重
   * @returns 取消订阅函数
   */
  subscribe(onExternalUpdate: (newValue: string | null) => void): () => void
}

/** 广播通道适配器：session-probe / session-reply 协议通过此对象收发消息 */
interface ChannelAdapter {
  /** 向所有订阅者广播消息；消息内容为 JSON 可序列化对象 */
  postMessage(message: unknown): void

  /**
   * 订阅通道消息
   * - 自进程 postMessage 是否回调由适配器决定；内部通过 probeId 去重
   * @returns 取消订阅函数
   */
  subscribe(onMessage: (message: unknown) => void): () => void

  /** 关闭通道（Entry refCount 归零时调用） */
  close(): void
}

/** 会话级存储适配器：仅供 session 策略的 epoch 存储用；接口形态收敛为纯同步读写 */
interface SessionStoreAdapter {
  /** 读取当前会话纪元；返回 null 表示 Tab 首次启动 */
  read(): string | null
  /** 写入会话纪元 */
  write(value: string): void
}

/** 日志适配器；默认实现委托到 shared/logger */
interface LoggerAdapter {
  warn(message: string, ...extras: unknown[]): void
  error(message: string, ...extras: unknown[]): void
  debug?(message: string, ...extras: unknown[]): void
}

/** 克隆函数；用于 read() / onCommit.snapshot / authority.write 的 snapshot 派生 */
type CloneFn = <V>(value: V) => V
```

#### 默认实现

`src/shared/lock-data/adapters/` 提供以下默认实现；`pickDefaultAdapters(ctx)` 在每个字段缺省时按需组合：

| Adapter | 默认实现 | 位置 | 不可用时的降级 |
| --- | --- | --- | --- |
| `getLock` | `pickDriver(options, id)` 能力检测（Web Locks → Broadcast → Storage → Local） | `drivers/index.ts` | 由能力检测自行兜底 |
| `getAuthority` | `DefaultLocalStorageAuthority`：localStorage + `storage` 事件订阅 + `QuotaExceededError` 捕获 | `adapters/authority-local-storage.ts` | 探测 `localStorage` 不可用 → 返回 null → `entry.authority = null` + `logger.warn` |
| `getChannel` | `DefaultBroadcastChannel`：`BroadcastChannel` 包装 | `adapters/channel-broadcast.ts` | 探测 `BroadcastChannel` 不可用 → 返回 null → session-probe 跳过 + `logger.warn` |
| `getSessionStore` | `DefaultSessionStore`：sessionStorage 包装 | `adapters/session-store-session-storage.ts` | 探测 `sessionStorage` 不可用 → 返回 null → `persistence: 'session'` 降级为 `'persistent'` + `logger.warn` |
| `logger` | `shared/logger` | `adapters/logger-default.ts` | 始终可用 |
| `clone` | `structuredCloneSafe`：`structuredClone` 优先 + JSON fallback + `logger.warn` | `adapters/clone-structured.ts` | 始终可用（兜底 JSON） |

**组合时机**：`getOrCreateEntry` 首次创建 Entry 时调用 `pickDefaultAdapters(options.adapters, { id, ... })`，产出最终的 `ResolvedAdapters` 对象挂到 `entry.adapters`；后续所有内部模块通过 `entry.adapters` 访问，彻底解耦对全局 API 的直接依赖。

**优先级**：用户提供 > 默认实现探测成功 > 返回 null（对应字段走"降级"分支）。

### StorageAuthority（localStorage 权威副本）

**动机**：commit 广播若走 BroadcastChannel 会与锁释放走不同通道，非 holder 在 `driver.acquire` 成功瞬间可能尚未收到最新 snapshot；而后台 Tab 进入 bfcache / freeze 时还会直接丢失广播消息。将"权威副本"抽象为 `AuthorityAdapter`（默认实现为 localStorage），把"推送"与"拉取"两条路径收敛到同一份持久化数据上，实现：

- **拿到锁 = 拿到最新值**：`driver.acquire` 后同步 `authority.read()` + lazy parse，读路径亚毫秒完成
- **后台唤醒自愈**：`pageshow` / `visibilitychange` 主动 pull，覆盖 bfcache / freeze 期间错过的变更
- **跨 Tab 顺序一致**：所有 commit 写入都经过锁串行化，`rev` 单调递增，任意 Tab 读到的必然是当前权威值
- **推送通道内建**：`authority.subscribe(...)` 封装 `storage` 事件（默认实现）/ IPC 广播（用户实现），**完全不需要再用 BroadcastChannel 做数据广播**
- **环境无关**：非浏览器环境（Electron / RN / Node 多进程）通过 `adapters.getAuthority` 注入自定义实现，完整保留跨进程同步语义

#### 职责边界

```
LockDriver                                StorageAuthority
─────────                                 ────────────────
谁持锁 / 谁排队 / 谁释放                  权威 snapshot 读写 + 跨 Tab 推送
与数据完全无关                            与锁调度完全无关
```

两者共用**同一存储层的不同 key**（默认实现下都落在 localStorage，adapter 注入时由用户自行决定底层），互不干扰：

| key | 职责 | 写入方 | 访问入口 |
| --- | --- | --- | --- |
| `lingshu:lock-data:${id}` | 锁调度状态（StorageDriver 专用） | StorageDriver | `adapters.getLock` 或默认 driver |
| `lingshu:lock-data:${id}:latest` | 数据权威副本 | StorageAuthority | `adapters.getAuthority` 或默认实现 |
| `lingshu:lock-data:${id}:epoch` | 当前 Tab 的会话纪元（sessionStorage） | StorageAuthority | `adapters.getSessionStore` 或默认实现 |

#### 存储格式（固化契约）

```ts
// localStorage value 必须为 JSON 字符串，字段顺序固化为：rev → ts → snapshot
// rev 必须在首位，便于 lazy parse 时的快路径提取
type AuthorityRaw = string // `{"rev":42,"ts":1714198800123,"snapshot":{...}}`

function serialize(rev: number, ts: number, snapshot: unknown): string {
  return `{"rev":${rev},"ts":${ts},"snapshot":${JSON.stringify(snapshot)}}`
}
```

固化理由：

- `JSON.stringify({ rev, ts, snapshot })` 在 JS 规范上**不保证字段顺序**（V8/SpiderMonkey 实测按插入顺序，但不作为契约），手动拼接避免任何引擎差异
- `rev` 固定首位，`extractRev` 用锚定开头的正则即可安全提取，不会被 snapshot 内容干扰

#### Lazy Parse 快路径

```ts
function extractRev(raw: string): number | null {
  // 匹配 `{"rev":<整数>` 开头；失败（旧格式 / 手动写入）返回 null 走全量 parse 兜底
  const match = /^\{"rev":(-?\d+)/.exec(raw)
  return match ? Number(match[1]) : null
}

function extractEpoch(raw: string): string | null {
  // 匹配 `...,"epoch":"<string>"`；用于快路径 epoch 过滤（避免因上一会话组残留数据解析大 snapshot）
  const match = /,"epoch":"([^"\\]*)"/.exec(raw)
  return match ? match[1] : null
}

function readIfNewer(entry: Entry, raw: string | null): Snapshot | null {
  if (!raw) return null
  const remoteRev = extractRev(raw)
  if (remoteRev === null) {
    // 格式不识别，走全量 parse 兜底
    const parsed = JSON.parse(raw)
    if (parsed.rev <= entry.lastAppliedRev) return null
    if (entry.epoch !== null && parsed.epoch !== entry.epoch) return null
    return { rev: parsed.rev, snapshot: parsed.snapshot }
  }
  if (remoteRev <= entry.lastAppliedRev) return null  // 快路径：无需解析 snapshot
  // epoch 快路径过滤：session 策略下若 epoch 不一致（上一会话组残留），直接丢弃
  if (entry.epoch !== null) {
    const remoteEpoch = extractEpoch(raw)
    if (remoteEpoch !== null && remoteEpoch !== entry.epoch) return null
  }
  const { snapshot } = JSON.parse(raw)                 // 仅在真的要应用时才解析
  return { rev: remoteRev, snapshot }
}
```

**收益**：绝大多数 `storage` 事件（尤其同 Tab 高频 commit 时的频繁触发）命中"rev 未变"快路径，避免反复 `JSON.parse` 大 snapshot。`persistence: 'session'` 下 epoch 不匹配时同样走快路径直接丢弃，不会误应用上一会话组的数据。

#### 写路径（commit 后）

```
onCommitSuccess(snapshot):
  entry.rev++
  entry.lastAppliedRev = entry.rev
  if (entry.authority):
    const raw = serialize(entry.rev, Date.now(), entry.epoch ?? 'persistent', snapshot)
    entry.adapters.authority.write(raw)
    // 默认实现：localStorage.setItem(key, raw)，同源其他 Tab 自动收到 storage 事件
    // 自定义实现：由 adapter 自行决定广播方式（IPC / postMessage / Redis pub/sub 等）
  listenersFanout.onCommit({ source, token, rev: entry.rev, mutations, snapshot })
```

#### 读路径（三个触发源共享同一应用流程）

```
applyAuthorityIfNewer(source, raw):
  if (!raw) return                      // 删除 key 极少见，忽略
  const result = readIfNewer(entry, raw)
  if (!result) return                   // rev 未变 / 过时 / epoch 不匹配 → 直接丢弃，不解析 snapshot
  replaceInPlace(entry.data, result.snapshot)
  entry.rev = result.rev
  entry.lastAppliedRev = result.rev
  listenersFanout.onSync({ source, rev: result.rev, snapshot: result.snapshot })
```

| 触发源 | 触发时机 | `source` 取值 | 数据拉取方式 |
| --- | --- | --- | --- |
| **acquire 时 pull** | `driver.acquire` 成功、进入 recipe 前 | `'pull-on-acquire'` | `entry.adapters.authority.read()` 同步读 |
| **authority.subscribe push** | 其他进程写入触发订阅回调 | `'storage-event'` | 回调直接传入 `newValue`（默认实现由 `storage` 事件触发；自定义实现由 IPC / MessagePort / Redis sub 触发） |
| **激活时主动 pull** | `pageshow(e.persisted)` / `visibilitychange → 'visible'` | `'pageshow'` / `'visibilitychange'` | `entry.adapters.authority.read()` 同步读 |

> `pageshow` / `visibilitychange` 仅在 `typeof window !== 'undefined'` 时注册；非浏览器环境如有等价的"应用从后台唤醒"语义，可由 `AuthorityAdapter.subscribe` 在回调时机自行触发，无需依赖这两个事件。

#### 首次初始化（lockData Promise resolve 前）

```
initAuthority():
  entry.authority.unsubscribe = entry.adapters.authority.subscribe(onAuthorityExternalUpdate)
  订阅 pageshow / visibilitychange（仅浏览器环境）
  entry.epoch = await resolveEpoch()           // 见下方「会话级持久化与 epoch 探测」
  const raw = entry.adapters.authority.read()
  const result = readIfNewer(entry, raw)       // entry.lastAppliedRev === 0 所以 rev 命中即应用；epoch 不匹配快路径丢弃
  if (result):
    replaceInPlace(entry.data, result.snapshot)
    entry.rev = result.rev
    entry.lastAppliedRev = result.rev
  // 未命中（authority 无该 key / epoch 不匹配）说明是跨进程首次启动或上一会话组已失效，以本地 data / getValue 为准
```

**副作用优点**：localStorage 天然持久化；`persistence: 'persistent'` 下用户刷新页面 / 新开 Tab 会自动恢复最后 commit 的状态 —— 相当于**免费的持久化兜底**；`persistence: 'session'` 下则由 epoch 过滤保证"所有 Tab 关闭即重置"。

### 会话级持久化与 epoch 探测

**目的**：解决 "localStorage 天然持久化 vs 用户期望的会话级协作" 语义冲突 —— 用户希望只在多 Tab 活跃期间共享数据，所有 Tab 关闭后下次打开应当从 `initial` / `getValue` 重新开始。

#### 策略总览

| `persistence` | 生命周期 | 典型场景 |
| --- | --- | --- |
| `'session'`（默认） | 当前会话组（同源所有活跃 Tab）的最大存活期 | 临时协作表单、多 Tab 共享的操作进度、向导状态 |
| `'persistent'` | localStorage 自然持久期（跨会话、跨浏览器重启） | 用户偏好、长期草稿、跨日持续的协作文档 |

#### 数据通道

| 通道 | 用途 | 所属 | Adapter |
| --- | --- | --- | --- |
| 会话级存储（默认 sessionStorage） key `${LOCK_PREFIX}:${id}:epoch` | 当前 Tab 的会话纪元（Tab 级隔离，关闭即清空，刷新保留） | StorageAuthority | `adapters.getSessionStore` |
| 权威副本存储（默认 localStorage） key `${LOCK_PREFIX}:${id}:latest` | 跨进程权威副本，value 包含 `epoch` 字段 | StorageAuthority | `adapters.getAuthority` |
| 广播通道（默认 BroadcastChannel） name `${LOCK_PREFIX}:${id}:session` | `session-probe` / `session-reply` 消息 | StorageAuthority | `adapters.getChannel` |

#### `resolveEpoch()` 协议

启动分支与对应行为：

| 分支 | 判定条件 | epoch 来源 | 清空 authority | 备注 |
| --- | --- | --- | --- | --- |
| **A. 持久化** | `persistence === 'persistent'` | 常量 `'persistent'` | 否 | 不做探测 |
| **B. sessionStore 不可用** | `'session'` + `!adapters.sessionStore` | 降级为 `'persistent'` | 否 | `logger.warn` |
| **C. 刷新 / bfcache** | `sessionStore.read()` 有值 | 直接继承 | 否 | 不探测 |
| **D. channel 不可用** | 首次启动 + `!adapters.channel` | 生成新 UUID | ✅ 清空残留 | `logger.warn` + 按"首个 Tab"处理 |
| **E. 同会话组新开 Tab** | 首次启动 + 探测收到 `session-reply` | 继承响应方 epoch | 否 | pull 命中权威副本 |
| **F. 首个 Tab（含残留）** | 首次启动 + 探测超时 | 生成新 UUID | ✅ 清空上一会话组残留 | localStorage 已为空时 remove 也是 no-op |

```
resolveEpoch():
  if (persistence === 'persistent') return 'persistent'       // A
  if (!adapters.sessionStore) { logger.warn(...); return 'persistent' }  // B

  const stored = adapters.sessionStore.read()
  if (stored) return stored                                    // C：刷新 / bfcache 继承

  // 首次启动分支
  if (!adapters.channel):                                      // D
    logger.warn('[lockData] channel unavailable, skip session-probe')
    return freshEpoch({ clearAuthority: true })

  // 广播 session-probe，等待 session-reply（窗口 = sessionProbeTimeout，默认 100ms）
  广播 { type: 'session-probe', probeId } 经 adapters.channel.postMessage
  const resolved = await withTimeout(sessionProbeTimeout, 等待 'session-reply')

  if (resolved) {
    adapters.sessionStore.write(resolved.epoch)
    return resolved.epoch                                      // E：加入现有会话组
  }
  return freshEpoch({ clearAuthority: true })                  // F：首个 Tab（主动清空残留）

freshEpoch({ clearAuthority }):
  const fresh = generateUuid()
  adapters.sessionStore.write(fresh)
  if (clearAuthority) adapters.authority?.remove()             // 主动清空，避免 epoch 不一致的残留
  return fresh
```

响应方（所有 storage-authority + session 的 Tab 在 channel 可用时常驻监听）：

```
on-message(msg):
  if (msg.type === 'session-probe'):
    const myEpoch = adapters.sessionStore?.read()
    if (myEpoch):
      adapters.channel.postMessage({ type: 'session-reply', probeId: msg.probeId, epoch: myEpoch })
```

#### 关键实现要点

- **epoch 使用 `crypto.randomUUID()`**，fallback 到 `Math.random().toString(36) + Date.now()`；长度可控，内部生成不受用户输入影响
- **探测窗口默认 `sessionProbeTimeout: 100ms`**：同源 BroadcastChannel RTT 通常 <1ms，100ms 足够容纳首帧 JS 执行延迟；用户可通过 options 覆盖
- **首个 Tab 的主动清空**是 `'session'` 语义的关键：仅靠 epoch 比较只能让 `readIfNewer` 丢弃旧值，但新 commit 仍会覆盖权威副本，体积不会回收；主动 `authority.remove()` 兼顾语义与空间
- **`sessionStore` 不可用**（默认实现探测 sessionStorage 不可用 / 用户未提供 adapter）：`persistence: 'session'` 降级为 `persistence: 'persistent'` + `logger.warn`
- **`channel` 不可用**（默认实现探测 BroadcastChannel 不可用 / 用户未提供 adapter）：session 策略下跳过探测，直接按"首个 Tab"语义处理 + `logger.warn`；权威副本仍是单一真源，失去"同会话组新开 Tab 继承"能力但不影响同步正确性
- **session 常驻订阅**：`session-probe` 的订阅在 `StorageAuthority` 生命周期内常驻（即使已 `resolveEpoch` 完成），确保本 Tab 能响应后续新 Tab 的探测
- **`refCount === 0` 时**：解绑 session 订阅，调用 `entry.adapters.channel.close()`；权威副本 / 会话存储的 key 不主动清理（保留给同会话组其他 Tab 或下次刷新继承）

#### 关键实现要点

- `lastAppliedRev` 专门用于去重，与 `rev` 分离：
  - commit 后 `rev` 自增同时 `lastAppliedRev = rev`（本 Tab 发起的 commit 不会再被自己的 storage 事件误判为"新值"）
  - 注意：**写入方 Tab 不会收到自己的 `storage` 事件**（规范行为），但保留 `lastAppliedRev` 以防极端场景下的重入
- 写入 snapshot 使用 `entry.adapters.clone(entry.data)`（默认 `structuredClone` → JSON 兜底）；含 `Function` / `Symbol` / DOM 等不可克隆内容时 `logger.warn` 并跳过写入
- `authority.write` 抛出（如 localStorage 超配额 `QuotaExceededError`）时 `logger.warn`，本地 commit 仍视为成功（跨进程同步本次失效，下次 commit 重试）
- **authority 不可用**（默认实现探测 localStorage 不可用 / 用户未提供 adapter）时 `entry.authority` 为 `null`：降级为"同进程同 id 共享、跨进程完全不同步"，与 `syncMode: 'none'` 效果一致，并 `logger.warn('[lockData] authority unavailable, fallback to in-process sharing')`
- `dispose` / `refCount === 0` 时解绑所有订阅（`authority.subscribe` 返回的取消函数 / `pageshow` / `visibilitychange` / `channel.close()`），避免 Entry 被销毁后的野生回调
- `syncMode: 'none'` 时 `entry.authority = null`，`entry.rev` 仍维护（只做本 Tab 内的单调计数，不参与持久化与广播）；`persistence` 字段被忽略；`adapters.getAuthority` / `adapters.getChannel` / `adapters.getSessionStore` 均不会被调用

## 默认值总览

| 选项 | 默认值 | 备注 |
| --- | --- | --- |
| `id` | `undefined` | 不传即本地锁；传入即启用进程内单例池 + 跨进程唯一标识 |
| `timeout` | `5000` | 同时作为 `acquireTimeout` / `holdTimeout` 的默认；`NEVER_TIMEOUT` 表示永不超时 |
| `mode` | `'auto'` | 自动能力检测；`adapters.getLock` 存在时忽略 |
| `syncMode` | `'none'` | 默认不跨进程同步（同进程同 id 始终共享）；`'storage-authority'` 启用 localStorage 权威副本，`lockData` 返回 Promise |
| `persistence` | `'session'` | 仅 `syncMode === 'storage-authority'` 生效；默认"会话级"：同会话组所有 Tab 关闭后权威副本自动重置；`'persistent'` 保留长期持久化 |
| `sessionProbeTimeout` | `100` | `'session'` 策略下 session-probe 探测超时（ms），仅首次启动阻塞 |
| `getValue` | `undefined` | 可选初始化函数 |
| `adapters` | `{}` | 依赖倒置注入点聚合对象；各字段缺省时走默认实现（见下） |
| `adapters.getLock` | `undefined` | 自定义锁驱动工厂，存在时覆盖默认 driver |
| `adapters.getAuthority` | `undefined` | 自定义权威副本存储工厂，默认 `DefaultLocalStorageAuthority` |
| `adapters.getChannel` | `undefined` | 自定义广播通道工厂，默认 `DefaultBroadcastChannel` |
| `adapters.getSessionStore` | `undefined` | 自定义会话存储工厂，默认 `DefaultSessionStore`（sessionStorage） |
| `adapters.logger` | `undefined` | 自定义日志，默认委托 `shared/logger` |
| `adapters.clone` | `undefined` | 自定义克隆，默认 `structuredClone` + JSON fallback |
| `signal` | `undefined` | 控制整个实例生命周期；abort 等价于 dispose |
| `listeners` | `{}` | 事件回调收敛点，可省略任意 hook |
| `ActionCallOptions.acquireTimeout` | `options.timeout` | 抢锁超时 |
| `ActionCallOptions.holdTimeout` | `options.timeout` | 持锁超时 |
| `ActionCallOptions.force` | `false` | 默认排队 |
| `ActionCallOptions.signal` | `undefined` | 本次调用专用 abort 信号 |

## 参数校验

沿用项目 `dataHandler` + `$dt`/`$t` 校验范式：

```ts
const validInfo = $dt({
  id: $t.string(''),
  // timeout 允许为 number 或 NEVER_TIMEOUT symbol，使用 $t.custom 自定义校验
  timeout: $t.custom<number | typeof NEVER_TIMEOUT>(
    (v) => v === NEVER_TIMEOUT || (typeof v === 'number' && v >= 0),
    5000,
  ),
  mode: $t.enum(['auto', 'web-locks', 'broadcast', 'storage'] as const, 'auto'),
  syncMode: $t.enum(['none', 'storage-authority'] as const, 'none'),
  persistence: $t.enum(['session', 'persistent'] as const, 'session'),
  sessionProbeTimeout: $t.number(100),
})
```

**`persistence` / `sessionProbeTimeout` 的额外校验规则**：

- `syncMode === 'none'` 下显式传入 `persistence` 或 `sessionProbeTimeout` → `logger.warn('[lockData] persistence / sessionProbeTimeout ignored when syncMode is "none"')`，字段按默认值回退
- `sessionProbeTimeout` 必须是非负整数；违反走 `throwType('lockData', ...)`

**`$dt` 未覆盖字段的补充校验规则**（`getValue` / `adapters` / `listeners` / `signal` 为非 plain 值或需结构校验，不走 `$dt`）：

- `getValue`：须为 `typeof === 'function'`
- `adapters`：须为对象（允许缺省，内部默认 `{}`）；其内部字段逐个校验：
  - `getLock` / `getAuthority` / `getChannel` / `getSessionStore`：须为 `typeof === 'function'`
  - `logger`：须为对象且 `typeof logger.warn === 'function' && typeof logger.error === 'function'`（`debug` 可选）
  - `clone`：须为 `typeof === 'function'`
  - 多余字段直接忽略（不报错，留足扩展空间）
- `listeners`：须为对象；其中各 hook 单独做 `typeof === 'function'` 检查，允许缺省
- `signal`：须满足 `value instanceof AbortSignal`，或结构等价检查 `typeof value.addEventListener === 'function' && 'aborted' in value`（用于 Node / 自定义实现兼容）

**调用级校验**：

- `ActionCallOptions` 在每次 action 调用前独立校验（含 `NEVER_TIMEOUT` / `signal` 分支）

所有非法值统一走 `throwType('lockData', ...)`。

## 目录与文件规划

```
src/shared/lock-data/
├── RFC.md                    # 本文档
├── index.ts                  # lockData 主入口
├── types.ts                  # 公共类型（含 LockDataAdapters / AuthorityAdapter / ChannelAdapter / ...）
├── constants.ts              # NEVER_TIMEOUT / LOCK_PREFIX / HEARTBEAT_INTERVAL 等
├── registry.ts               # InstanceRegistry（同 id 单例池 / 引用计数 / listeners fanout）
├── readonly-view.ts          # ReadonlyView 代理实现
├── draft.ts                  # 事务式 Draft：validityRef / mutationLog / rollback
├── actions.ts                # LockDataActions 实现
├── authority.ts              # StorageAuthority：权威副本 + lazy parse + 订阅（经 adapters.authority）
├── signal.ts                 # AbortSignal.any 兼容封装
├── adapters/
│   ├── index.ts              # pickDefaultAdapters 组合 + ResolvedAdapters 类型
│   ├── authority-local-storage.ts  # DefaultLocalStorageAuthority（localStorage + storage 事件）
│   ├── channel-broadcast.ts        # DefaultBroadcastChannel（BroadcastChannel 包装）
│   ├── session-store-session-storage.ts # DefaultSessionStore（sessionStorage 包装）
│   ├── logger-default.ts           # 默认 logger（委托 shared/logger）
│   └── clone-structured.ts         # 默认 clone（structuredClone + JSON fallback）
├── drivers/
│   ├── index.ts              # pickDriver 能力检测
│   ├── custom.ts             # CustomDriver（适配 adapters.getLock）
│   ├── local.ts              # LocalLockDriver
│   ├── web-locks.ts          # WebLocksDriver
│   ├── broadcast.ts          # BroadcastDriver
│   └── storage.ts            # StorageDriver
├── errors.ts                 # LockTimeoutError 等错误定义
├── index.mdx                 # 用户向文档（RFC 落地后产出）
└── __test__/
    ├── readonly-view.node.test.ts         # 只读代理行为（纯逻辑，无需浏览器）
    ├── actions-local.node.test.ts         # 无 id 本地锁 + actions（纯逻辑）
    ├── options-validate.node.test.ts      # 参数校验 / NEVER_TIMEOUT 处理（纯逻辑）
    ├── custom-driver.node.test.ts         # adapters.getLock 自定义锁（mock driver 即可）
    ├── registry.node.test.ts              # 同 id 单例 / 引用计数 / options 冲突 warn
    ├── draft-transaction.node.test.ts     # 事务式 Draft / mutation log / rollback / validity
    ├── signal.node.test.ts                # options.signal / ActionCallOptions.signal 行为
    ├── adapters-resolve.node.test.ts      # pickDefaultAdapters 合成 / 优先级 / 探测失败降级
    ├── memory-adapter.node.test.ts        # 基于内存 adapter 端到端跑通 storage-authority + session 全链路
    ├── actions-webLocks.browser.test.ts   # navigator.locks
    ├── actions-broadcast.browser.test.ts  # BroadcastChannel
    ├── actions-storage.browser.test.ts    # localStorage + storage 事件
    ├── authority.browser.test.ts          # StorageAuthority：localStorage 权威副本 / storage 事件 / lazy parse
    ├── authority-lifecycle.browser.test.ts # pageshow / visibilitychange 激活 pull
    └── authority-persistence.browser.test.ts # persistence: 'session' epoch 探测 / 跨会话重置
```

测试目录约定：

- 统一放在方法目录下的 `__test__/` 子目录
- 按 **是否依赖浏览器环境** 拆分后缀：
  - `*.browser.test.ts`：需要真实浏览器 API（`navigator.locks` / `BroadcastChannel` / `storage` 事件 / JSDOM 无法完整模拟的场景）
  - `*.node.test.ts`：纯逻辑用例（参数校验、只读代理、本地锁、CustomDriver 适配），用 Node 运行以降低测试开销
- 两类测试由 `vitest.project.config.ts` 分别声明，浏览器用例走 browser provider，node 用例走 node provider

导出路径需要在 `src/shared/index.ts` 追加 `export * from './lock-data'`，并确保 `NEVER_TIMEOUT` 一同导出。

## 测试策略

按"是否依赖浏览器 API"拆分成 `*.node.test.ts`（纯逻辑，Node 运行）与 `*.browser.test.ts`（真实浏览器 API）。覆盖点汇总：

| 文件 | 环境 | 核心覆盖点 |
| --- | --- | --- |
| `readonly-view.node.test.ts` | Node | 深只读：嵌套对象 / 数组 / Set / Map 的 mutation 全抛 `ReadonlyMutationError`；代理身份一致；actions 写入后读到最新值 |
| `actions-local.node.test.ts` | Node | 无 `id` 时 `lockData` 同步；`update` / `replace` / `read` / `dispose` / `getLock` 行为；`dispose` 后可再 `getLock`；`listeners.onLockStateChange` 状态机流转 |
| `options-validate.node.test.ts` | Node | `timeout` / `listeners` / `ActionCallOptions` 合法值与非法值校验；`getValue` 同步 / 异步 / reject 各路径；`NEVER_TIMEOUT` 不注册定时器 |
| `custom-driver.node.test.ts` | Node | `adapters.getLock` 覆盖默认 driver；同步 / 异步 release；`onRevokedByDriver` 桥接到 `listeners.onRevoked('force')` |
| `registry.node.test.ts` | Node | 同 id 多实例共享 data；后续 `initial` 忽略；非 listeners 字段冲突 `logger.warn`；refCount 归零销毁；`signal.aborted` 自动 dispose |
| `draft-transaction.node.test.ts` | Node | 正常 recipe / 抛错回滚 / 异步期间被 force / `holdTimeout` / 嵌套 draft / `replace` 语义 / mutation log 精确性 |
| `signal.node.test.ts` | Node | `options.signal` + `ActionCallOptions.signal` 的 acquiring / holding 阶段 abort 行为；两路 signal 的"与"组合 |
| `adapters-resolve.node.test.ts` | Node | `pickDefaultAdapters` 字段级优先级；默认 authority / channel / sessionStore 探测失败的降级；`adapters.clone` 的 JSON fallback；用户 adapter 参数校验 |
| `memory-adapter.node.test.ts` | Node | 用内存 adapter 端到端跑 `syncMode: 'storage-authority'` + `persistence: 'session' \| 'persistent'` 全链路，替代一大半浏览器集成测试 |
| `actions-webLocks.browser.test.ts` | Browser | 并发排队；`acquireTimeout` / `holdTimeout` / `force` 抢占 + `onRevoked('force')` |
| `actions-broadcast.browser.test.ts` | Browser（mock `navigator.locks = undefined`） | 心跳丢失后队列晋升；`force` 抢占 |
| `actions-storage.browser.test.ts` | Browser（再 mock `BroadcastChannel = undefined`） | `storage` 事件跨 Tab 模拟；同 Tab 多实例本地补发排队 |
| `authority.browser.test.ts` | Browser | `syncMode: 'none' \| 'storage-authority'` 语义；`rev`-first 字段顺序；`onSync` 触发；lazy parse 快路径；rev 乱序丢弃；不可克隆值 / `QuotaExceededError` / localStorage 不可用的降级 |
| `authority-lifecycle.browser.test.ts` | Browser | `pageshow(e.persisted)` / `visibilitychange` 激活时 pull；bfcache 场景；`dispose` 后解绑 |
| `authority-persistence.browser.test.ts` | Browser | `persistence: 'session' \| 'persistent'` 三类启动场景（首个 Tab / 同会话组新开 / 刷新）+ 残留清空 + epoch 不匹配跳过 parse + 降级（sessionStorage / BroadcastChannel 不可用） |

每个文件的细粒度用例清单 + 断言快照在实施阶段随代码一并产出到 `__test__/README.md`，不在 RFC 中穷举。

## 风险与取舍

| 风险 | 说明 | 取舍 |
| --- | --- | --- |
| 非浏览器环境（Node/SSR） | 没有 `navigator.locks` / `BroadcastChannel` / `localStorage` | `id` 模式下降级为 LocalLockDriver + logger warn；`syncMode: 'storage-authority'` 下 `entry.authority === null`，同步失效，维持同进程共享语义 |
| `localStorage` 不可用（隐身 / 禁用 storage） | `StorageAuthority` 无法读写 | `entry.authority === null` + `logger.warn`，跨 Tab 同步失效但单 Tab 功能不受影响；所有跨 Tab 的 `onSync` 均不会触发 |
| 后台 Tab / bfcache / freeze 期间错过 `storage` 事件 | 窗口长期不可见或被冻结时无法收到 push | `pageshow` / `visibilitychange` 切回 visible 时主动 `getItem` + `readIfNewer`，自动补齐最新值 |
| `localStorage` 写入超配额（`QuotaExceededError`） | snapshot 过大或浏览器配额紧张 | `logger.warn` 提示 + 本地 commit 保持成功（本 Tab 的 `entry.data` 已更新）；跨 Tab 同步本次失效，下次 commit 重试覆盖 |
| `force` 抢占导致数据不一致 | 原持有者未完成事务就被驱逐 | **事务式 Draft 兜底：working copy 自动回滚，新 holder 永远拿到上一次成功 commit 的完整状态**；业务层可用 `listeners.onRevoked` 做补偿 |
| mutation log rollback 的开销 | 每次 set 需记录"旧值" + revoked 时回放 | 只记录实际写入路径，未触碰路径无开销；对大对象的浅路径写入无压力；极端场景可由业务通过 `read()` 自行做 snapshot-compare |
| 同 id 单例的 options 冲突 | 后续调用传入不一致的配置 | 首次注册为准 + `logger.warn`；listeners 独立保留不冲突 |
| 同 id 单例的 data 污染 | 不同模块对同一 id 调用但期望不同初始值 | 设计上"同 id = 同一份逻辑数据"，后续传入 initial 被忽略；业务应自己约定 id 命名空间 |
| 心跳间隔的取舍 | 过短耗电，过长响应慢 | 默认 200ms 心跳 + 3 次丢失判死，允许通过 constants 覆盖 |
| `holdTimeout` 误伤长事务 | 异步 recipe 耗时超过 5000ms 会被中断 | 用户可在每次 action 调用时覆盖；文档明示默认 5000；也可用 `NEVER_TIMEOUT` + `signal` 交由业务自行控制 |
| `syncMode: 'storage-authority'` 的一致性 | localStorage 是单点权威，读写顺序依赖锁串行化；写入方 Tab 不会收到自己的 `storage` 事件（规范） | 通过 `rev` 单调序号 + `lastAppliedRev` 去重；acquire 时 pull + storage 事件 push + 激活时 pull 三条路径协同，**保证"拿到锁 = 拿到最新值"**；`rev` 乱序到达时直接丢弃旧值不会回退 |
| `StorageAuthority` 的 `getItem` / `JSON.parse` 开销 | 每次 acquire + 每次 storage 事件都要读 localStorage | `localStorage.getItem` 亚毫秒级；**lazy parse 快路径**：按固化字段顺序用 `extractRev` 正则提取 rev，`rev <= lastAppliedRev` 时完全不 `JSON.parse` snapshot，绝大多数事件命中快路径 |
| localStorage value 格式契约 | 序列化顺序必须固化为 `rev → ts → epoch → snapshot`，否则 `extractRev` / `extractEpoch` 失效 | 由 `serialize` 函数手动拼接，不走 `JSON.stringify` 对象；`extractRev` 失败时走全量 `JSON.parse` 兜底，保证向后兼容 |
| `persistence: 'session'` 首次启动的 100ms 阻塞 | `session-probe` 探测窗口会推迟首个 Tab 的 `lockData` Promise resolve | 仅**首次启动**（sessionStorage 无 epoch 时）阻塞，默认 100ms；刷新 / bfcache 恢复直接继承 sessionStorage 跳过探测；可通过 `sessionProbeTimeout` 调整 |
| `persistence: 'session'` 的"会话组"判定依赖 BroadcastChannel | 不可用时无法识别"同会话组新开 Tab" | 降级为"首个 Tab"处理（清空 localStorage + 新 epoch）+ `logger.warn`；每个 Tab 各自独立但 localStorage 仍是权威，不影响数据正确性 |
| `sessionStorage` 不可用 | 极罕见，但隐身模式部分浏览器会禁用 | 自动降级 `persistence: 'session'` → `'persistent'` + `logger.warn`，跨会话恢复但不会丢数据 |
| session-probe 的消息竞态 | 多个 Tab 同时启动时相互探测，可能都收到响应都不做清空 | 正确行为：它们会收敛到**最早启动 Tab 的 epoch**（其他 Tab 探测时已有响应）；即便出现 2 个 Tab 互相都是"首个"，各自生成不同 epoch 也只有一方 commit 能被对方接受，`readIfNewer` epoch 校验会自动丢弃另一方的写入 → 最多损失一次 commit（由用户重试） |
| localStorage value 清理时机 | `persistence: 'session'` 下 Tab 关闭不会立即清 localStorage，只在下次首个 Tab 启动时清 | 可接受：浏览器未打开期间残留不影响任何运行时；避免依赖不可靠的 `beforeunload` |
| 队列公平性 | BroadcastDriver / StorageDriver 无法做到严格原子 FIFO | 允许极小概率并发抢锁；用 token 比较 + 重试兜底 |
| AbortSignal.any 兼容性 | 较老环境缺失 `AbortSignal.any` | 通过 `signal.ts` 的统一封装做 polyfill |
| 适配器语义契约依赖用户自律 | 用户注入的 `AuthorityAdapter.subscribe` 若不按"写入 / 删除均触发"实现，跨进程同步会失效；`ChannelAdapter.postMessage` 若丢消息，session-probe 会误判为"首个 Tab" | RFC 以接口 JSDoc 为准；内部不做行为探测；提供 `MemoryAdapter` 参考实现给测试与用户作对照；建议用户用 `memory-adapter.node.test.ts` 的用例集验证自己的实现 |
| 跨 Tab adapter 语义等价契约 | 同一 id 的多个 Tab 必须使用语义等价（能互相看到写入、互相收到订阅）的 authority / channel adapter，否则权威副本各自独立、同步失效 | 内部存储格式（rev → ts → epoch → snapshot）由 `serialize` 固化，不开放给 adapter；用户只需保证 "A 写 B 能读 / A 发 B 能收"，codec 由内部保证；跨不同底层（如 A 用 localStorage、B 用 IndexedDB）不互通为预期行为 |
| 默认实现与自定义 adapter 混用 | 一个 Tab 不传 `adapters`（走默认 localStorage）、另一个 Tab 注入自定义 Electron store，二者不互通 | 预期行为：同 id 的所有进程应采用一致策略；文档明示"要么全用默认，要么全用同一套自定义 adapter"；不做运行时检测 |

## 后续扩展（非本期）

- `syncMode: 'crdt'`：基于 CRDT 的冲突合并同步
- `syncMode: 'broadcast-channel'`：基于 BroadcastChannel 的实时推送通道（如需要比 `storage` 事件更低延迟的场景）
- React hook `useLockData(data, options)`
- Vue composable `useLockData(data, options)`
- DevTools：可视化当前所有锁的持有 / 等待队列
- 持久化：持有者崩溃后的数据恢复（配合 `create-storage-handler`）
- `actions.extend(ms)`：延长 `holdTimeout`

## 公开决策记录

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | API 形态 | `[readonly, actions]` 元组 |
| 2 | 初始化时机 | `lockData` 初始化恒同步，不抢锁；`getValue` 返回 Promise 或 `syncMode === 'storage-authority'` 时返回 Promise（后者需在 resolve 前完成 localStorage 首次 pull） |
| 3 | 抢锁时机 | 仅 `actions.update` / `replace` / `getLock` 时抢锁 |
| 4 | 只读 | 深只读强制执行，无开关 |
| 5 | 底层技术栈 | Web Locks（首选）→ BroadcastChannel（降级）→ localStorage（兜底）；`adapters.getLock` 存在时交由用户自定义 |
| 6 | `force` 归属 | 从 options 移到 `ActionCallOptions`，按调用传递 |
| 7 | `timeout` 语义 | options 层默认 5000；action 调用可拆 `acquireTimeout` / `holdTimeout` 覆盖；支持 `NEVER_TIMEOUT` 永不超时 |
| 8 | `getValue` | 可同步可异步，返回值决定 `lockData` 是否为 Promise；异步期间抢锁为"等待"语义 |
| 9 | `options.getLock`（**已被 #30 移入 `adapters.getLock`**） | 自定义锁驱动入口，覆盖默认能力检测；不再承担观察回调职责（语义不变，仅字段位置收敛到 `adapters`） |
| 10 | 事件回调 | 收敛到 `options.listeners`（`onLockStateChange` / `onRevoked` / `onSync`） |
| 11 | `NEVER_TIMEOUT` | 导出的 unique symbol，可用在 `timeout` / `acquireTimeout` / `holdTimeout` 任意位置 |
| 12 | `syncMode` | 语义收敛为"仅跨进程同步"；同进程同 id 始终共享；本期提供 `'none' \| 'storage-authority'`，CRDT 留给未来；非 `'none'` 时 `lockData` 返回 Promise（被 #28 最终定稿） |
| 13 | `actions.getLock` | 提供手动抢锁接口用于多步事务 |
| 14 | 测试文件 | `*.node.test.ts`（纯逻辑）+ `*.browser.test.ts`（浏览器 API）拆分存放于 `__test__/` |
| 15 | 文档位置 | `src/shared/lock-data/RFC.md` |
| 16 | 同 id 单例 | 进程内 `InstanceRegistry` 以 id 作 key，共享 data 引用与 driver；首次注册的 options 为准，冲突字段 `logger.warn`；listeners 不冲突，多实例 fanout；引用计数归零时销毁 Entry |
| 17 | `AbortSignal` 支持 | `LockDataOptions.signal` 控制实例生命周期（abort == dispose）；`ActionCallOptions.signal` 控制本次调用；两者"与"组合；新增 `LockAbortedError` |
| 18 | 事务式 Draft | 每次 `update` 内部建立 working copy + mutation log + validityRef；recipe 成功则视为 commit（已写入 data），recipe 失败/revoked/aborted 时按 mutation log 回滚到 recipe 开始前的状态；`replace` 走同样事务 |
| 19 | revoke 后 draft 行为 | 抛 `LockRevokedError`；闭包里的 draft 永久失效；同步 / 异步 recipe 行为一致 |
| 20 | Draft 实现 | **不引入 `immer` 依赖**，自研轻量可写代理（Proxy + validityRef + mutation log）；体积最小、可控性最高，且与 `ReadonlyView` 共享 `WeakMap<object, Proxy>` 缓存策略 |
| 21 | `listeners.onCommit` | 向用户暴露 `mutation log` 与 `snapshot`；仅 commit 成功时触发；mutations 深冻结，禁止外部 mutate；典型用途：审计、埋点、持久化、派生状态 |
| 22 | `dataReadyPromise` 共享 | 同 id 场景下由 `Entry` 统一持有；后续实例共享同一 Promise，不重复触发 `getValue`；`'failed'` 终态使所有共享实例一并进入 `LockDisposedError` |
| 23 | `syncStrategy`（**已被 #27 作废**） | 曾作为 `'on-acquire' \| 'broadcast-only'` 的 acquire 握手一致性开关；引入 localStorage 权威副本后，其全部职责（acquire 时同步最新值、首个 holder 兜底）由 `StorageAuthority` 覆盖，字段随 #27 一并删除 |
| 24 | 权威单调序号 `rev` | 引入 `Entry.rev` / `Entry.lastAppliedRev`；**采用递增整数而非时间戳**（`Date.now()` 可跨 Tab 回退，`performance.now()` 不同 Tab origin time 不同无法比较）；commit 成功时 `rev++`，写入权威副本；跨 Tab 以 `rev` 大者为最新；无 id 场景下 `rev` 也维护（仅作本 Tab 单调计数，不参与持久化） |
| 25 | `StorageAuthority`（localStorage 权威副本） | 用 `localStorage` 作为跨 Tab 数据同步的**单点权威**（key = `${LOCK_PREFIX}:${id}:latest`）；写路径：commit 后同步 `setItem`；读路径三条：acquire 时同步 `getItem` + `storage` 事件 push + `pageshow`/`visibilitychange` 主动 pull；写入方 Tab 不触发自己的 storage 事件（规范），通过 `lastAppliedRev` 做额外防御 |
| 26 | JSON 字符串存储 + Lazy Parse | localStorage value 固化格式 `{"rev":N,"ts":T,"snapshot":...}`；**字段顺序契约**：`rev` 必须首位；手动拼接而非 `JSON.stringify(obj)`（规范不保证字段顺序）；读路径先用 `extractRev` 正则提取 rev 做 `lastAppliedRev` 比较，命中"过时"时**完全跳过 `JSON.parse(snapshot)`**；`extractRev` 失败则走全量 parse 兜底。**曾评估的替代方案**：双层 JSON（外层对象 + snapshot 预先 `JSON.stringify` 成字符串字段）被否决，理由：① 写入需 2 次 stringify + 内层整串转义，体积膨胀 5-15%、更易撞 `QuotaExceededError`；② 读取 rev 必须先 `JSON.parse` 外层（复杂度 `O(整串长度)`），已等价甚至高于单层全量 parse，彻底丢失"快路径"；③ 应用时还要再 parse 内层，成本翻倍。单层 JSON + 正则 `extractRev` 才是真正的 lazy（快路径 `O(常数)`） |
| 27 | 删除 `syncStrategy` / `acquireSyncTimeout` / broadcast 握手协议 | localStorage 权威副本取代了 `sync-request` / `sync-response` 握手；`syncStrategy: 'broadcast-only'` 与 `storage` 事件 push 语义重复故删除；`acquireSyncTimeout` 不再需要（`getItem` 同步 + 亚毫秒）；`phase: 'syncing'` 状态机从 `onLockStateChange` 中移除；首个 holder 判定问题自然消失（localStorage 无该 key 即首个） |
| 28 | `syncMode` 枚举重命名 | `'holder-broadcast'` → `'storage-authority'`，名字语义对齐实现（localStorage 权威副本而非单向 broadcast）；RFC 未发布，非 breaking |
| 29 | `persistence` 字段 + epoch 探测 | 新增 `LockDataOptions.persistence: 'session' \| 'persistent'`，**默认 `'session'`**（符合"协作仅在多 Tab 活跃期"的直觉）；`'session'` 通过 `sessionStorage.${LOCK_PREFIX}:${id}:epoch` + `BroadcastChannel('${LOCK_PREFIX}:${id}:session')` 的 `session-probe` / `session-reply` 协议实现"所有 Tab 关闭即重置"；首次启动探测超时默认 `sessionProbeTimeout: 100ms`；localStorage 存储格式扩展为 `{"rev":N,"ts":T,"epoch":"xxx","snapshot":...}`（rev 仍首位兼容 lazy parse，新增 `extractEpoch` 快路径 epoch 过滤）；首个 Tab 判定为"所有 Tab 关闭后重启"时**主动 `removeItem` 清空 localStorage 权威副本**；`'persistent'` 固定 epoch 为常量 `'persistent'`、不做探测，保留跨会话持久化能力；`sessionStorage` 不可用时 `'session'` 降级为 `'persistent'` + `logger.warn` |
| 30 | 依赖倒置聚合到 `options.adapters` | 所有可外部化的环境依赖（锁驱动 / 权威副本 / 广播通道 / 会话存储 / 日志 / 克隆）收敛到 `options.adapters` 单一入口，替代原先平铺在 options 顶层的 `getLock`；每个字段可独立注入，缺省走默认实现（`pickDefaultAdapters` 组合）。**接口风格**：涉及 id 作用域的依赖（`getLock` / `getAuthority` / `getChannel` / `getSessionStore`）用工厂函数 `getXxx(ctx) => Adapter`，与原 `getLock` 对齐；无作用域的依赖（`logger` / `clone`）直接传实例。**设计原则**：① 单一入口减少 options 表面积；② 用户提供 > 默认实现 > null（触发降级）；③ 存储格式 codec 由内部固化不开放（跨 Tab 语义对齐由用户保证"A 写 B 能读"）；④ 语义正确性由提供方负责，内部不做行为探测。**收益**：彻底支持非浏览器环境（Node / SSR / RN / Electron / Worker）；单元测试可用内存 adapter 在 Node 跑完整链路，大幅精简浏览器集成测试；顺带关闭"是否引入自研深克隆工具"开放问题（用户可注入 `adapters.clone`）。**兼容性**：RFC 未发布，顶层 `getLock` 移入 `adapters.getLock` 非 breaking；决策 #9 相关描述更新但语义不变 |

## 开放问题

- `actions.extend(holdTimeout)` 是否本期就加？（当前倾向不加，作为扩展）

## 附录 A：完整接口索引

完整的 TypeScript 接口签名与 JSDoc 详情；正文字段说明指向此附录。

```ts
/**
 * 永不超时标记（导出为常量）
 * 用于 options.timeout / ActionCallOptions.{acquireTimeout,holdTimeout}
 */
export const NEVER_TIMEOUT: unique symbol

interface LockDataOptions<T extends object> {
  /**
   * 锁作用域标识
   * - 不传：仅实例内互斥，不加入单例注册表
   * - 传入字符串：双重语义
   *   1. **进程内单例键**：同进程内相同 id 的多次调用共享同一份 data 引用和同一个 driver
   *   2. **跨进程唯一标识**：启用跨 Worker / 跨同源 Tab 的互斥（自动拼接前缀作为 lock name）
   */
  id?: string

  /**
   * 默认超时时间（ms），actions 调用可单独覆盖
   * 默认 5000
   * 作用对象：
   *   1. 抢锁超时（等锁排队时）
   *   2. 持有超时（拿到锁后，recipe / replace 执行 + 持锁的最长时长）
   * 两者共用同一个默认值，actions 调用可通过 { acquireTimeout, holdTimeout } 拆开覆盖
   * 传入 NEVER_TIMEOUT 表示永不超时
   */
  timeout?: number | typeof NEVER_TIMEOUT

  /**
   * 跨上下文锁的底层实现模式
   * - 'auto'（默认）：优先 Web Locks，降级 BroadcastChannel，最后 storage token
   * - 'web-locks' | 'broadcast' | 'storage'：强制指定
   * 注意：若提供了 adapters.getLock（自定义锁驱动），则 mode 被忽略
   */
  mode?: 'auto' | 'web-locks' | 'broadcast' | 'storage'

  /**
   * 跨进程数据同步模式（同进程内始终共享同一份 data，与此选项无关）
   * - 'none'（默认）：**不跨进程同步**，跨 Tab / Worker 的 readonly 保持各自的本地值
   * - 'storage-authority'：以 localStorage 作为跨 Tab 权威副本
   *     - 每次 commit 成功后把 `{ rev, ts, epoch, snapshot }` 写入 `${LOCK_PREFIX}:${id}:latest`
   *     - 其他 Tab 通过 `storage` 事件接收并按 `rev` 去重后原地更新 `entry.data`
   *     - acquire 成功后额外同步 `getItem` + lazy parse 拉一次，保证"拿到锁 = 拿到最新值"
   *     - `pageshow` / `visibilitychange` 激活时主动 pull，覆盖 bfcache / freeze 期间丢失的消息
   * 注意：storage-authority 为覆盖式同步，并发合并依赖锁的串行化
   */
  syncMode?: 'none' | 'storage-authority'

  /**
   * 跨 Tab 权威副本的持久化策略（仅 syncMode === 'storage-authority' 生效）
   * - 'session'（默认）：会话级持久化。同会话组所有 Tab 关闭后，权威副本随下一次启动被重置，
   *                     新 Tab 从 `initial` / `getValue` 开始。通过 sessionStorage 维护 epoch，
   *                     Tab 启动时广播 session-probe 探测现有会话（默认 100ms 窗口）：
   *                       · 探测到响应 → 继承该 epoch，pull 权威副本（"同会话组新开 Tab"场景）
   *                       · 探测超时 → 视为首个 Tab，清空权威副本并生成新 epoch
   *                       · sessionStorage 中已有 epoch（刷新 / bfcache 恢复）→ 直接继承，跳过探测
   * - 'persistent'：长期持久化。localStorage 是单一真源，永不自动清空。
   *                 典型场景：跨日持久化的用户草稿、配置、长期协作文档等。
   */
  persistence?: 'session' | 'persistent'

  /**
   * 'session' 策略下的 session-probe 探测窗口（ms），默认 100
   * 仅首次启动（sessionStorage 无 epoch 时）会阻塞这么久；刷新 / bfcache 恢复不走探测
   */
  sessionProbeTimeout?: number

  /**
   * 自定义数据初始化函数
   * - 返回同步值 → lockData 同步返回
   * - 返回 Promise → lockData 返回 Promise，resolve 后 readonly 视图原地更新
   */
  getValue?: () => T | Promise<T>

  /**
   * 依赖倒置注入点：所有可外部化的环境依赖聚合在此
   * 未提供的字段走内部默认实现；详见「依赖倒置与适配器」章节
   */
  adapters?: LockDataAdapters

  /** 控制整个 lockData 实例生命周期的 abort 信号；aborted 等价于 dispose() */
  signal?: AbortSignal

  /** 事件回调收敛点，避免 options 平铺过多字段 */
  listeners?: LockDataListeners
}

interface LockDataAdapters {
  /** 自定义锁驱动；存在时覆盖默认能力检测 */
  getLock?: (ctx: LockAcquireContext) => Promise<LockHandle> | LockHandle
  /** 自定义权威副本存储（syncMode === 'storage-authority' 生效） */
  getAuthority?: (ctx: AuthorityContext) => AuthorityAdapter
  /** 自定义广播通道（session-probe / session-reply 用） */
  getChannel?: (ctx: ChannelContext) => ChannelAdapter
  /** 自定义会话级存储（存 epoch 用） */
  getSessionStore?: (ctx: SessionStoreContext) => SessionStoreAdapter
  /** 自定义日志（默认委托 shared/logger） */
  logger?: LoggerAdapter
  /** 自定义深克隆（默认 structuredClone + JSON fallback） */
  clone?: <V>(value: V) => V
}

interface AuthorityContext {
  /** 完整 localStorage key（已拼接前缀：`lingshu:lock-data:<id>:latest`） */
  key: string
  /** 锁作用域名（已拼接前缀：`lingshu:lock-data:<id>`） */
  name: string
  /** lockData 的 id（未拼接前缀） */
  id: string
}

interface ChannelContext {
  /** 通道名（已拼接前缀，如 `lingshu:lock-data:<id>:session`） */
  name: string
  /** 通道用途 */
  purpose: 'session-probe'
  /** lockData 的 id */
  id: string
}

interface SessionStoreContext {
  /** 完整 key（已拼接前缀：`lingshu:lock-data:<id>:epoch`） */
  key: string
  /** lockData 的 id */
  id: string
}

interface LockAcquireContext {
  /** 锁作用域名（已拼接前缀） */
  name: string
  /** 请求方唯一 token（与 actions.token 对应） */
  token: string
  /** 抢锁来源 */
  source: 'update' | 'replace' | 'getLock'
  /** 抢锁超时（ms 或 NEVER_TIMEOUT） */
  acquireTimeout: number | typeof NEVER_TIMEOUT
  /** 持锁超时（ms 或 NEVER_TIMEOUT） */
  holdTimeout: number | typeof NEVER_TIMEOUT
  /** 是否强制抢占 */
  force: boolean
  /** 外部 abort 信号（dispose / revoked 时触发） */
  signal: AbortSignal
}

interface LockHandle {
  /** 释放锁；lockData 内部会在每次 action 完成 / dispose 时调用 */
  release: () => Promise<void> | void
  /** driver 主动驱逐当前持有者时调用；内部会把 isHolding 置 false 并触发 onRevoked */
  onRevokedByDriver?: (cb: (reason: 'force' | 'timeout') => void) => void
}

interface LockDataListeners<T extends object = object> {
  /** 锁状态机阶段：waiting / acquired / released / rejected */
  onLockStateChange?: (event: LockStateEvent) => void
  /** 锁被外部驱逐（force / timeout / dispose） */
  onRevoked?: (reason: 'force' | 'dispose' | 'timeout') => void
  /** recipe 成功 commit 后触发；携带 mutation log + snapshot + rev */
  onCommit?: (event: LockCommitEvent<T>) => void
  /** 收到其他进程的权威副本更新时触发（仅 syncMode === 'storage-authority'） */
  onSync?: (event: LockSyncEvent<T>) => void
}

interface LockCommitEvent<T extends object> {
  source: 'update' | 'replace'
  token: string
  /** 本次 commit 后的权威单调序号 */
  rev: number
  /** 本次变更的最小路径集（只读深冻结） */
  readonly mutations: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>
    readonly op: 'set' | 'delete'
    readonly value?: unknown
  }>
  /** commit 后的完整快照（经 adapters.clone 产生） */
  readonly snapshot: Readonly<T>
}

interface LockSyncEvent<T extends object> {
  source: 'pull-on-acquire' | 'storage-event' | 'pageshow' | 'visibilitychange'
  rev: number
  readonly snapshot: Readonly<T>
}

interface LockStateEvent {
  source: 'update' | 'replace' | 'getLock'
  phase: 'waiting' | 'acquired' | 'released' | 'rejected'
  reason?: 'timeout' | 'revoked' | 'disposed'
  token: string
  /** 本次排队 → 获取的耗时（acquired / rejected 时存在，ms） */
  waitedMs?: number
}

// Adapter 接口签名（完整 JSDoc 见「依赖倒置与适配器」章节）
interface AuthorityAdapter {
  read(): string | null
  write(raw: string): void
  remove(): void
  subscribe(onExternalUpdate: (newValue: string | null) => void): () => void
}

interface ChannelAdapter {
  postMessage(message: unknown): void
  subscribe(onMessage: (message: unknown) => void): () => void
  close(): void
}

interface SessionStoreAdapter {
  read(): string | null
  write(value: string): void
}

interface LoggerAdapter {
  warn(message: string, ...extras: unknown[]): void
  error(message: string, ...extras: unknown[]): void
  debug?(message: string, ...extras: unknown[]): void
}

type CloneFn = <V>(value: V) => V
```

## 附录 B：完整示例集

正文「使用示例」仅保留最常用的 6 个核心场景；此处汇总状态观察、审计、跨端适配、单元测试等高级示例。

### 观察抢锁过程（listeners.onLockStateChange）

```ts
lockData(data, {
  id: 'k',
  listeners: {
    onLockStateChange: (evt) => {
      if (evt.phase === 'waiting') showLoading()
      if (evt.phase === 'acquired') hideLoading(`waited ${evt.waitedMs}ms`)
      if (evt.phase === 'rejected') toast(`lock failed: ${evt.reason}`)
    },
    onRevoked: (reason) => toast(`lock revoked: ${reason}`),
    onSync: (evt) => console.log('received remote update', evt.snapshot),
  },
})
```

### 审计 commit（listeners.onCommit）

```ts
lockData(data, {
  id: 'audit',
  listeners: {
    onCommit: ({ source, token, mutations, snapshot }) => {
      // mutations：本次变更的最小路径集（只读深冻结）
      // [{ path: ['user', 'name'], op: 'set', value: 'cmt' }]
      auditLogger.push({
        at: Date.now(),
        by: token,
        action: source,
        changes: mutations,
      })
      // snapshot：commit 后的完整快照（经 adapters.clone 产生，可安全持久化）
      persistToStorage(snapshot)
    },
  },
})
```

### 自定义日志与克隆（adapters.logger + adapters.clone）

```ts
import { lockData } from '@cmtlyt/lingshu-toolkit/shared'
import cloneDeep from 'lodash/cloneDeep'
import * as Sentry from '@sentry/browser'

const [view, actions] = lockData(initialData, {
  id: 'editor',
  syncMode: 'storage-authority',
  adapters: {
    logger: {
      warn: (message, ...extras) => Sentry.captureMessage(message, { level: 'warning', extra: { extras } }),
      error: (message, ...extras) => Sentry.captureException(new Error(message), { extra: { extras } }),
    },
    // 数据含 Map / Date / class instance，structuredClone 的 JSON fallback 会丢信息
    // 用 lodash.cloneDeep 保留原型与特殊类型
    clone: <V,>(value: V) => cloneDeep(value),
  },
})
```

### Electron 主进程广播适配（自定义 authority + channel）

```ts
import { lockData } from '@cmtlyt/lingshu-toolkit/shared'
import type { AuthorityAdapter, ChannelAdapter } from '@cmtlyt/lingshu-toolkit/shared'
import { ipcRenderer } from 'electron'

function createElectronAuthority(ctx: { key: string }): AuthorityAdapter {
  return {
    read: () => ipcRenderer.sendSync('lockData:read', ctx.key),
    write: (raw) => ipcRenderer.send('lockData:write', ctx.key, raw),
    remove: () => ipcRenderer.send('lockData:remove', ctx.key),
    subscribe: (onExternalUpdate) => {
      const handler = (_: unknown, key: string, newValue: string | null) => {
        if (key === ctx.key) onExternalUpdate(newValue)
      }
      ipcRenderer.on('lockData:update', handler)
      return () => ipcRenderer.off('lockData:update', handler)
    },
  }
}

function createElectronChannel(ctx: { name: string }): ChannelAdapter {
  return {
    postMessage: (message) => ipcRenderer.send('lockData:broadcast', ctx.name, message),
    subscribe: (onMessage) => {
      const handler = (_: unknown, channel: string, message: unknown) => {
        if (channel === ctx.name) onMessage(message)
      }
      ipcRenderer.on('lockData:broadcast', handler)
      return () => ipcRenderer.off('lockData:broadcast', handler)
    },
    close: () => { /* ipcRenderer 由主进程管理，无需单独 close */ },
  }
}

const [view, actions] = await lockData({ shared: null as unknown as SharedState }, {
  id: 'app:shared',
  syncMode: 'storage-authority',
  persistence: 'persistent',
  adapters: {
    getAuthority: createElectronAuthority,
    getChannel: createElectronChannel,
  },
})
// 多个 BrowserWindow 之间通过主进程 IPC 广播达成跨窗口同步，跳过 localStorage 限制
```

### 单元测试内存适配器（脱离浏览器环境跑完整链路）

```ts
import { lockData } from '@cmtlyt/lingshu-toolkit/shared'
import type { AuthorityAdapter, ChannelAdapter, SessionStoreAdapter } from '@cmtlyt/lingshu-toolkit/shared'

function createMemoryAdapters(scope: Map<string, string>, bus: Map<string, Set<(msg: unknown) => void>>) {
  const subsByKey = new Map<string, Set<(v: string | null) => void>>()

  const getAuthority = (ctx: { key: string }): AuthorityAdapter => ({
    read: () => scope.get(ctx.key) ?? null,
    write: (raw) => {
      scope.set(ctx.key, raw)
      subsByKey.get(ctx.key)?.forEach((cb) => cb(raw))
    },
    remove: () => {
      scope.delete(ctx.key)
      subsByKey.get(ctx.key)?.forEach((cb) => cb(null))
    },
    subscribe: (cb) => {
      const set = subsByKey.get(ctx.key) ?? new Set()
      set.add(cb)
      subsByKey.set(ctx.key, set)
      return () => set.delete(cb)
    },
  })

  const getChannel = (ctx: { name: string }): ChannelAdapter => ({
    postMessage: (msg) => bus.get(ctx.name)?.forEach((cb) => cb(msg)),
    subscribe: (cb) => {
      const set = bus.get(ctx.name) ?? new Set()
      set.add(cb)
      bus.set(ctx.name, set)
      return () => set.delete(cb)
    },
    close: () => {},
  })

  const getSessionStore = (ctx: { key: string }): SessionStoreAdapter => {
    const sessionScope = new Map<string, string>()
    return {
      read: () => sessionScope.get(ctx.key) ?? null,
      write: (v) => sessionScope.set(ctx.key, v),
    }
  }

  return { getAuthority, getChannel, getSessionStore }
}

// 测试里：多个 Tab 共享同一套 memory adapters，在 Node 环境下跑通 session-probe 全链路
const storage = new Map<string, string>()
const bus = new Map<string, Set<(msg: unknown) => void>>()
const adapters = createMemoryAdapters(storage, bus)

const [viewA, actA] = await lockData({ count: 0 }, { id: 't', syncMode: 'storage-authority', adapters })
const [viewB] = await lockData({ count: 0 }, { id: 't', syncMode: 'storage-authority', adapters })

await actA.update((d) => { d.count = 1 })
expect(viewB.count).toBe(1)  // authority.subscribe 同步触达
```

---

> 评审通过后，在此文件末尾追加 "Accepted on YYYY/MM/DD" 并开始实施。
