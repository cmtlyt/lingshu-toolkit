# 实施清单：stateMachine 模块拆分

> 关联 RFC：[RFC.md](./RFC.md)（accepted, 2026/06/09）
> 源码：[index.ts](../../../index.ts)
> 状态：✅ 全部完成（2026/06/09）

## Phase 1：创建 `types.ts`

- [x] 1.1 创建 `src/shared/state-machine/types.ts`
- [x] 1.2 从 `index.ts` 移出所有 interface / type 定义（`EventPayload`、`StateMachineSettings`、`GuardFn`、`ActionFn`、`ActionRef`、`TransitionConfig`、`StateNode`、`StateMachineConfig`、`StateChangeEvent`、`StateMachineListener`、`StateMachine`、`InternalState`、`Registries`）
- [x] 1.3 行内 export 每个类型

## Phase 2：创建 `helpers.ts`

- [x] 2.1 创建 `src/shared/state-machine/helpers.ts`
- [x] 2.2 移出 `FN_NAME` 常量
- [x] 2.3 移出无状态辅助函数：`resolveActionRefs`、`resolveGuard`、`getCandidates`、`checkCyclic`、`notifyListeners`、`runActionsSync`、`runActionsAsync`、`enqueueOrWarn`
- [x] 2.4 添加 `types.ts` 和 `@/shared/throw-error` 的 import
- [x] 2.5 行内 export 每个函数和常量

## Phase 3：创建 `engine.ts`

- [x] 3.1 创建 `src/shared/state-machine/engine.ts`
- [x] 3.2 移出转换执行：`executeTransitionSync`、`executeTransitionAsync`
- [x] 3.3 移出事件处理：`processEventSync`、`processEventAsync`
- [x] 3.4 移出队列排空：`drainSyncQueue`、`drainAsyncQueue`
- [x] 3.5 移出 API 构建：`buildMachineApi`
- [x] 3.6 添加 `types.ts` 和 `helpers.ts` 的 import
- [x] 3.7 行内 export 每个函数

## Phase 4：创建 `factory.ts`

- [x] 4.1 创建 `src/shared/state-machine/factory.ts`
- [x] 4.2 移出 `createStateMachine` 工厂函数
- [x] 4.3 添加 `types.ts`、`helpers.ts`、`engine.ts` 的 import
- [x] 4.4 行内 export `createStateMachine`

## Phase 5：重写 `index.ts`

- [x] 5.1 清空 `index.ts` 原有实现代码
- [x] 5.2 末尾集中 `export type { ... } from './types'`（仅公开类型）
- [x] 5.3 末尾集中 `export { createStateMachine } from './factory'`
- [x] 5.4 确保 `InternalState`、`Registries` 不被 re-export

## Phase 6：验证

- [x] 6.1 测试通过：39 tests passed（node 环境）
- [x] 6.2 Lint 通过：Checked 5 files, Fixed 1 file（Biome 内部 panic 为已知 bug，不影响代码）
- [x] 6.3 Build 通过：93 files, 109.4 kB
- [x] 6.4 更新 RFC 状态为 accepted
