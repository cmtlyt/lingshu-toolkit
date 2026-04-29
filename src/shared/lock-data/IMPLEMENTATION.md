# lockData 实施清单

> 基于 RFC.md (0.1.4, accepted on 2026/04/29) 的逐步落地计划
>
> **使用方式**：每完成一项，将 `[ ]` 改为 `[x]`；每个条目末尾的 `→ RFC#xxx` 为对应设计章节的页内锚点，点击可直接跳转到 RFC.md 的源头需求

## 开发守则（Phase 全程生效）

### 测试运行约定 🚨

- **严禁跑全仓库测试** `pnpm run test:ci`（无参数形式会串行跑全部 86+ 测试文件，耗时 30s+，每次改动都跑是浪费）
- 改动哪里只测哪里，统一使用 `pnpm run test:ci <path>` 精确执行：
  - **单文件**：`pnpm run test:ci src/shared/lock-data/__test__/core/signal.node.test.ts`
  - **单目录**：`pnpm run test:ci src/shared/lock-data/__test__/`
  - **单 Phase**：按 Phase 所属目录精准指定（例如 Phase 2 只跑 `src/shared/lock-data/__test__/adapters/`）
- 全仓 `pnpm run test:ci` 仅在**用户明确要求**或 **Phase 结束前统一收口**时才执行
- 涉及真实定时器的用例（`setTimeout` / `clearTimeout`）优先用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()` 替代 `await new Promise(setTimeout, N)`，避免无意义阻塞

### 错误处理与类型约定

- 报错统一走 `shared/throw-error`（`throwError` / `throwType` / `createError`），**禁止 `throw new Error` 直抛**（AGENTS.md 规范）
- 错误子类定义模式：`constructor(message?: string) { super(message); this.name = '...'; }`
  - 不要用 `override readonly name = '...'` 类字段，会因 `useDefineForClassFields: true` 与 `ErrorConstructor` 签名冲突
- 调用 `throwError` 传子类时，需 `ChildError as unknown as ErrorConstructor` 局部类型适配（class 语法子类不支持无 `new` 直接调用）

### 代码风格

- 全量走 Biome：`pnpm run check` 在 Phase 结束前必须零错误
- 注释原则：解释"为什么"而非"怎么做"；**严禁 TODO / FIXME 注释**
- 顶级 `export` 统一放文件末尾（`export { xxx }` 形式）
- 子目录文件拆分触发条件：单文件超过 `noExcessiveClassesPerFile` / `complexity` 阈值时，拆成 `foo/` 子目录 + `index.ts` barrel
- **路径别名**：跨目录 import 统一使用 `@/shared/...` 别名，**禁止 `../../` 这类多级相对路径**
  - ✅ `import { throwError } from '@/shared/throw-error'`
  - ✅ `import { getType } from '@/shared/utils/base'`
  - ❌ `import { throwError } from '../../throw-error'`
  - 同目录 / 单级父目录（`./xxx` / `../xxx`）仍用相对路径，保持局部耦合可见性
  - 测试文件引用被测模块也走别名：`import { createDraftSession } from '@/shared/lock-data/core/draft'`
  - 对标参考：`shared/animation/utils.ts` / `shared/data-handler/tools.ts` / `shared/priority-queue/utils.ts` / `shared/api-controller/utils.ts` 均采用此模式
- **循环形式**：数组/类数组遍历**优先使用索引 `for` 循环**而非 `for...of`
  - ✅ `for (let i = 0; i < arr.length; i++) { const item = arr[i]; ... }`
  - ❌ `for (const item of arr) { ... }`（数组场景）
  - **例外**：`Set` / `Map` / generator / 迭代器等不支持索引访问的容器**允许**使用 `for...of`（语言特性必需），但需在上下文中明确其为迭代器场景
  - 理由：索引 `for` 在 V8 优化路径上更稳定、可通过 `i` 访问上下文、break/continue 语义与异步循环转换更直观
- **空值兜底运算符**：**非必要场景优先使用 `||`**，仅在需要严格区分 null/undefined 与其他 falsy 值时保留 `??`
  - 保留 `??`（null/undefined 语义关键）：
    - `Map.get(key) ?? fallback`（Map 允许存 `0 / '' / false` 作为有效值）
    - `Storage.getItem(key) ?? fallback`（`null` = 不存在、`''` = 存在空串，语义不同）
    - JSON 解析结果兜底：`parsed.rev ?? 0`（`rev` 合法值包含 0）
  - 改用 `||`（非必要场景）：
    - 参数兜底：`const user = userAdapters || {}`
    - 配置 fallback 链：`user.clone || createSafeCloneFn(logger)`
    - 默认空容器：`list || []`、`ctx || {}`
  - 审查反问："该字段是否存在合法的 `0 / '' / false / NaN` 值？" —— 否则一律用 `||`
  - ✅ `const user = (userLogger || {}) as Partial<LoggerAdapter>`
  - ❌ `const user = (userLogger ?? {}) as Partial<LoggerAdapter>`（userLogger 不可能是合法 falsy，`??` 无收益）
- **logger 字段级混合兜底**：用户传入的 `LoggerAdapter` 可能只实现部分方法（`debug` 可选），内部流转的 logger 必须通过 `resolveLoggerAdapter(userLogger?)` 做字段级合并，产出三方法齐全的 `ResolvedLoggerAdapter`
  - 合并粒度：按 `warn / error / debug` **独立判定**，用户哪个字段缺失/非 function，该字段单独走默认 logger
  - 类型契约：内部模块（`clone.ts` / `authority.ts` / `channel.ts` / core 层）接受的 logger 参数一律声明为 `ResolvedLoggerAdapter`（三方法必选），**不接受原始 `LoggerAdapter`**
  - this 绑定：用户方法解析时 `.bind(userLogger)`，保证用户 logger 内部 `this` 正确
  - 一次解析全程复用：`pickDefaultAdapters` 产出后挂到 `entry.adapters.logger`，下游调用 `logger.debug(...)` 无需判空
  - ✅ `const logger: LoggerAdapter = resolveLoggerAdapter(user.logger)`（产物用作 entry.logger）
  - ❌ `const logger = user.logger ?? createDefaultLogger()`（对象级替换，会整体丢失用户部分字段）
  - ❌ 调用点 `logger.debug?.(...)` 判空（契约已保证存在，判空反而暗示不信任契约）

### 进度管理

- `IMPLEMENTATION.backup.md` 为不可修改的原始备份（永远保持 `[ ]` 初始态）
- **本文件**（IMPLEMENTATION.md）为实时进度看板，每完成一项**自动勾选** `[ ] → [x]`，无需用户确认
- 未完成条目保持 `[ ]`，且在括号内标注原因（如"Phase X 暂未实现：xxx"）
- Phase 整体完成后在三级标题末尾追加 `✅`（如 `### 1.1 constants / types / errors 骨架 ✅`）

---

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

### 1.1 constants / types / errors 骨架 ✅

- [x] 创建 `src/shared/lock-data/constants.ts`：`LOCK_PREFIX`、`NEVER_TIMEOUT: unique symbol` → [RFC#附录-a完整接口索引](./RFC.md#附录-a完整接口索引)
- [x] 创建 `src/shared/lock-data/types.ts`：搬运附录 A 的全部 interface 签名 → [RFC#附录-a完整接口索引](./RFC.md#附录-a完整接口索引)
- [x] 创建 `src/shared/lock-data/errors.ts`：`LockTimeoutError` / `LockRevokedError` / `LockDisposedError` / `LockAbortedError` / `ReadonlyMutationError` / `InvalidOptionsError`，所有抛错走 `shared/throw-error`（**实施调整**：因 biome `noExcessiveClassesPerFile` 规则，拆分为 `errors/` 子目录 + barrel） → [RFC#错误类型](./RFC.md#错误类型)（L333）
- [x] 验收：`pnpm run check` 类型通过；`errors.ts` 使用 `throwError` 而非 `throw new Error`（AGENTS.md 规范）

### 1.2 `core/readonly-view.ts`（深只读 Proxy） ✅

- [x] 实现 `createReadonlyView<T>(target)`：`Proxy` 拦截 `set` / `deleteProperty` / `defineProperty` 抛 `ReadonlyMutationError` → [RFC#只读代理实现要点](./RFC.md#只读代理实现要点)（L762）
- [x] `get` 命中对象类型惰性包装；用 `WeakMap<object, Proxy>` 缓存保证代理身份稳定 → [RFC#只读代理实现要点](./RFC.md#只读代理实现要点)
- [x] Set / Map 的 mutation 方法（Set: `add` / `delete` / `clear`；Map: `set` / `delete` / `clear`）拦截抛 `ReadonlyMutationError`；非 mutation 方法（`has` / `get` / `size` / `keys` / `values` / `entries` / `forEach` / `Symbol.iterator`）bind 到原始 target 避免 `Illegal invocation`
- [x] 验收：`__test__/core/readonly-view.node.test.ts` 覆盖嵌套对象 / 数组 / 代理身份一致性 / Set-Map 读写拦截 / Set-Map 迭代器 / actions 写入后读到最新值（20 用例全通） → [RFC#测试策略](./RFC.md#测试策略)（L1440）

### 1.3 `core/draft.ts`（事务式 Draft，self-contained） ✅

- [x] 文件顶部加迁移注释指向 RFC「外部化前瞻」小节 → [RFC#外部化前瞻可选迁移路径](./RFC.md#外部化前瞻可选迁移路径)（L875）
- [x] 实现 `DraftValidity` + `DraftSnapshot`（联合类型：`'property'` 记录 prevValue / `'collection'` 记录 Set-Map 整体克隆）+ `DraftContext` 数据结构 → [RFC#数据结构](./RFC.md#数据结构)（L774）
- [x] 实现 `createDraftSession(target)` 对外入口 + 内部 `createDraftProxy(target, ctx, parentPath, targetId)`：Proxy `get` / `set` / `deleteProperty` 三个拦截器，惰性递归子 draft，共享同一 ctx → [RFC#draft-proxy-行为](./RFC.md#draft-proxy-行为)（L792）
- [x] 实现 Set / Map mutation 追踪：`add` / `set` / `delete` / `clear` 方法被替换为包装函数，触发 snapshot 整体克隆 + 推入 `LockDataMutation`（扩展 op：`set-add` / `set-delete` / `set-clear` / `map-set` / `map-delete` / `map-clear`）
- [x] 实现 `applyRollback` + `restoreCollection`：`property` 类型按路径逆序写回；`collection` 类型整体 clear 后灌回 clone → [RFC#关键实现要点](./RFC.md#关键实现要点)（L863）
- [x] 实现 `freezeMutations`：深冻结 mutations（包含 `path` 本身），供 `onCommit` 暴露时防止外部 mutate → [RFC#提交流程commit](./RFC.md#提交流程commit)（L824）
- [x] 验收：`__test__/core/draft.node.test.ts` 覆盖对象属性 set/delete / 嵌套路径 / 数组元素 / Set 3 种 mutation / Map 3 种 mutation / 属性+集合 rollback / commit-rollback-dispose 后再写入抛错 / mutation log 冻结（24 用例全通） → [RFC#测试策略](./RFC.md#测试策略)
- [x] 范围说明：`replace(next)` 是 Phase 5 `Actions` 层的方法（对应 RFC「Actions 实现要点」），不属于 Draft 层自治契约；`force` / `holdTimeout` 的**触发路径**属于 Actions 层，Draft 层本身的"外部置 `validity.isValid=false` 后写入立即抛错"契约已在本阶段通过 `commit` / `rollback` / `dispose` 三个入口的用例完整验证

### 1.4 `core/signal.ts`（AbortSignal 合并封装） ✅

- [x] 实现 `anySignal(signals)` + `signalWithTimeout(baseSignal, timeoutMs)`：优先使用 `AbortSignal.any`，兼容环境用事件绑定 polyfill → [RFC#actions-实现要点](./RFC.md#actions-实现要点)（L930，见 `AbortSignal 组合` 要点）
- [x] 验收：`__test__/core/signal.node.test.ts` 覆盖多信号合并 / 单路 abort 传播 / 已 aborted 信号的即时触发 / 超时场景（9 用例全通）

---

## Phase 2 — 适配器层

依赖 Phase 1 的 types / errors。**关键点**：每个默认适配器都要有"环境探测 → 不可用时返回 null"的兜底分支。

### 2.1 `adapters/logger.ts` ✅

- [x] 实现默认 `LoggerAdapter`：委托到 `shared/logger` → [RFC#默认实现](./RFC.md#默认实现)（L1047）
- [x] 验收：`warn` / `error` / `debug` 三个方法齐全（`__test__/adapters/logger.node.test.ts`，6 用例全通）

### 2.2 `adapters/clone.ts` ✅

- [x] 实现 `createSafeCloneFn(logger?)`：`structuredClone` 优先 + JSON fallback + `logger.warn/error` → [RFC#默认实现](./RFC.md#默认实现)
- [x] 三层降级：原生 `structuredClone` → JSON.parse/stringify → 返回原值（最后一道防线）
- [x] 工厂构造阶段一次性探测 `structuredClone` 可用性，避免每次 clone 重复探测
- [x] 验收：`__test__/adapters/clone.node.test.ts` 覆盖 structuredClone 可用 / 不可用 / 对单个 value 失败（function）/ JSON 失败（循环引用）/ 探测抛错 / logger 未注入 六类分支（8 用例全通）

### 2.3 `adapters/authority.ts`（默认 localStorage 实现） ✅

- [x] 实现 `createDefaultAuthorityAdapter(ctx, deps)`：`read` / `write` / `remove` / `subscribe(storage event)` → [RFC#接口定义](./RFC.md#接口定义)（L982，`AuthorityAdapter`）
- [x] 写入 `QuotaExceededError` 捕获；通过 `logger.warn` 降级，不向上抛 → [RFC#接口定义](./RFC.md#接口定义)
- [x] 能力探测：用 **写-删探测法** 判定 localStorage 真实可用性（规避 Safari 隐私模式下 `typeof localStorage === 'object'` 但 setItem 抛错的场景）；不可用时工厂返回 null → [RFC#默认实现](./RFC.md#默认实现)
- [x] `subscribe` 严格过滤：仅响应同 key + `storageArea === localStorage` 的 `storage` 事件；订阅回调异常走 `logger.error` 隔离
- [x] key 契约：`buildAuthorityKey(id)` 固化为 `${LOCK_PREFIX}:${id}:latest`
- [x] 验收：`__test__/adapters/authority-memory.node.test.ts`（内存替身，11 用例）+ `__test__/adapters/authority.browser.test.ts`（真 localStorage，4 用例），共 15 用例全通

### 2.4 `adapters/channel.ts`（默认 BroadcastChannel 实现） ✅

- [x] 实现 `createDefaultChannelAdapter(ctx, deps)`：`postMessage` / `subscribe` / `close` → [RFC#接口定义](./RFC.md#接口定义)（L982，`ChannelAdapter`）
- [x] 能力探测：构造器存在 + 构造可执行，双重探测；不可用时工厂返回 null → [RFC#默认实现](./RFC.md#默认实现)
- [x] `close` 幂等；关闭后 `postMessage` / `subscribe` 降级为 noop 并 warn（上层语义错误）
- [x] 订阅回调异常走 `logger.error` 隔离，不污染其他订阅者与后续消息
- [x] key 契约：`buildChannelName(id, channel)` 固化为 `${LOCK_PREFIX}:${id}:${channel}`（channel ∈ `'session' | 'custom'`）
- [x] 验收：`__test__/adapters/channel.node.test.ts`（node + mock BroadcastChannel，11 用例）
- [x] **范围说明**：真实浏览器下同 Tab 的两个 `BroadcastChannel` 实例**不会互相收到自己 postMessage 的消息**（规范所致），真跨 Tab 的广播能力属于 Phase 4 `authority/integration.browser.test.ts` 集成测试范畴；本阶段只验证代理封装契约，故测试布局从 `channel.browser.test.ts` 改为 `channel.node.test.ts` + mock BroadcastChannel

### 2.5 `adapters/session-store.ts`（默认 sessionStorage 实现） ✅

- [x] 实现 `createDefaultSessionStoreAdapter(ctx, deps)`：纯同步 `read` / `write` → [RFC#接口定义](./RFC.md#接口定义)（L982，`SessionStoreAdapter`）
- [x] 能力探测：同 authority 的写-删探测法；`sessionStorage` 不可用时工厂返回 null，降级 warn 明示 `'session'` → `'persistent'` 的转换 → [RFC#默认实现](./RFC.md#默认实现)
- [x] `write` 的 `QuotaExceededError` 降级仅 warn（epoch 丢失会被下一次 session-probe 协议自愈，不会造成数据一致性问题）
- [x] key 契约：`buildSessionStoreKey(id)` 固化为 `${LOCK_PREFIX}:${id}:epoch`
- [x] 验收：`__test__/adapters/session-store.node.test.ts`（9 用例）+ `__test__/adapters/session-store.browser.test.ts`（5 用例），共 14 用例全通

### 2.6 `adapters/index.ts`（pickDefaultAdapters 聚合） ✅

- [x] 实现 `pickDefaultAdapters(userAdapters?) => ResolvedAdapters<T>`：用户提供 > 默认实现 > null → [RFC#设计原则](./RFC.md#设计原则)（L974）
- [x] `logger` / `clone` 优先解析为实例，其他 adapter 工厂构造时复用同一个 logger，保证所有降级日志的出口一致
- [x] `getAuthority` / `getChannel` / `getSessionStore` 保留工厂形态；用户工厂返回 `null` 时自动 fallback 到默认工厂（允许用户按 ctx 选择性自定义）
- [x] `getLock` 原样透传（由 Phase 3 drivers 层解释）
- [x] 验收：`__test__/adapters/index.node.test.ts` 覆盖空对象全默认 / logger 用户覆盖 + 传递性 / clone 透传 / 三个工厂的"用户非 null 用用户" + "用户 null 走默认" + "未提供走默认" / getLock 透传 / 工厂独立性（17 用例全通）

### Phase 2 收口 ✅

- [x] 批量回归：`pnpm run test:ci src/shared/lock-data/__test__/adapters/` 共 8 文件 **71 用例全通**（node 6 文件 62 用例 + browser 2 文件 9 用例）
- [x] `read_lints` 全净：`adapters/*` 实现文件 + `__test__/adapters/*` 测试文件零 lint 错误
- [x] 所有适配器共享契约：**能力探测 → 不可用返回 null + 统一 logger 降级 + key 遵循 `${LOCK_PREFIX}:${id}:${suffix}` 规范**，为 Phase 3 锁驱动层的"能力优先级降级链"打好基础

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
- 每完成一个 `[x]` 勾选时，跑**该条目对应的测试目录**（如 Phase 1 改 `core/draft.ts` 就跑 `pnpm run test:ci src/shared/lock-data/__test__/core/draft.node.test.ts`），与顶部「测试运行约定」保持一致，严禁每次都跑全仓 `test:ci`
- Phase 整体收口前（`### x.x ✅` 标记之前），按 Phase 对应的目录跑一次 `pnpm run test:ci src/shared/lock-data/__test__/<phase-dir>/` 做批量回归
- 若 Phase 3/4 发现与 RFC 设计不符的实际问题，走"RFC 版本 +1"流程（修订 RFC，递增到 1.0.x）
- 跨 Phase 严格串行（与「总体路线图」一致）：严禁在前一个 Phase 未收口（全部 `[x]` + 对应目录测试通过）时开启下一个 Phase；Phase 内部各子任务可并行推进

## 相关文档

- **设计源头**：[`./RFC.md`](./RFC.md) (0.1.4, accepted on 2026/04/29)
- **编码规范**：[`../../../AGENTS.md`](../../../AGENTS.md)（报错走 `shared/throw-error`）
- **项目测试约定**：[`../../../vitest.config.ts`](../../../vitest.config.ts)
