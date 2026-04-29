# lockData 实施清单

> 基于 RFC.md (0.1.4, accepted on 2026/04/29) 的逐步落地计划
>
> **使用方式**：每完成一项，将 `[ ]` 改为 `[x]`；每个条目末尾的 `→ RFC#xxx` 为对应设计章节的页内锚点，点击可直接跳转到 RFC.md 的源头需求

## 总体路线图

按依赖方向自底向上推进：**基础件 → 适配器 → 驱动 → 协调层 → 集成**。每个 Phase 内的模块可以并行，跨 Phase 严格串行。

```
Phase 1 基础件（无外部依赖，可独立单测）
   ├─ constants / types / errors
   ├─ ReadonlyView
   └─ 事务式 Draft
         ↓
Phase 2 适配器层（依赖基础件）
   ├─ logger / clone
   ├─ authority / channel / session-store
   └─ pickDefaultAdapters
         ↓
Phase 3 锁驱动层（依赖适配器）
   ├─ LocalLockDriver / WebLocksDriver
   ├─ BroadcastDriver / StorageDriver
   └─ pickDriver（能力检测）
         ↓
Phase 4 权威副本与会话纪元（依赖适配器）
   ├─ serialize / extract / readIfNewer
   ├─ resolveEpoch（session-probe 协议）
   └─ StorageAuthority 主类
         ↓
Phase 5 协调层（依赖全部前置）
   ├─ InstanceRegistry（同 id 单例池）
   ├─ Actions（state machine + ensureHolding）
   └─ signal 合并 / fanout / 生命周期
         ↓
Phase 6 入口聚合与导出
   ├─ lockData 重载分支 A/B/C
   └─ shared/index.ts 导出
         ↓
Phase 7 文档与测试收口
   ├─ index.mdx
   └─ 集成测试 + 能力等价性测试
```

---

## Phase 1 — 基础件（无外部依赖）

建议从本 Phase 起步，所有模块均可在 Node 环境独立单测，不依赖浏览器 API。

### 1.1 constants / types / errors 骨架

- [ ] 创建 `src/shared/lock-data/constants.ts`：`LOCK_PREFIX`、`NEVER_TIMEOUT: unique symbol` → [RFC#附录-a完整接口索引](./RFC.md#附录-a完整接口索引)
- [ ] 创建 `src/shared/lock-data/types.ts`：搬运附录 A 的全部 interface 签名 → [RFC#附录-a完整接口索引](./RFC.md#附录-a完整接口索引)
- [ ] 创建 `src/shared/lock-data/errors.ts`：`LockAcquireTimeoutError` / `LockHoldTimeoutError` / `LockRevokedError` / `LockAbortedError` / `LockDisposedError` / `ReadonlyMutationError`，所有抛错走 `shared/throw-error` → [RFC#错误类型](./RFC.md#错误类型)（L333）
- [ ] 验收：`pnpm run check` 类型通过；`errors.ts` 使用 `throwError` 而非 `throw new Error`（AGENTS.md 规范）

### 1.2 `core/readonly-view.ts`（深只读 Proxy）

- [ ] 实现 `createReadonlyView<T>(target)`：`Proxy` 拦截 `set` / `deleteProperty` / `defineProperty` 抛 `ReadonlyMutationError` → [RFC#只读代理实现要点](./RFC.md#只读代理实现要点)（L762）
- [ ] `get` 命中对象类型惰性包装；用 `WeakMap<object, Proxy>` 缓存保证代理身份稳定 → [RFC#只读代理实现要点](./RFC.md#只读代理实现要点)
- [ ] Set / Map 的 mutation 方法（`add` / `delete` / `set` / `clear`）拦截抛错
- [ ] 验收：`__test__/core/readonly-view.node.test.ts` 覆盖嵌套对象 / 数组 / Set / Map / 代理身份一致性 / actions 写入后读到最新值 → [RFC#测试策略](./RFC.md#测试策略)（L1440）

### 1.3 `core/draft.ts`（事务式 Draft，self-contained）

- [ ] 文件顶部加迁移注释指向 RFC「外部化前瞻」小节 → [RFC#外部化前瞻可选迁移路径](./RFC.md#外部化前瞻可选迁移路径)（L875）
- [ ] 实现 `MutationLog` / `DraftContext` 数据结构 → [RFC#数据结构](./RFC.md#数据结构)（L774）
- [ ] 实现 `createDraft(target, ctx, parentPath)`：Proxy `get` / `set` / `deleteProperty` 三个拦截器，惰性递归子 draft，共享同一 ctx → [RFC#draft-proxy-行为](./RFC.md#draft-proxy-行为)（L792）
- [ ] 实现 `snapshotFor` / `rollback`：按 mutation log 路径做最小深拷贝 + 逆序回写 → [RFC#关键实现要点](./RFC.md#关键实现要点)（L863）
- [ ] 实现 `freezeLog`：深冻结 mutations，供 `onCommit` 暴露时防止外部 mutate → [RFC#提交流程commit](./RFC.md#提交流程commit)（L824）
- [ ] 验收：`__test__/core/draft-transaction.node.test.ts` 覆盖正常 recipe / 抛错回滚 / 异步期间被 force / `holdTimeout` / 嵌套 draft / `replace` 语义 / mutation log 精确性 → [RFC#测试策略](./RFC.md#测试策略)

### 1.4 `core/signal.ts`（AbortSignal 合并封装）

- [ ] 实现 `combineSignals(...signals)`：优先使用 `AbortSignal.any`，兼容环境用事件绑定 polyfill → [RFC#actions-实现要点](./RFC.md#actions-实现要点)（L930，见 `AbortSignal 组合` 要点）
- [ ] 验收：`__test__/core/signal.node.test.ts` 覆盖多信号合并 / 单路 abort 传播 / 已 aborted 信号的即时触发

---

## Phase 2 — 适配器层

依赖 Phase 1 的 types / errors。**关键点**：每个默认适配器都要有"环境探测 → 不可用时返回 null"的兜底分支。

### 2.1 `adapters/logger.ts`

- [ ] 实现默认 `LoggerAdapter`：委托到 `shared/logger` → [RFC#默认实现](./RFC.md#默认实现)（L1047）
- [ ] 验收：`warn` / `error` / `debug` 三个方法齐全

### 2.2 `adapters/clone.ts`

- [ ] 实现 `structuredCloneSafe<V>(value)`：`structuredClone` 优先 + JSON fallback + `logger.warn` → [RFC#默认实现](./RFC.md#默认实现)
- [ ] 验收：`__test__/adapters/clone.node.test.ts` 覆盖 structuredClone 可用 / 不可用 / JSON 失败（循环引用）三条分支

### 2.3 `adapters/authority.ts`（默认 localStorage 实现）

- [ ] 实现 `DefaultLocalStorageAuthority`：`read` / `write` / `remove` / `subscribe(storage event)` → [RFC#接口定义](./RFC.md#接口定义)（L982，`AuthorityAdapter`）
- [ ] 写入 `QuotaExceededError` 捕获；通过 throw 委托给内部 logger.warn 降级 → [RFC#接口定义](./RFC.md#接口定义)
- [ ] 能力探测：`localStorage` 不可用时工厂返回 null → [RFC#默认实现](./RFC.md#默认实现)
- [ ] 验收：`__test__/adapters/authority.browser.test.ts`（真浏览器） + `__test__/adapters/authority-memory.node.test.ts`（内存替身）

### 2.4 `adapters/channel.ts`（默认 BroadcastChannel 实现）

- [ ] 实现 `DefaultBroadcastChannel`：`postMessage` / `subscribe` / `close` → [RFC#接口定义](./RFC.md#接口定义)（L982，`ChannelAdapter`）
- [ ] 能力探测：`BroadcastChannel` 不可用时工厂返回 null → [RFC#默认实现](./RFC.md#默认实现)
- [ ] 验收：`__test__/adapters/channel.browser.test.ts`

### 2.5 `adapters/session-store.ts`（默认 sessionStorage 实现）

- [ ] 实现 `DefaultSessionStore`：纯同步 `read` / `write` → [RFC#接口定义](./RFC.md#接口定义)（L982，`SessionStoreAdapter`）
- [ ] 能力探测：`sessionStorage` 不可用时工厂返回 null，调用方降级 `'session'` → `'persistent'` → [RFC#默认实现](./RFC.md#默认实现)
- [ ] 验收：`__test__/adapters/session-store.browser.test.ts`

### 2.6 `adapters/index.ts`（pickDefaultAdapters 聚合）

- [ ] 实现 `pickDefaultAdapters(userAdapters, ctx) => ResolvedAdapters`：用户提供 > 默认实现 > null → [RFC#设计原则](./RFC.md#设计原则)（L974）
- [ ] 验收：传入空对象得到全默认；传入部分自定义按字段覆盖；能力不可用时对应字段为 null 且发出降级 `logger.warn`

---

## Phase 3 — 锁驱动层

依赖 Phase 2 的 logger / channel。4 个驱动共享同一 `LockHandle` 接口契约。

### 3.1 `drivers/local.ts`（LocalLockDriver）

- [ ] 实现仅实例内互斥的轻量锁（无 id 场景） → [RFC#locallockdriver](./RFC.md#locallockdriver)（L732）
- [ ] 支持 `acquire` / `release` / `onRevokedByDriver`
- [ ] 验收：`__test__/drivers/local.node.test.ts`

### 3.2 `drivers/web-locks.ts`（WebLocksDriver，首选）

- [ ] 基于 `navigator.locks.request(name, { mode, steal, signal })` → [RFC#weblocksdriver首选](./RFC.md#weblocksdriver首选)（L737）
- [ ] `force` 映射到 `steal: true`；原持有者触发 `onRevokedByDriver('force')`
- [ ] 验收：`__test__/drivers/web-locks.browser.test.ts`

### 3.3 `drivers/broadcast.ts`（BroadcastDriver，降级）

- [ ] 基于 BroadcastChannel + token 的排队协议 → [RFC#broadcastdriver降级](./RFC.md#broadcastdriver降级)（L745）
- [ ] 处理队列公平性风险（决策 #见「风险与取舍」）
- [ ] 验收：`__test__/drivers/broadcast.browser.test.ts`

### 3.4 `drivers/storage.ts`（StorageDriver，兜底）

- [ ] 基于 localStorage 的 token 轮询 + storage 事件 → [RFC#storagedriver兜底降级](./RFC.md#storagedriver兜底降级)（L754）
- [ ] 验收：`__test__/drivers/storage.browser.test.ts`

### 3.5 `drivers/custom.ts` + `drivers/index.ts`（CustomDriver + pickDriver）

- [ ] `CustomDriver`：包装用户的 `adapters.getLock` 工厂函数 → [RFC#customdriver](./RFC.md#customdriver)（L722）
- [ ] `pickDriver(options, id)`：能力检测优先级 `Web Locks → Broadcast → Storage → Local` → [RFC#能力检测与降级](./RFC.md#能力检测与降级)（L686）
- [ ] `adapters.getLock` 存在时 `mode` 被忽略，直接用 CustomDriver
- [ ] 验收：`__test__/drivers/pick-driver.node.test.ts`

---

## Phase 4 — 权威副本与会话纪元

依赖 Phase 2 的 authority / channel / session-store。

### 4.1 `authority/serialize.ts`（字段顺序固化）

- [ ] 实现 `serialize(rev, ts, epoch, snapshot)`：手动拼接保证 `rev → ts → epoch → snapshot` 顺序 → [RFC#存储格式固化契约](./RFC.md#存储格式固化契约)（L1093）
- [ ] 验收：`__test__/authority/serialize.node.test.ts` 覆盖字段顺序 / 特殊字符 snapshot

### 4.2 `authority/extract.ts`（Lazy Parse 快路径）

- [ ] 实现 `extractRev(raw)`：正则锚定开头匹配 → [RFC#lazy-parse-快路径](./RFC.md#lazy-parse-快路径)（L1110）
- [ ] 实现 `extractEpoch(raw)`：正则匹配中段 → [RFC#lazy-parse-快路径](./RFC.md#lazy-parse-快路径)
- [ ] 实现 `readIfNewer(entry, raw)`：快路径 rev 对比 + epoch 过滤 + 全量 parse 兜底 → [RFC#lazy-parse-快路径](./RFC.md#lazy-parse-快路径)
- [ ] 验收：`__test__/authority/extract.node.test.ts` 覆盖快路径命中 / 失配走 JSON.parse 兜底 / epoch 不一致丢弃 / 大 value 性能（亚微秒）

### 4.3 `authority/epoch.ts`（resolveEpoch + session-probe 协议）

- [ ] 实现 `resolveEpoch(ctx)` 的 A~F 六分支（sessionStorage 命中 / probe 响应 / probe 超时 / persistent 常量 / 适配器不可用降级 / TOCTOU 收敛） → [RFC#resolveepoch-协议](./RFC.md#resolveepoch-协议)（L1222）
- [ ] 实现 `session-probe` / `session-reply` 消息协议 → [RFC#数据通道](./RFC.md#数据通道)（L1214）
- [ ] 首个 Tab 判定为"所有 Tab 关闭后重启"时主动 `removeItem` 清空 localStorage 权威副本 → [RFC#策略总览](./RFC.md#策略总览)（L1207）
- [ ] 验收：`__test__/authority/epoch.browser.test.ts` 覆盖 A~F 六分支 / TOCTOU 收敛 / 多 Tab 同时启动收敛到最早 epoch

### 4.4 `authority/index.ts`（StorageAuthority 主类）

- [ ] 实现 `initAuthority(entry, adapters)`：订阅 `storage` 事件 + `pageshow` + `visibilitychange` → [RFC#读路径三个触发源共享同一应用流程](./RFC.md#读路径三个触发源共享同一应用流程)（L1164）
- [ ] 实现 `applyAuthorityIfNewer(entry, raw)`：走 `readIfNewer` + 更新 `entry.data` + 触发 `onSync`
- [ ] 实现 `onCommitSuccess(entry, snapshot)`：`rev++` + 写入权威副本 + 触发 `onCommit` → [RFC#写路径commit-后](./RFC.md#写路径commit-后)（L1150）
- [ ] 实现生命周期订阅的解绑：Entry refCount 归零时全部释放
- [ ] 验收：`__test__/authority/integration.browser.test.ts` 端到端：两 Tab commit → storage event → `onSync` 派发 → view 自动更新

---

## Phase 5 — 协调层

依赖 Phase 1-4 全部前置。

### 5.1 `core/registry.ts`（InstanceRegistry 同 id 进程内单例）

- [ ] 实现 `getOrCreateEntry(id, options)`：首次注册建 Entry、后续调用复用；refCount++ → [RFC#instanceregistry同-id-进程内单例](./RFC.md#instanceregistry同-id-进程内单例)（L635）
- [ ] 实现 Entry 结构：`data` / `driver` / `authority` / `rev` / `lastAppliedRev` / `epoch` / `dataReadyPromise` / `dataReadyState` / `listenersFanout` / `refCount`
- [ ] 实现 `releaseEntry(id)`：refCount-- 归零时销毁（`driver.destroy()` + 解绑全部订阅 + `registry.delete(id)`）
- [ ] 冲突字段处理：首次注册的 options 为准，冲突字段 `logger.warn` → [RFC#instanceregistry同-id-进程内单例](./RFC.md#instanceregistry同-id-进程内单例)
- [ ] `dataReadyPromise` 共享：同 id 多实例共享同一个 Promise → [RFC#actions-实现要点](./RFC.md#actions-实现要点)（L930）
- [ ] 验收：`__test__/core/registry.node.test.ts` 覆盖共享 / 冲突警告 / 引用计数 / dataReadyState 状态机

### 5.2 `core/actions.ts`（LockDataActions 实现）

- [ ] 内部状态机 `idle → acquiring → holding → committing → released / revoked / disposed` → [RFC#actions-实现要点](./RFC.md#actions-实现要点)
- [ ] `ensureHolding(opts)`：复用锁 / 抢新锁 / 合并 signal / 启动 holdTimeout
- [ ] `update(recipe, opts)`：走事务式 Draft 流程 → [RFC#提交流程commit](./RFC.md#提交流程commit)
- [ ] `replace(next, opts)`：隐式 update 事务，等价 `Object.keys(draft).forEach(delete) + Object.assign(draft, next)`
- [ ] `getLock(opts)`：只抢锁不执行 recipe
- [ ] `read()`：不抢锁，直接 `adapters.clone(entry.data)` → [RFC#actions-实现要点](./RFC.md#actions-实现要点)
- [ ] `release()`：仅处理还锁，不碰引用计数、不解绑订阅 → [RFC#actions-实现要点](./RFC.md#actions-实现要点)（决策 #31）
- [ ] `dispose()`：release + 解绑 driver 监听 + 解绑 authority 订阅 + refCount-- + 终态转 disposed
- [ ] 返回类型规则：按异步条件枚举（有 id / getValue Promise / recipe Promise / syncMode 非 none 任一满足则返 Promise）→ [RFC#lockdataactionst](./RFC.md#lockdataactionst)（L207）
- [ ] 验收：`__test__/core/actions.node.test.ts`（同步场景）+ `__test__/core/actions.browser.test.ts`（异步 + 跨 Tab）

### 5.3 `core/fanout.ts`（listeners fanout）

- [ ] 实现 `listenersFanout`：同 id 多实例的 listeners 聚合分发，单个 listener 异常不影响其他 → [RFC#instanceregistry同-id-进程内单例](./RFC.md#instanceregistry同-id-进程内单例)
- [ ] 覆盖 `onLockStateChange` / `onRevoked` / `onCommit` / `onSync` 四个事件
- [ ] 验收：`__test__/core/fanout.node.test.ts` 覆盖 listener 异常隔离 / 订阅解绑幂等

---

## Phase 6 — 入口聚合

### 6.1 `index.ts`（lockData 主入口）

- [ ] 实现三个重载分支 A/B/C → [RFC#签名](./RFC.md#签名)（L112）
- [ ] 参数校验走 `dataHandler` → [RFC#参数校验](./RFC.md#参数校验)（L1321）
- [ ] 默认值应用走 `shared/data-mixed-manager` 或等价方式 → [RFC#默认值总览](./RFC.md#默认值总览)（L1296）
- [ ] 重载匹配规则：分支 A 同步 / 分支 B getValue Promise / 分支 C syncMode storage-authority → [RFC#签名](./RFC.md#签名)
- [ ] 验收：`__test__/integration/entry.node.test.ts` 覆盖三个重载分支的返回类型

### 6.2 从 `src/shared/index.ts` 导出

- [ ] 导出 `lockData` / `NEVER_TIMEOUT` / 全部错误类 / 核心类型
- [ ] 验收：在外部消费侧 `import { lockData } from '@cmtlyt/lingshu-toolkit/shared'` 能拿到类型

---

## Phase 7 — 文档与集成测试收口

### 7.1 `index.mdx` 用户向文档

- [ ] 按 `lingshu-doc-writer` skill 的 MDX 格式产出 → `.claude/skills/lingshu-doc-writer/SKILL.md`
- [ ] 使用示例覆盖 RFC「使用示例」章节的所有场景 → [RFC#使用示例](./RFC.md#使用示例)（L357）
- [ ] 不暴露实现细节（严格遵守 `lingshu-doc-writer` 的 "never expose implementation details"）

### 7.2 跨模块集成测试

- [ ] `__test__/integration/cross-tab.browser.test.ts`：真跨 Tab 的 `storage-authority` 端到端
- [ ] `__test__/integration/session-persistence.browser.test.ts`：session / persistent 两种策略的完整生命周期
- [ ] `__test__/integration/memory-adapters.node.test.ts`：全内存 adapter 跑完整链路（脱离浏览器环境）→ [RFC#附录-b完整示例集](./RFC.md#附录-b完整示例集)（L1771 的「单元测试内存适配器」示例）

### 7.3 `__test__/adapters/memory-integration.node.test.ts`（能力等价性测试套件）

- [ ] 提供"用户自定义 adapter 的合规性测试套件"（RFC 风险表已承诺）→ [RFC#风险与取舍](./RFC.md#风险与取舍)（L1465，`适配器语义契约依赖用户自律` 条目）
- [ ] 用户可以导入这个套件，传入自己的 adapter 实现跑一遍，确认语义等价

---

## 目录结构（最终落地形态）

按 RFC「目录与文件规划」要求：→ [RFC#目录与文件规划](./RFC.md#目录与文件规划)（L1362）

```
src/shared/lock-data/
├── index.ts                 # 主入口
├── index.mdx                # 用户向文档
├── types.ts                 # 全部 TS 接口
├── constants.ts             # LOCK_PREFIX / NEVER_TIMEOUT
├── errors.ts                # 错误类
├── RFC.md                   # 设计文档（已 accepted）
├── IMPLEMENTATION.md        # 本文件
├── core/
│   ├── registry.ts          # InstanceRegistry
│   ├── actions.ts           # LockDataActions 实现
│   ├── readonly-view.ts     # 深只读 Proxy
│   ├── draft.ts             # 事务式 Draft
│   ├── signal.ts            # AbortSignal 合并封装
│   └── fanout.ts            # listeners fanout
├── authority/
│   ├── index.ts             # StorageAuthority 主类
│   ├── serialize.ts         # 字段顺序固化
│   ├── extract.ts           # extractRev / extractEpoch / readIfNewer
│   └── epoch.ts             # resolveEpoch A~F + session-probe 协议
├── drivers/
│   ├── index.ts             # pickDriver 能力检测
│   ├── local.ts             # LocalLockDriver
│   ├── web-locks.ts         # WebLocksDriver
│   ├── broadcast.ts         # BroadcastDriver
│   ├── storage.ts           # StorageDriver
│   └── custom.ts            # CustomDriver（包装用户 getLock）
├── adapters/
│   ├── index.ts             # pickDefaultAdapters
│   ├── authority.ts         # DefaultLocalStorageAuthority
│   ├── channel.ts           # DefaultBroadcastChannel
│   ├── session-store.ts     # DefaultSessionStore
│   ├── logger.ts            # 默认 logger 适配
│   └── clone.ts             # structuredCloneSafe
└── __test__/
    ├── core/
    ├── adapters/
    ├── drivers/
    ├── authority/
    └── integration/
```

---

## 进度追踪建议

- 每个 Phase 结束在 git 打 tag：`lock-data/phase-1-done` 等
- 每完成一个 `[x]` 勾选时同步跑 `pnpm run test:ci`，保证主干一直绿
- 若 Phase 3/4 发现与 RFC 设计不符的实际问题，走"RFC 版本 +1"流程（修订 RFC，递增到 1.0.x）
- Phase 1-2 原则上可并行分工；Phase 3-5 有强依赖必须串行

## 相关文档

- **设计源头**：[`./RFC.md`](./RFC.md) (0.1.4, accepted on 2026/04/29)
- **编码规范**：[`../../../AGENTS.md`](../../../AGENTS.md)（报错走 `shared/throw-error`）
- **项目测试约定**：[`../../../vitest.config.ts`](../../../vitest.config.ts)
