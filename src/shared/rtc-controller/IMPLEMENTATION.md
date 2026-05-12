# rtcController 实施清单

> 基于 RFC.md (0.1.0, accepted) 的逐步落地计划
>
> **使用方式**：每完成一项，将 `[ ]` 改为 `[x]`；每个条目末尾的 `→ RFC#xxx` 为对应设计章节的描述，可回 RFC.md 查看源头需求

## 开发守则（Phase 全程生效）

### 测试运行约定 🚨

- **严禁跑全仓库测试** `pnpm run test:ci`（无参数形式会串行跑全部测试文件，每次改动都跑是浪费）
- 改动哪里只测哪里，统一使用 `pnpm run test:ci <path>` 精确执行：
  - **单文件**：`pnpm run test:ci src/shared/rtc-controller/__test__/core/event-emitter.test.ts`
  - **单目录**：`pnpm run test:ci src/shared/rtc-controller/__test__/`
  - **单 Phase**：按 Phase 所属目录精准指定
- 全仓 `pnpm run test:ci` 仅在**用户明确要求**或 **Phase 结束前统一收口**时才执行
- 涉及真实定时器的用例（`setTimeout` / `clearTimeout`）优先用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()` 替代，避免无意义阻塞

### 错误处理与类型约定

- 报错统一走 `shared/throw-error`（`throwError` / `throwType` / `createError`），**禁止 `throw new Error` 直抛**（AGENTS.md 规范）
- 错误子类定义模式：`constructor(message?: string, options?: ErrorOptions) { super(message, options); this.name = '...'; }`
- 调用 `throwError` 传子类时，需 `RtcXxxError as unknown as ErrorConstructor` 局部类型适配（class 语法子类不支持无 `new` 直接调用）

### 代码风格

- 全量走 Biome：`pnpm run check` 在 Phase 结束前必须零错误
- 注释原则：解释"为什么"而非"怎么做"；**严禁 TODO / FIXME 注释**
- 顶级 `export` 统一放文件末尾（`export { xxx }` 形式）
- **路径别名**：跨目录 import 统一使用 `@/shared/...` 别名，**禁止 `../../` 这类多级相对路径**
- **循环形式**：数组/类数组遍历**优先使用索引 `for` 循环**而非 `for...of`
- **空值兜底运算符**：非必要场景优先使用 `||`，仅在需要严格区分 null/undefined 与其他 falsy 值时保留 `??`
- **logger 字段级混合兜底**：通过 `resolveLoggerAdapter(userLogger?)` 做字段级合并，产出三方法齐全的 `ResolvedLoggerAdapter`

### 测试文件组织

- 所有测试文件统一收敛到 `__test__/` 目录，**禁止**在模块根目录放置测试文件
- 类型测试（`.test-d.ts`）与逻辑测试（`.test.ts`）分离
- 浏览器 API 测试使用 `.browser.test.ts` 后缀

## Phase 1 — 基础件（无浏览器 API 依赖）

- [x] 1.1 创建 `constants.ts`：`RTC_EVENT_MARKER`、`DEFAULT_DATA_CHANNEL_LABEL`、默认 `connectTimeout` / `dataChannelOptions` 等配置常量 → RFC#常量 + RFC#附录A
- [x] 1.2 创建 `types.ts`：所有公开类型签名（`SignalingAdapter` / `SignalingMessage` / `EventMap` / `EventHandler` / `BuiltinEvents` / `AllEvents` / `DataChannelEventMessage` / `RtcControllerOptions` / `RtcControllerInternalOptions`（`__onUserEvent` 钩子，供 rtc-room 使用）/ `RtcController` / `RtcPhase` / `LoggerAdapter` / `ResolvedLoggerAdapter`） → RFC#API设计 + RFC#附录A + rtc-room RFC#与rtc-controller的协作契约
- [x] 1.3 创建 `errors.ts`：5 个错误子类（`RtcInvalidStateError` / `RtcSignalingError` / `RtcDisposedError` / `RtcTimeoutError` / `RtcChannelNotReadyError`） → RFC#错误类型
- [x] 1.4 实现 `core/event-emitter.ts`：泛型事件系统（`on` / `once` / `off` / `dispatch`），含快照遍历 + 异常隔离（try/catch + logger.error） → RFC#事件系统实现
- [x] 1.5 实现 `adapters/logger.ts`：`resolveLoggerAdapter` 字段级混合兜底（`.bind(userLogger)` 保证 `this` 正确）→ RFC#logger适配器
- [x] 1.6 创建 `__test__/helpers/mock-signaling.ts`：`createMockSignalingPair()` 测试用内存信令适配器对 → RFC#Mock信令适配器
- [x] 1.7 验收：`pnpm run check` + `__test__/core/event-emitter.test.ts` + `__test__/adapters/logger.test.ts` 全通过

## Phase 2 — 连接管理（依赖浏览器 API）

- [x] 2.1 实现 `core/connection.ts`：`RTCPeerConnection` 创建 / offer-answer 交换 / ICE Candidate 处理（Trickle ICE：`pendingCandidates` 缓冲队列 + `flushPendingCandidates`）/ 状态机管理（`setPhase` / `assertNotDisposed` / `assertPhase`）/ `handleOffer`（内部函数）/ `handleAnswer` / `handleIceCandidate` / `wireConnectionEvents` / `waitForConnection`（connectTimeout 保护）/ `resetConnectionPromise` → RFC#连接建立流程 + RFC#接收offer流程 + RFC#ICE Candidate处理策略
- [x] 2.2 实现 `core/data-channel.ts`：DataChannel 创建 / 事件协议编解码（`DataChannelEventMessage`：`__rtc_event__` 标记检测）/ 消息收发 / `wireDataChannelEvents` / `__onUserEvent` 钩子调用（存在时先回调再分发）/ 自定义事件与内置事件命名冲突的运行时检测（`logger.warn` 提示并忽略）→ RFC#数据通道与自定义事件 + rtc-room RFC#与rtc-controller的协作契约
- [x] 2.3 实现 `core/media.ts`：`addTrack` / `removeTrack` / `getRemoteStreams` → RFC#RtcController媒体流
- [x] 2.4 验收：`__test__/core/connection.browser.test.ts` + `__test__/core/data-channel.browser.test.ts` + `__test__/core/media.browser.test.ts` 全通过

## Phase 3 — 入口聚合

- [x] 3.1 实现 `core/controller.ts`：聚合 event-emitter / connection / data-channel / media，实现 `connect()` / `reconnect()` / `dispose()`（幂等：首次完整清理，第二次起 no-op）公开 API + 信令消息自动路由（`signaling.onMessage` 内部注册，按 `message.type` 分发到 `handleOffer` / `handleAnswer` / `handleIceCandidate`）+ AbortSignal 集成（`options.signal` 已 aborted 直接 dispose；否则注册 `abort` 监听 + `cleanupFns` 清理）+ `getStats()` → RFC#内部实现要点 + RFC#信令消息自动路由 + RFC#AbortSignal集成
- [x] 3.2 实现 `index.ts`：`createRtcController` 公开导出 → RFC#签名
- [x] 3.3 验收：`__test__/index.test.ts`（Node 环境入口层）+ `__test__/index.browser.test.ts`（完整 offer/answer 流程）+ `__test__/index.test-d.ts`（类型契约：泛型推断 / AllEvents 合并 / emit 仅允许 UserEvents）+ `__test__/reconnect.browser.test.ts`（重连流程）全通过

## Phase 4 — 文档与收口

- [x] 4.1 更新 `index.mdx` 文档 → RFC#附录B使用示例
- [x] 4.2 `pnpm run check` + `pnpm run build` 全通过
- [ ] 4.3 覆盖率检查（可选，后续执行）：`pnpm test:ci src/shared/rtc-controller/__test__/ --coverage.enabled` + `pnpm exec esno scripts/analyze-coverage.ts rtc-controller`
