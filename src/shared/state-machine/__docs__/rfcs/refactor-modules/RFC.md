# RFC：stateMachine 模块拆分

> 状态：accepted
> 作者：cmtlyt
> 日期：2026/06/09
> 关联：[RFC.md](./RFC.md)

## 背景

当前 `createStateMachine` 的全部实现（538 行）集中在 `index.ts` 单文件中，包含类型定义、辅助函数、队列逻辑、API 构建和工厂函数。随着后续迭代（HSM、并发状态等），单文件会越来越难维护。

参考项目中已有的模块拆分实践：

- `history-tree`：`types.ts` + `core.ts` + `index.ts`（仅 re-export）
- `lock-data`：`types.ts` + `constants.ts` + `core/` + `adapters/` + `errors/` + `index.ts`

## 目标

将 `index.ts` 按职责拆分为独立模块文件，每个文件职责单一、行数可控（< 150 行），入口文件仅做 re-export。

## 拆分方案

### 目标文件结构

```
src/shared/state-machine/
├── types.ts              # 所有类型定义（~90 行）
├── helpers.ts            # 基础辅助函数（~80 行）
├── engine.ts             # 核心引擎：事件处理、转换执行（~120 行）
├── factory.ts            # createStateMachine 工厂函数（~80 行）
├── index.ts              # 仅 re-export（~10 行）
├── index.node.test.ts
├── index.mdx
└── __docs__/
```

### 各文件职责

#### `types.ts`（~90 行）

所有类型和接口定义，行内 export：

- `EventPayload`
- `StateMachineSettings`
- `GuardFn`、`ActionFn`、`ActionRef`
- `TransitionConfig`、`StateNode`、`StateMachineConfig`
- `StateChangeEvent`、`StateMachineListener`、`StateMachine`
- `InternalState`（内部类型，不在 index 中 re-export）
- `Registries`（内部类型，不在 index 中 re-export）

#### `helpers.ts`（~80 行）

无状态的纯辅助函数，行内 export：

- `FN_NAME` 常量
- `resolveActionRefs()` — 解析 action 引用
- `resolveGuard()` — 解析 guard 引用
- `getCandidates()` — 获取转换候选列表
- `checkCyclic()` — 循环检测
- `notifyListeners()` — 通知订阅者
- `runActionsSync()` / `runActionsAsync()` — 执行 action 数组
- `enqueueOrWarn()` — 入队或溢出警告

#### `engine.ts`（~120 行）

核心事件处理引擎，行内 export：

- `executeTransitionSync()` / `executeTransitionAsync()` — 执行完整转换流程
- `processEventSync()` / `processEventAsync()` — 处理单个事件
- `drainSyncQueue()` / `drainAsyncQueue()` — 队列排空
- `buildMachineApi()` — 构建返回的 API 对象

#### `factory.ts`（~80 行）

工厂函数，行内 export：

- `createStateMachine()` — 配置解析、校验、初始化、组装

#### `index.ts`（~10 行）

仅做 re-export，末尾集中导出：

```ts
export type { EventPayload, StateMachineConfig, ... } from './types';
export { createStateMachine } from './factory';
```

### 依赖关系

```
index.ts
  └── factory.ts
        ├── types.ts
        ├── helpers.ts
        └── engine.ts
              ├── types.ts
              └── helpers.ts
```

单向依赖，无循环。

## 实施步骤

- [ ] 1. 创建 `types.ts`，从 `index.ts` 中移出所有 interface/type 定义
- [ ] 2. 创建 `helpers.ts`，移出所有无状态辅助函数和常量
- [ ] 3. 创建 `engine.ts`，移出转换执行、事件处理、队列排空、API 构建
- [ ] 4. 创建 `factory.ts`，移出 `createStateMachine` 工厂函数
- [ ] 5. 将 `index.ts` 改为纯 re-export
- [ ] 6. 测试通过（`pnpm run test:ci`）
- [ ] 7. Lint 通过（`pnpm run check`）
- [ ] 8. Build 通过（`pnpm run build`）

## 约束

- **不改变任何公开 API**：导出签名、类型、运行时行为完全不变
- **不改变测试文件**：测试从 `./index` 导入，拆分后仍然有效
- **遵循项目导出规范**：entry file（`index.ts`）末尾集中 `export`，helper file 行内 export
- **内部类型不泄漏**：`InternalState`、`Registries` 仅在 helper/engine 内使用，不在 index 中 re-export
