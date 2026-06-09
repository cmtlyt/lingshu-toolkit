# 实施清单：stateMachine

> 关联 RFC：[RFC.md](./RFC.md)（v0.1.0, accepted 2026/06/08）
>
> 状态：✅ 全部完成（2026/06/09）

## Phase 1：项目脚手架

- [x] 1.1 在 `meta/toolkit.meta.json` 的 shared 数组中添加 `{ "name": "stateMachine" }`
- [x] 1.2 运行 `pnpm script:gen-file` 生成 `src/shared/state-machine/` 下的 `index.ts`、`index.test.ts`、`index.mdx`
- [x] 1.3 确认导出已自动添加到 `src/shared/index.ts`

## Phase 2：类型定义

- [x] 2.1 定义核心类型：`EventPayload`、`StateMachineSettings`
- [x] 2.2 定义函数签名类型：`GuardFn<TContext, TAsync>`、`ActionFn<TContext, TAsync>`、`ActionRef<TContext, TAsync>`
- [x] 2.3 定义配置类型：`TransitionConfig`、`StateNode`、`StateMachineConfig`
- [x] 2.4 定义返回值类型：`StateChangeEvent`、`StateMachineListener`、`StateMachine`

## Phase 3：核心引擎实现

- [x] 3.1 实现配置解析与校验（初始状态存在性校验、状态定义完整性校验）
- [x] 3.2 实现事件队列（enqueue / dequeue / FIFO 循环）
- [x] 3.3 实现转换查找（从状态节点的 `on` 中匹配事件，支持数组多规则按序匹配）
- [x] 3.4 实现 Guard 求值（同步/异步由 `TAsync` 控制）
- [x] 3.5 实现 Action 执行链（`onExit` → `transition action` → `onEntry`，支持字符串名解析）
- [x] 3.6 实现状态更新与 Context 更新
- [x] 3.7 实现 `trigger()` 方法（同步模式返回 `boolean`，异步模式返回 `Promise<boolean>`）

## Phase 4：API 方法实现

- [x] 4.1 实现 `getState()` / `getContext()` / `matches()` / `getAvailableEvents()`
- [x] 4.2 实现 `subscribe()` / 取消订阅
- [x] 4.3 实现 `dispose()`（清理队列、订阅、标记不可用）

## Phase 5：防御性编程

- [x] 5.1 实现事件队列最大长度限制（`settings.maxQueueSize`，默认 100）
- [x] 5.2 实现循环检测（`settings.maxCyclicCount`，默认 10）
- [x] 5.3 实现 `onUnhandledEvent` 钩子调用
- [x] 5.4 实现 final 状态拒绝事件
- [x] 5.5 报错使用 `shared/throw-error` 模块

## Phase 6：测试

- [x] 6.1 基础流转测试（状态切换、Context 更新）
- [x] 6.2 Guard 测试（通过 / 拒绝 / 多规则按序匹配）
- [x] 6.3 Action 测试（onEntry / onExit / transition action / 执行顺序）
- [x] 6.4 事件队列测试（Action 中 trigger 不递归、FIFO 顺序）
- [x] 6.5 异步模式测试（async Guard / Action / trigger 返回 Promise）
- [x] 6.6 防御性测试（队列溢出、循环检测、未定义事件、final 状态）
- [x] 6.7 subscribe / dispose 测试
- [x] 6.8 运行 `pnpm run test:ci` 全量通过（39 tests, node 环境）

## Phase 7：验证与交付

- [x] 7.1 运行 `pnpm run check`（Biome lint 通过）
- [x] 7.2 运行 `pnpm run build`（构建通过，89 files, 108.4 kB）
- [x] 7.3 更新 `index.mdx` 文档（追加 API 说明和使用示例）
