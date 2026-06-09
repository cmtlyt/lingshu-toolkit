# State Machine 演进路线图

> 作者：cmtlyt
> 日期：2026/06/09
> 状态：规划中

本文档记录 `createStateMachine` 的中长期演进方向，为后续创建具体 RFC 提供参考。

---

## 一、进阶特性规划

### 1. 层次状态机（HSM, Hierarchical State Machine）

现实业务中，状态往往有包含关系（如"开机"状态下包含"待机"和"工作"）。

- **思路**：为 State 增加 `parent` 属性。如果当前状态没有处理某个 Event，则向上冒泡到父状态去寻找处理规则
- **复杂度**：高
- **优先级**：⭐⭐⭐

### 2. 正交/并发状态（Orthogonal States）

允许系统同时处于多个独立的状态区域（例如：智能音箱同时在"播放音乐"和"蓝牙已连接"两个状态）。

- **思路**：将单一 `currentState` 改为 `currentStates: string[]`，事件触发时并行计算多个状态区域的流转
- **复杂度**：高
- **优先级**：⭐⭐

### 3. 副作用与生命周期管理（Lifecycle Hooks）

提供完整的生命周期钩子，而非仅在 Transition 上挂载 Action：

- `onEntry(state)`：进入状态时执行（如启动定时器）
- `onExit(state)`：离开状态时执行（如清理资源）
- `onTransition(event)`：转换过程中执行

> **当前状态**：`onEntry` 和 `onExit` 已在 v0.8.0 实现。`onTransition` 可通过 `subscribe` 实现。后续考虑是否需要更细粒度的钩子。

- **复杂度**：低
- **优先级**：⭐

### 4. 持久化与恢复（Serialization）

通用状态机必须能够被序列化存入存储（如 localStorage / IndexedDB），并在重启后恢复。

- **思路**：状态机引擎本身不保存业务数据，只保存 `currentState` 和 `context`。提供 `exportState()` 和 `restoreState()` 方法
- **复杂度**：中
- **优先级**：⭐⭐⭐

### 5. 可视化导出（Visualization）

状态机最大的痛点是"状态爆炸"后人类无法理解。

- **思路**：提供 `toMermaid()` 或 `toDot()` 方法，将内部配置自动转换为 Mermaid 语法或 Graphviz DOT 语言，一键生成状态流转图
- **复杂度**：中
- **优先级**：⭐⭐

---

## 二、避坑指南（已实现的防御机制）

以下是设计状态机时的关键注意事项，**当前版本已全部覆盖**：

### ✅ 避免 Action 中触发事件导致无限递归

- **问题**：在 action 回调中再次调用 `trigger()`，容易导致死循环或栈溢出
- **已实现**：引入事件队列（Event Queue），`trigger` 将事件推入队列串行执行；通过 `maxCyclicCount` 限制循环次数（默认 10）

### ✅ Context 的传递

- **问题**：状态机不应该直接操作外部变量
- **已实现**：设计了 `context` 对象，作为参数在 Guard 和 Action 中传递，保持引擎纯粹性

### ✅ 防御性编程——未定义事件处理

- **问题**：必须处理"未定义事件"（Unknown Event）
- **已实现**：提供全局 `onUnhandledEvent` 钩子；final 状态自动拒绝所有事件

---

## 三、实施优先级建议

| 阶段 | 特性 | 预估复杂度 |
|------|------|-----------|
| **Phase 1** | 持久化与恢复 | 中 |
| **Phase 2** | 可视化导出（Mermaid） | 中 |
| **Phase 3** | 层次状态机（HSM） | 高 |
| **Phase 4** | 正交/并发状态 | 高 |

> 每个特性实施前应先创建独立 RFC（位于 `__docs__/rfcs/` 下，按递归编号规则命名），经评审后再开始实施。
