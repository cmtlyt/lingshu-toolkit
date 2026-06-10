# RFC: stateMachine — 通用状态机

> status: accepted
>
> author: cmtlyt
>
> create time: 2026/06/08 17:33:00
>
> rfc version: 0.1.0
>
> scope: `src/shared/state-machine`

## 版本历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 0.1.0 | 2026/06/08 | 初稿：核心状态机引擎、表驱动配置、Guard/Action/生命周期、事件队列、防御性编程 |

## 背景与动机

在前端和后端应用中，许多业务逻辑本质上是**状态流转**：表单多步提交、播放器控制、WebSocket 连接管理、审批流程、游戏角色行为等。开发者常使用 `if-else` 或 `switch-case` 硬编码这些逻辑，导致：

- **状态爆炸**：随着状态和事件增多，代码复杂度呈指数增长
- **隐式状态**：状态散落在多个变量中，难以追踪和调试
- **难以维护**：新增状态或事件需要修改大量分支逻辑
- **不可视化**：无法直观理解系统的完整状态流转图

通用状态机（Finite State Machine）通过**配置与逻辑分离**（表驱动法），将状态流转规则从业务代码中抽离为声明式配置，由引擎统一执行。这带来了：

- **可预测性**：所有合法的状态转换都显式定义，不存在"意外状态"
- **可视化**：配置表可自动导出为 Mermaid / Graphviz 状态图
- **可测试性**：状态流转逻辑与副作用分离，易于单元测试
- **可持久化**：当前状态和上下文可序列化存储，支持恢复

## 目标与非目标

### 目标

- 提供 `createStateMachine<TStates, TEvents, TContext>(config)` 单入口
- **表驱动**：通过声明式配置定义状态、事件、转换规则，禁止硬编码分支
- **Guard（守卫）**：支持转换条件判断，决定事件是否允许触发转换
- **Action（动作）**：支持 `onExit` → `onTransition` → `onEntry` 完整生命周期钩子
- **Context（上下文）**：提供独立的上下文对象在 Guard 和 Action 间传递，保持引擎纯粹性
- **事件队列**：引入 Event Queue 防止 Action 中触发新事件导致递归，保证事件串行执行
- **防御性编程**：未定义事件的处理策略，提供 `onUnhandledEvent` 全局钩子

### 非目标

- **不**实现定时器/延时事件（调用方可通过 `setTimeout` + `trigger` 自行实现）
- **不**实现与特定框架（React/Vue）的绑定（留给 `react/` `vue/` 命名空间封装）
- **不**实现网络通信或远程状态同步
- **不**实现状态机的图形化编辑器

## 名词约定

| 名词 | 含义 |
| --- | --- |
| State（状态） | 系统的当前处境，如 `idle`、`running`、`error` |
| Event（事件） | 促使状态改变的触发动作，如 `CLICK`、`TIMEOUT`、`FETCH` |
| Transition（转换） | 从 State A 到 State B 的映射规则 |
| Guard（守卫） | 布尔函数，决定当前事件是否允许触发转换 |
| Action（动作） | 转换发生时执行的副作用回调 |
| Context（上下文） | 在 Guard 和 Action 间传递的数据载体 |
| EventQueue（事件队列） | 事件的 FIFO 缓冲队列，保证串行处理 |

## 核心设计原则

### 1. 配置与逻辑分离（表驱动法）

状态流转规则通过声明式配置表定义，引擎是无状态的执行器：

```ts
const config = {
  initial: 'idle',
  states: {
    idle: {
      on: {
        FETCH: { target: 'loading', guard: 'canFetch', action: 'startFetch' },
      },
    },
    loading: {
      on: {
        SUCCESS: { target: 'success' },
        FAILURE: { target: 'error' },
      },
    },
    // ...
  },
}
```

### 2. 事件队列（防止递归）

`trigger()` 方法不直接执行转换，而是将事件推入队列，由统一的事件循环串行消费：

```text
trigger(event) → enqueue(event) → loop: dequeue → resolve transition → execute guards → execute actions → update state
```

这确保了：
- Action 中可安全调用 `trigger()` 而不会栈溢出
- 事件处理顺序可预测（FIFO）
- 便于调试和日志记录

### 3. Context 隔离

状态机不直接操作外部变量。所有业务数据通过 Context 对象传递：

```ts
const machine = createStateMachine({
  context: { retryCount: 0, data: null },
  // Guard 和 Action 通过参数接收 context
})
```

## API 设计

### 入口函数

```ts
function createStateMachine<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean = false,
>(config: StateMachineConfig<TStates, TEvents, TContext, TAsync>): StateMachine<TStates, TEvents, TContext, TAsync>
```

### 配置项

```ts
interface StateMachineConfig<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>, TAsync extends boolean = false> {
  /** 初始状态 */
  initial: TStates

  /** 初始上下文数据 */
  context: TContext

  /**
   * 是否启用异步模式
   * - false（默认）：Guard / Action 必须同步，trigger() 返回 boolean
   * - true：Guard / Action 允许返回 Promise，trigger() 返回 Promise<boolean>
   */
  async?: TAsync

  /** 状态定义表 */
  states: Record<TStates, StateNode<TStates, TEvents, TContext>>

  /**
   * 具名 Guard 函数注册表
   * 在 Transition 中通过字符串名引用
   */
  guards?: Record<string, GuardFn<TContext, TAsync>>

  /**
   * 具名 Action 函数注册表
   * 在 Transition / StateNode 中通过字符串名引用
   */
  actions?: Record<string, ActionFn<TContext, TAsync>>

  /**
   * 未处理事件的全局钩子
   * 当前状态没有对应事件的转换规则时触发
   * 不提供则默认静默忽略
   */
  onUnhandledEvent?: (state: TStates, event: TEvents, context: TContext) => void

  /**
   * 引擎运行时配置
   * 收敛防御性参数及后续扩展配置，避免 options 平铺过多字段
   */
  settings?: StateMachineSettings
}
```

### 状态节点

```ts
interface StateNode<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>, TAsync extends boolean = false> {
  /**
   * 事件 → 转换规则映射
   * 值可以是单个 Transition 或 Transition 数组（按顺序匹配第一个 Guard 通过的）
   */
  on?: Partial<Record<TEvents, TransitionConfig<TStates, TContext, TAsync> | Array<TransitionConfig<TStates, TContext, TAsync>>>>

  /** 进入该状态时执行的 Action（字符串名或内联函数） */
  onEntry?: ActionRef<TContext, TAsync> | Array<ActionRef<TContext, TAsync>>

  /** 离开该状态时执行的 Action（字符串名或内联函数） */
  onExit?: ActionRef<TContext, TAsync> | Array<ActionRef<TContext, TAsync>>

  /** 标记为最终状态，进入后不再响应任何事件 */
  final?: boolean
}
```

### 转换配置

```ts
interface TransitionConfig<TStates extends string, TContext extends Record<string, unknown>, TAsync extends boolean = false> {
  /** 目标状态；省略表示自转换（不切换状态，仅执行 Action） */
  target?: TStates

  /**
   * 守卫条件（字符串名或内联函数）
   * 返回 false 则该转换不触发，继续匹配下一条规则
   */
  guard?: string | GuardFn<TContext, TAsync>

  /** 转换过程中执行的 Action（在 onExit 之后、onEntry 之前） */
  action?: ActionRef<TContext, TAsync> | Array<ActionRef<TContext, TAsync>>
}

/** Guard 函数签名：async 模式下允许返回 Promise */
type GuardFn<TContext, TAsync extends boolean = false> =
  TAsync extends true
    ? (context: Readonly<TContext>, event: EventPayload) => boolean | Promise<boolean>
    : (context: Readonly<TContext>, event: EventPayload) => boolean

/** Action 函数签名：async 模式下允许返回 Promise */
type ActionFn<TContext, TAsync extends boolean = false> =
  TAsync extends true
    ? (context: TContext, event: EventPayload) => void | Promise<void>
    : (context: TContext, event: EventPayload) => void

/** Action 引用：字符串名（指向 actions 注册表）或内联函数 */
type ActionRef<TContext, TAsync extends boolean = false> = string | ActionFn<TContext, TAsync>

/** 事件载荷 */
interface EventPayload {
  type: string
  [key: string]: unknown
}

/** 引擎运行时配置 */
interface StateMachineSettings {
  /**
   * 事件队列最大长度
   * 超过时丢弃新事件并触发警告
   * @default 100
   */
  maxQueueSize?: number

  /**
   * 同一事件在同一状态下连续触发次数阈值
   * 超过时中断事件循环并报错，防止无限循环
   * @default 10
   */
  maxCyclicCount?: number
}
```

### 返回值：StateMachine 实例

```ts
interface StateMachine<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>, TAsync extends boolean = false> {
  /**
   * 触发事件
   * 事件入队后由内部事件循环串行处理
   *
   * @param event - 包含 type 和可选额外数据的 EventPayload 对象
   * @returns async 模式返回 Promise<boolean>，同步模式直接返回 boolean
   */
  trigger(event: EventPayload): TAsync extends true ? Promise<boolean> : boolean

  /** 获取当前状态 */
  getState(): TStates

  /** 获取当前上下文的只读快照 */
  getContext(): Readonly<TContext>

  /** 判断当前状态是否匹配给定状态 */
  matches(state: TStates): boolean

  /**
   * 获取当前状态下可触发的所有事件列表
   * 不考虑 Guard 条件
   */
  getAvailableEvents(): TEvents[]

  /**
   * 订阅状态变更
   * @returns 取消订阅函数
   */
  subscribe(listener: StateMachineListener<TStates, TContext>): () => void

  /** 销毁状态机，清理事件队列和订阅 */
  dispose(): void
}
```

### 辅助类型

```ts
interface StateMachineListener<TStates extends string, TContext extends Record<string, unknown>> {
  (event: StateChangeEvent<TStates, TContext>): void
}

interface StateChangeEvent<TStates extends string, TContext extends Record<string, unknown>> {
  /** 转换前的状态 */
  from: TStates
  /** 转换后的状态 */
  to: TStates
  /** 触发转换的事件 */
  event: EventPayload
  /** 转换后的上下文 */
  context: Readonly<TContext>
}

```

## 防御性编程

### 未定义事件处理

```ts
createStateMachine({
  // ...
  onUnhandledEvent: (state, event, context) => {
    console.warn(`Unhandled event "${event}" in state "${state}"`)
    // 可选：发送到监控系统
  },
})
```

### 事件队列防护

通过 `settings` 配置项控制：

- `settings.maxQueueSize`（默认 100）：事件队列最大长度，超过时丢弃新事件并触发警告
- `settings.maxCyclicCount`（默认 10）：同一事件在同一状态下连续触发次数阈值，超过时中断事件循环并报错，防止无限循环

## 使用示例

### 基础用法：交通信号灯

```ts
import { createStateMachine } from '@cmtlyt/lingshu-toolkit/shared'

const trafficLight = createStateMachine({
  initial: 'red',
  context: { count: 0 },
  states: {
    red: {
      on: { TIMER: { target: 'green' } },
      onEntry: (ctx) => { ctx.count++ },
    },
    green: {
      on: { TIMER: { target: 'yellow' } },
    },
    yellow: {
      on: { TIMER: { target: 'red' } },
    },
  },
})

await trafficLight.trigger({ type: 'TIMER' }) // red → green
await trafficLight.trigger({ type: 'TIMER' }) // green → yellow
await trafficLight.trigger({ type: 'TIMER' }) // yellow → red, count = 2
```

### Guard + Action：ATM 取款

```ts
const atm = createStateMachine({
  initial: 'idle',
  context: { balance: 1000, amount: 0 },
  states: {
    idle: {
      on: { INSERT_CARD: { target: 'cardInserted' } },
    },
    cardInserted: {
      on: {
        ENTER_AMOUNT: [
          { target: 'dispensing', guard: 'hasSufficientFunds', action: 'deductBalance' },
          { target: 'insufficientFunds' },
        ],
        CANCEL: { target: 'idle' },
      },
    },
    dispensing: {
      on: { DONE: { target: 'idle' } },
      onEntry: 'dispenseAction',
    },
    insufficientFunds: {
      on: { RETRY: { target: 'cardInserted' }, CANCEL: { target: 'idle' } },
    },
  },
  guards: {
    hasSufficientFunds: (ctx, event) => ctx.balance >= (event.amount as number),
  },
  actions: {
    deductBalance: (ctx, event) => { ctx.balance -= event.amount as number },
    dispenseAction: (ctx) => { console.log(`Dispensing... Remaining: ${ctx.balance}`) },
  },
})

await atm.trigger({ type: 'INSERT_CARD' })
await atm.trigger({ type: 'ENTER_AMOUNT', amount: 500 })
// Guard 通过 → dispensing, balance = 500
```

### 状态变更监听

```ts
const unsubscribe = machine.subscribe((event) => {
  console.log(`${event.from} → ${event.to} (via ${event.event.type})`)
})

// 不再需要时取消订阅
unsubscribe()
```

## 实现要点

### 事件循环（Event Loop）

```
┌─────────────┐
│ trigger(evt) │
└──────┬──────┘
       ▼
┌──────────────┐
│ eventQueue   │◄── Action 中的 trigger() 也入队
│ [evt1, evt2] │
└──────┬───────┘
       ▼
┌──────────────────────────────┐
│ loop (while queue not empty) │
│  1. dequeue event            │
│  2. lookup transition        │
│  3. evaluate guards          │
│  4. execute onExit actions   │
│  5. execute transition action│
│  6. update current state     │
│  7. execute onEntry actions  │
│  8. notify subscribers       │
└──────────────────────────────┘
```

## 开放问题

- `trigger()` 返回 `Promise<boolean>` 还是更丰富的 `Promise<TransitionResult>` 对象？

## 后续规划（本期不做）

以下特性作为后续版本的扩展方向，本期不实现，仅记录设计思路供后续迭代参考。

### 1. 层次状态机（Hierarchical State Machine, HSM）

现实业务中，状态往往有包含关系（比如"开机"状态下包含"待机"和"工作"）。

- **思路**：为 `StateNode` 增加 `initial` + `states` 子状态定义。如果当前子状态没有处理某个 Event，则向上冒泡到父状态去寻找处理规则
- **状态路径**：用 `.` 分隔层级，如 `on.playing`。`getState()` 返回最深层的完整路径
- **冒泡规则**：子状态优先 → 父状态 → 根状态 → `onUnhandledEvent`
- **API 影响**：`StateNode` 新增 `initial?` / `states?` 字段；`getState()` 返回值从 `TStates` 改为 `string`；`matches(state)` 支持层次匹配（`matches('on')` 在 `on.playing` 时返回 `true`）

### 2. 并发状态（Orthogonal States）

允许系统同时处于多个独立的状态区域（例如：智能音箱同时在"播放音乐"和"蓝牙已连接"两个状态）。

- **思路**：为 `StateNode` 增加 `regions` 字段，定义多个独立的状态区域。`regions` 和 `states` 互斥
- **事件分发**：事件广播到所有活跃区域，每个区域独立计算转换，Action 按区域定义顺序依次执行
- **API 影响**：新增 `RegionConfig` 接口；新增 `getActiveStates(): string[]` 方法

### 3. 持久化与恢复（Serialization）

通用状态机必须能够被序列化存入数据库（如 localStorage / Redis / MySQL），并在重启后恢复。

- **思路**：状态机引擎本身不保存业务数据，只保存 `currentState` 和 `context`。提供 `exportState()` 和 `restoreState()` 方法
- **约束**：Context 必须是 JSON 安全的（无 Function / Symbol / 循环引用）；`restoreState()` 需校验 snapshot 中的 state 是否存在于配置表
- **API 影响**：新增 `StateMachineSnapshot<TContext>` 类型；`StateMachine` 新增 `exportState()` / `restoreState()` 方法

### 4. 可视化导出（Visualization）

状态机最大的痛点是"状态爆炸"后人类无法理解。

- **思路**：提供 `toMermaid()` 和 `toDot()` 方法，将内部配置表自动转换为 Mermaid 语法或 Graphviz DOT 语言，一键生成状态流转图
- **API 影响**：`StateMachine` 新增 `toMermaid(): string` / `toDot(): string` 方法

### 5. 副作用与生命周期管理增强

在基础的 `onEntry` / `onExit` / `onTransition` 之上，提供更完整的生命周期钩子。

- **思路**：支持 `onEntry` 返回清理函数（类似 React useEffect），离开状态时自动调用；可用于启动/清理定时器等资源

## 附录 A：完整接口索引

见上方「API 设计」章节，所有 TypeScript 接口签名已内联。

---

## 评审通过记录

**Accepted on 2026/06/08**

- **评审版本**：0.1.0
- **评审通过方**：@cmtlyt（仓库所有者 / RFC 作者）
- **后续动作**：进入实施阶段，详见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)
