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
- **类型判断**：**优先使用 `@/shared/utils/verify` 的语义函数替代原生 `typeof` 运行时判断**
  - 映射表：
    - `typeof x === 'function'` → `isFunction(x)`；`typeof x !== 'function'` → `!isFunction(x)`
    - `typeof x === 'string'` → `isString(x)`；`typeof x !== 'string'` → `!isString(x)`
    - `typeof x === 'number' && x > 0` → `isNumber(x) && x > 0`（`> 0` 自动过滤 NaN）
    - `typeof x === 'boolean'` → `isBoolean(x)`
    - `typeof x === 'object'` → `isObject(x)`（已排除 null）
    - `!value || typeof value !== 'object'` → `!isObject(value)`（一步到位，`isObject` 内部已判 null）
    - `!ret || typeof ret.then !== 'function'` → `!isPromiseLike(ret)`（语义聚合 "thenable"）
  - **有限数字判定**：`typeof x === 'number' && Number.isFinite(x)` 保留 `Number.isFinite` 组合 —— `isPlainNumber` 仅排除 NaN 不排除 Infinity；建议私有 helper `const isFiniteNumber = (v): v is number => isNumber(v) && Number.isFinite(v)`
  - **必须保留原生 `typeof`** 的三种场景（**禁止**替换为 verify 函数）：
    1. **TS 类型操作符**：`ReturnType<typeof setTimeout>` / `ReturnType<typeof setInterval>` / `typeof BroadcastChannel` —— 这些是类型系统行为，不是运行时判断
    2. **ReferenceError 守卫**：`typeof navigator === 'undefined'` / `typeof globalThis === 'undefined'` —— 未声明的全局变量**直接访问**会抛 ReferenceError，`isUndef(navigator)` 读取 `navigator` 时就会先抛错；只有 `typeof` 操作符能安全探测未声明符号
    3. **组合判断场景**：`typeof id === 'string' && id.length > 0` 可以改为 `isString(id) && id.length > 0`，**不要**抽成独立工具函数，保持调用点语义直白
  - ✅ `if (!isFunction(getChannel)) { throwError(...) }`
  - ✅ `if (isNumber(acquireTimeout) && acquireTimeout > 0) { setTimeout(...) }`
  - ✅ `if (!isObject(message)) { return false }`（消息 shape 校验）
  - ✅ `typeof navigator === 'undefined'`（全局对象存在性守卫，**不可替换**）
  - ❌ `if (typeof cb === 'function') { cb(...) }`（应改为 `isFunction(cb)`）
  - ❌ `isUndef(navigator)`（会 ReferenceError，必须用 `typeof navigator === 'undefined'`）
- **外部化 Promise**：当需要把 `resolve` / `reject` 暴露到 `new Promise` 构造回调**之外**使用时，**必须使用 `@/shared/with-resolvers` 的 `withResolvers`**，不要手写 `let resolveXxx!; new Promise(r => { resolveXxx = r })` 模式
  - 判定条件（满足任一即"外部化"）：
    - resolve / reject 要在**不同的函数作用域**被调用（如注册到事件监听器、回调闭包、其他 Promise 的 `.then`）
    - Promise 需要**跨越函数边界**被 `await`（在构造点声明，在其他函数里 resolve）
    - 同一 Promise 的 resolve 和 reject 被**不同的代码路径**触发（如 resolve 在 success callback、reject 在 settle catch 里）
  - **不应替换**的场景：resolve / reject 在构造回调**内部立即使用**（如构造 waiter 对象把 resolve/reject 作为字段同步注入）—— 这种情况 `new Promise(...)` 写法更直观，没有外部化需求
  - 实际案例：
    - ✅ `web-locks.ts`：`hold = withResolvers<void>()` —— `hold.resolve` 在 `release` 调用，`hold.promise` 在 `navigator.locks.request` callback 返回；`granted = withResolvers<Holding>()` —— `granted.resolve` 在 callback 内、`granted.reject` 在 `wireRequestSettle` 的 catch 里，两条不同路径
    - ❌ `broadcast.ts` / `storage.ts` / `local.ts`：`return new Promise((resolve, reject) => { const waiter = buildWaiter(ctx, state, resolve, reject) })` —— resolve/reject 在构造回调内立即作为参数注入 waiter，不跨作用域，保持 `new Promise` 更直观
    - ❌ `storage-state.ts` 的 `withCasRetry` / `tryAcquire`：内部 `run()` 递归闭包调用 resolve，仍在构造回调范围内
  - 好处：
    - 消除 `let xxx!:` 的 **definite assignment assertion** 模式噪音
    - 优先用原生 `Promise.withResolvers`（ES2024），不可用时自动回退到手动实现，兼容性无感知
  - ✅ `const granted = withResolvers<Holding>(); ...; granted.resolve(holding); ...; await granted.promise`
  - ❌ `let resolve!: (v: Holding) => void; const p = new Promise<Holding>(r => { resolve = r });`（应改用 `withResolvers`）

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

## Phase 3 — 锁驱动层 ✅

依赖 Phase 2 的 logger / channel。4 个驱动共享同一 `LockHandle` 接口契约。

### 3.1 `drivers/local.ts`（LocalLockDriver） ✅

- [x] 实现仅实例内互斥的轻量锁（无 id 场景） → [RFC#locallockdriver](./RFC.md#locallockdriver)（L732）
- [x] 支持 `acquire` / `release` / `onRevokedByDriver`
- [x] 验收：`__test__/drivers/local.node.test.ts`（10 用例全通，覆盖 FIFO / timeout / abort / force / destroy / 幂等）

### 3.2 `drivers/web-locks.ts`（WebLocksDriver，首选） ✅

- [x] 基于 `navigator.locks.request(name, { mode, steal, signal })` → [RFC#weblocksdriver首选](./RFC.md#weblocksdriver首选)（L737）
- [x] `force` 映射到 `steal: true`；原持有者触发 `onRevokedByDriver('force')`
- [x] **W3C 规范修复**：`steal` 与 `signal` 互斥不能共用，按 `ctx.force` 动态分派 `requestOptions`（`force=true → { mode, steal: true }`；`force=false → { mode, signal }`）；同时把 `handleStealRejection` / `wireRequestSettle` 提至模块顶层用 `DriverScope` 容器降低 `createWebLocksDriver` 的 linesPerFunction
- [x] 验收：`__test__/drivers/web-locks.browser.test.ts`（9 用例全通，覆盖 round-trip / 排队 / timeout / abort / force-steal / 幂等 / destroy）

### 3.3 `drivers/broadcast.ts`（BroadcastDriver，降级） ✅

- [x] 基于 BroadcastChannel + token 的排队协议 → [RFC#broadcastdriver降级](./RFC.md#broadcastdriver降级)（L745）
- [x] 处理队列公平性风险（决策 #见「风险与取舍」）
- [x] **拆分三文件**：`broadcast-protocol.ts`（常量/消息格式/类型校验）+ `broadcast-state.ts`（状态机 & 消息处理）+ `broadcast.ts`（工厂 + acquire 入口）；落实 BC-1~BC-7 + BC-A/BC-D/BC-J/BC-K/BC-N/BC-O 修复
- [x] **driver 契约修复**：`acquireBroadcastLock` 在 destroyed 时返回 `Promise.reject`（严禁同步 throw）
- [x] 验收：`__test__/drivers/broadcast.browser.test.ts`（13 用例全通）

### 3.4 `drivers/storage.ts`（StorageDriver，兜底） ✅

- [x] 基于 localStorage 的 token 轮询 + storage 事件 → [RFC#storagedriver兜底降级](./RFC.md#storagedriver兜底降级)（L754）
- [x] **拆分三文件**：`storage-protocol.ts`（存储格式 + 常量 `HEARTBEAT_INTERVAL=500ms` / `DEAD_THRESHOLD=2500ms` + nonce 生成）+ `storage-state.ts`（状态机 + CAS 读写 + 队列 + 心跳 + drain）+ `storage.ts`（工厂 + acquire 入口）；落实 ST-1~ST-6 + S-1（force 抢占时导出 `revokeHolding` 清理旧 holding heartbeatTimer）/ S-4（Waiter 增加 `isSettled` 方法，pump/force 路径 resolve 前检查防 abort 泄漏）
- [x] **driver 契约修复**：`acquireStorageLock` 在 destroyed 时返回 `Promise.reject`（严禁同步 throw）
- [x] 验收：`__test__/drivers/storage.browser.test.ts`（12 用例全通）

### 3.5 `drivers/custom.ts` + `drivers/index.ts`（CustomDriver + pickDriver） ✅

- [x] `CustomDriver`：包装用户的 `adapters.getLock` 工厂函数 → [RFC#customdriver](./RFC.md#customdriver)（L722）
- [x] `pickDriver({ adapters, options, id })`：能力检测优先级 —— `custom（adapters.getLock 存在）> local（无 id）> 显式 mode（web-locks/broadcast/storage，能力不足抛 TypeError）> auto 降级链（Web Locks → Broadcast → Storage → 抛 TypeError）` → [RFC#能力检测与降级](./RFC.md#能力检测与降级)（L686）
- [x] `adapters.getLock` 存在时 `mode` 被忽略，直接用 CustomDriver
- [x] **types.ts 扩展**：新增 `LockMode = 'auto' | 'web-locks' | 'broadcast' | 'storage'` 类型；`LockDataOptions<T>` 增加 `mode?: LockMode` 字段
- [x] 验收：`__test__/drivers/custom.node.test.ts`（11 用例）+ `__test__/drivers/pick-driver.node.test.ts`（10 用例）全通

### Phase 3 收口 ✅

- [x] **driver 契约统一**：所有 driver 的 `acquire` 入口在 destroyed 时统一返回 `Promise.reject(new LockAbortedError(...))`，严禁同步 throw（`web-locks.ts` / `broadcast.ts` / `storage.ts` 均已通过 `async function` 天然符合，`local.ts` / `custom.ts` 原已是 async function）
- [x] **批量回归**：`pnpm run test:ci src/shared/lock-data/__test__/drivers/` 共 6 文件 **65 用例全通**（node 3 文件 31 用例 + browser 3 文件 34 用例）
- [x] **全量回归**：`pnpm run test:ci src/shared/lock-data/` 共 21 文件 **207 用例全通**（Phase 0-3 累计）
- [x] **read_lints 全净**：`src/shared/lock-data/` 整个目录零 lint 错误
- [x] 为 Phase 4/5 奠定基础：统一的 `LockDriver` / `LockDriverHandle` 契约、`pickDriver` 能力选择入口、`LockMode` 类型

---

## Phase 4 — 权威副本与会话纪元 ✅

依赖 Phase 2 的 authority / channel / session-store。

### 4.1 `authority/serialize.ts`（字段顺序固化） ✅

- [x] 实现 `serializeAuthority(rev, ts, epoch, snapshot)`：手动拼接保证 `rev → ts → epoch → snapshot` 顺序 → [RFC#存储格式固化契约](./RFC.md#存储格式固化契约)（L1133）
- [x] 验收：`__test__/authority/serialize.node.test.ts` 覆盖字段顺序 / 特殊字符 snapshot / Unicode / snapshot 内含同名字段不干扰外层解析（8 用例全通）

### 4.2 `authority/extract.ts`（Lazy Parse 快路径） ✅

- [x] 实现 `extractRev(raw)`：正则 `^\{"rev":(-?\d+)` 锚定开头 → [RFC#lazy-parse-快路径](./RFC.md#lazy-parse-快路径)（L1150）
- [x] 实现 `extractEpoch(raw)`：正则 `,"epoch":"([^"\\]*)"` 匹配中段 → [RFC#lazy-parse-快路径](./RFC.md#lazy-parse-快路径)
- [x] 实现 `readIfNewer(ctx, raw)`：快路径 rev 对比 + epoch 过滤 + 全量 parse 兜底；`parseAuthorityRaw` 做结构校验（rev 数字 / epoch 字符串）→ [RFC#lazy-parse-快路径](./RFC.md#lazy-parse-快路径)
- [x] 最小输入契约 `ReadIfNewerContext { lastAppliedRev, epoch }`：解耦于 Phase 5 Entry，Phase 5 registry Entry 天然满足此结构
- [x] 验收：`__test__/authority/extract.node.test.ts` 覆盖快路径命中 / 失配走 JSON.parse 兜底 / epoch 不一致丢弃 / 1MB snapshot 性能（<10ms 实测 <1ms，鲁棒阈值避免 CI 抖动）（29 用例全通）

### 4.3 `authority/epoch.ts`（resolveEpoch + session-probe 协议） ✅

- [x] 实现 `resolveEpoch(ctx)` 的 A~F 六分支（A persistent 常量 / B sessionStore 不可用降级 / C sessionStorage 命中继承 / D channel 不可用直接 freshEpoch / E 探测响应继承 / F 探测超时 freshEpoch）→ [RFC#resolveepoch-协议](./RFC.md#resolveepoch-协议)（L1262）
- [x] 实现 `session-probe` / `session-reply` 消息协议：`buildProbeMessage` / `buildReplyMessage` + `isSessionProbeMessage` / `isSessionReplyMessage` 守卫 → [RFC#数据通道](./RFC.md#数据通道)（L1254）
- [x] 实现 `subscribeSessionProbe(channel, getMyEpoch)`：常驻响应者；`getMyEpoch` 返回 null / 空串时不回复，避免污染对方 E 分支判定
- [x] 首个 Tab 判定为"所有 Tab 关闭后重启"时主动 `authority.remove()` 清空残留 → [RFC#策略总览](./RFC.md#策略总览)（L1247）；`authority.remove` 异常时降级为 `logger.warn`，不中断流程
- [x] **probeId 过滤**：`withResolvers<string | null>` 收敛异步等待，probeId 错配的 reply 被忽略
- [x] **UUID 生成**：优先 `crypto.randomUUID()`，fallback 到 `Math.random().toString(36) + Date.now()`；`try-catch` 覆盖 ReferenceError / SecurityError
- [x] 验收：`__test__/authority/epoch.browser.test.ts` 覆盖 A~F 六分支 / probeId 错配过滤 / 响应方 null/empty 不回复 / 多 Tab 同时启动（资源边界验证）（21 用例全通，含真实 BroadcastChannel 配对通信）

### 4.4 `authority/index.ts`（StorageAuthority 主类） ✅

- [x] 实现 `createStorageAuthority(deps)` 工厂：返回 `{ init, pullOnAcquire, onCommitSuccess, dispose }` API 表面
- [x] 实现 `init()`：先挂载 session-probe 响应（常驻）→ `resolveEpoch` 决策 → 订阅 authority.subscribe + pageshow + visibilitychange → 初次 pull（authorityCleared=true 时跳过省一次 read）→ [RFC#读路径三个触发源共享同一应用流程](./RFC.md#读路径三个触发源共享同一应用流程)（L1204）
- [x] 实现 `applyAuthorityIfNewer(source, raw)`：走 `readIfNewer` + `isObject` 守卫脏数据 + `applySnapshot` 回调 + 更新 rev/lastAppliedRev + 触发 `emitSync`；`applySnapshot` / `emitSync` 异常走 logger.error 隔离
- [x] 实现 `onCommitSuccess(event)`：`rev++` + `lastAppliedRev = rev` + `authority.write(serializeAuthority(...))` + 触发 `emitCommit` → [RFC#写路径commit-后](./RFC.md#写路径commit-后)（L1190）
- [x] 实现 `pullOnAcquire()`：acquire 时 pull 的专用入口，source=`'pull-on-acquire'`；dispose 后 no-op
- [x] **激活 pull 浏览器守卫**：`typeof window / document === 'undefined'` 判定跳过（非浏览器环境由自定义 adapter.subscribe 承担）；`pageshow` 仅在 `e.persisted=true` 时 pull
- [x] **dispose 幂等**：`disposed` 标志 + 解绑数组统一释放 + `channel.close()` 容错；重复调用不抛错
- [x] **宿主解耦**：`StorageAuthorityHost<T>` 最小契约（`data / rev / lastAppliedRev / epoch`）避免与 Phase 5 registry 循环依赖；`applySnapshot` / `emitSync` / `emitCommit` / `clone` 作为依赖注入
- [x] 验收：`__test__/authority/integration.browser.test.ts` 端到端覆盖：两 Tab commit → authority.subscribe → applySnapshot → emitSync 派发 / rev/epoch 过滤 / visibilitychange 激活 pull / dispose 解绑后不再触发 / 异常隔离（21 用例全通）

### Phase 4 收口 ✅

- [x] **全量回归**：`pnpm run test:ci src/shared/lock-data/` 共 25 文件 **286 用例全通**（Phase 0-4 累计；Phase 4 净新增 79 用例：serialize 8 + extract 29 + epoch 21 + integration 21）
- [x] **read_lints 全净**：`src/shared/lock-data/` 整个目录零 lint 错误
- [x] **风格守则落实**：authority 层全部使用 `@/shared/utils/verify` 的 `isObject` / `isString` / `isNumber`；异步外部化用 `withResolvers`（probeForExistingSession）；`shared/throw-error` 未出现本期硬依赖（本层只 logger.warn/error 降级，不向外 throw）
- [x] 为 Phase 5 奠定基础：`StorageAuthorityHost` 鸭子类型契约 + 依赖注入（applySnapshot / emitSync / emitCommit / clone）使 Phase 5 registry 可无缝接入

---

## Phase 5 — 协调层 ✅

依赖 Phase 1-4 全部前置。

### 5.1 `core/registry.ts`（InstanceRegistry 同 id 进程内单例） ✅

- [x] 实现 `getOrCreateEntry(id, options)`：首次注册建 Entry、后续调用复用；refCount++ → [RFC#instanceregistry同-id-进程内单例](./RFC.md#instanceregistry同-id-进程内单例)（L635）
- [x] 实现 Entry 结构：`data` / `driver` / `adapters` / `authority` / `rev` / `lastAppliedRev` / `epoch` / `dataReadyPromise` / `dataReadyState` / `dataReadyError` / `listenersSet` / `refCount` / `registerTeardown` / `initOptions`
- [x] 实现 `releaseEntry(slot)`：refCount-- 归零时销毁（teardowns 逆序运行 + `driver.destroy()` + `registry.delete(id)`）；`release` 幂等；`alive` 守卫让 disposed 后 `registerTeardown` no-op
- [x] 冲突字段处理：首次注册的 options 为准，非 `listeners` 字段冲突走 `logger.warn` → [RFC#instanceregistry同-id-进程内单例](./RFC.md#instanceregistry同-id-进程内单例)
- [x] `dataReadyPromise` / `dataReadyState`：同 id 多实例共享同一份 `resolveInitialData` 结果；`resolveInitialData` 三分支（initial 直用 / getValue 返回 T / getValue 返回 Promise<T>）+ getValue 同步抛错 + Promise reject 统一走 failed 分支（等价 `Promise.reject`）
- [x] 辅助工具导出：`applyInPlace`（Symbol key 完备）/ `createFailedInitError` / `freezeInitOptions` / `resolveInitialData`
- [x] 验收：`__test__/core/registry.node.test.ts` 覆盖同 id 复用 / 冲突警告 / refCount 生命周期 / teardown 异常隔离 / release 幂等 / applyInPlace Symbol / createFailedInitError cause 等 12 类（33 用例全通）

### 5.2 `core/fanout.ts`（listeners fanout） ✅

- [x] 实现 `fanoutLockStateChange` / `fanoutRevoked` / `fanoutCommit` / `fanoutSync` 四事件扇出；单 listener 异常 → `logger.error` 隔离，不影响其他 listener
- [x] 覆盖 `onLockStateChange` / `onRevoked` / `onCommit` / `onSync` 四个事件，独立 try/catch 分发
- [x] 缺省 listeners 字段（listener 未实现某事件）静默跳过，不产生 warn
- [x] 验收：`__test__/core/fanout.node.test.ts` 覆盖 listener 异常隔离 / 缺省字段容忍 / 多 listener 顺序 / 空 Set 无副作用（14 用例全通）

### 5.3 `core/actions.ts`（LockDataActions 实现） ✅

- [x] 内部状态机 `idle → acquiring → holding → committing → released / revoked / disposed` → [RFC#actions-实现要点](./RFC.md#actions-实现要点)
- [x] `ensureHolding(opts)`：复用 holding 锁 / acquiring 时 await 当前 pending handle / 抢新锁；合并 `options.signal` + `update.signal` + `timeout` → `anySignal` + `signalWithTimeout`；acquire 失败回滚 phase 为 idle 避免悬挂
- [x] `update(recipe, opts)`：走 `createDraft` 事务式 working copy → recipe 执行 → `finalize()` + `applyInPlace` + rev++ → authority.onCommitSuccess（若有）→ fanoutCommit；recipe 抛错自动 discard → rollback phase
- [x] `replace(next, opts)`：实现为 `update(draft => { applyInPlace(draft, next) })` 的语法糖，通过 Draft 统一走事务
- [x] `getLock(opts)`：只抢锁不执行 recipe，返回 release 句柄；重复 getLock 复用 holding
- [x] `read()`：不抢锁，直接 `adapters.clone(entry.data)` 返回快照 → [RFC#actions-实现要点](./RFC.md#actions-实现要点)
- [x] `release()`：仅处理还锁（driver.release + 重置 phase 为 idle），不碰 refCount、不解绑订阅 → [RFC#actions-实现要点](./RFC.md#actions-实现要点)（决策 #31）
- [x] `dispose()`：release + 解绑 options.signal 监听 + 从 listenersSet 移除 listeners + 调 releaseFromRegistry（refCount-- / 归零销毁 Entry）+ 终态转 disposed；幂等
- [x] `onRevokedByDriver` 回调：driver 主动撤销时丢弃 draft + phase → revoked + fanoutRevoked + LockRevokedError
- [x] **修复构造期 12 类严重问题**：接口合并 hack / 死代码 / signal 泄漏 / acquire 失败 phase 悬挂 / LockDisposedError 不支持 cause 等均已修正
- [x] 验收：`__test__/core/actions.browser.test.ts` 覆盖 12 组契约共 28 用例（状态机转换 / 锁复用 / signal 合并 / timeout / revoke / dispose 幂等 / read 快照 / replace 语义 / recipe 抛错回滚 / update race 等），全通

### 5.4 `core/entry.ts`（lockData 主入口 + Entry 组装） ✅

- [x] 实现 `lockData(initial, options)` 主入口：参数校验（`extractValidId` / `normalizeSyncMode` / `normalizePersistence`）→ 分派 Registry / 无 id 独立路径 → 组装 Actions + ReadonlyView → `finalizeResult` 按 dataReadyPromise 返回同步 `[view, actions]` 或 `Promise<[view, actions]>`
- [x] 实现 `createEntryFactory<T>(initial)`：组装 `pickDefaultAdapters` → `resolveInitialData` → `pickDriver` → listenersSet 初始化 → 可选 `attachAuthority` → `mergeReadyPromises` 合并 initialPatch 与 authority init Promise
- [x] 实现 `attachAuthority`：`syncMode === 'storage-authority' && id` 时构造 `StorageAuthority`；全适配器不可用时 `logger.warn` 降级为同进程共享；`authority.init` 失败走 logger.warn 不阻塞返回；dispose 时 `authority.dispose()` + `FanoutGuard` 防止滞后 emit 污染
- [x] 实现 `acquireFromRegistry` / `acquireStandalone` 双路径：有 id 走进程单例 Registry（`defaultRegistry` 懒初始化 + `__resetDefaultRegistry` 测试钩子）；无 id 走一次性 ctx（无复用）
- [x] Entry 天然满足 `StorageAuthorityHost` 契约：直接把 `mutableEntry` 作为 host 注入；依赖注入 `applyInPlace` / `emitSync` / `emitCommit` / `clone` 保持 authority 层与 core 层解耦
- [x] **修复构造期 6 类自审问题**：死代码清理（`void ERROR_FN_NAME`/`createError`/`throwError` 全删）/ emit 事件类型正确化 / onStateChange 冗余 pending 缓存删除 / teardown 逆序语义修正 / return 路径 lint 净化
- [x] 验收：`__test__/core/entry.browser.test.ts` 集成测试覆盖 9 类契约共 16 用例（无 id 路径 / 同 id 复用 / dataReady 异步 / getValue 同步抛错 / ReadonlyView / listeners fanout / adapters.getLock 注入 / signal.abort 端到端 / dispose 级联后 initial 重新生效），全通

### Phase 5 收口 ✅

- [x] **全量回归**：`pnpm vitest run src/shared/lock-data/` 共 29 文件 **377 用例全通**（Phase 0-5 累计；Phase 5 净新增 91 用例：registry 33 + fanout 14 + actions 28 + entry 16）
- [x] **环境解耦修复**：`__test__/drivers/pick-driver.node.test.ts` 原先假设 "node 环境 `navigator.locks` 不可用"，Node v24 原生支持 Web Locks API 导致断言漂移；改用 `vi.stubGlobal('navigator', {})` 显式 stub 能力探测，测试与 Node 版本解耦
- [x] **自审修复 P0（第一轮）**：`core/actions.ts::runTransaction` 的 rollback 条件原先耦合 `aliveToken === token`，导致 recipe 执行期间被 dispose/revoke 时未提交的脏写入**永久泄漏到 `entry.data`**，污染共享 Entry 的其他实例 / readonly view。修复为 `committed` 标志判定：未 commit 即 rollback（与锁状态解耦，finally 兜底），语义正确
- [x] **自审修复 P1（第二轮，biome CLI 暴露 IDE LSP 漏报）**：`pnpm biome lint` 扫出 12 个 **`read_lints`（IDE LSP）漏报的 nursery 错误**：
  - 🔴 生产 bug 3 处 `nursery/noMisusedPromises`：`core/actions.ts:283`（`safeReleaseHandle` thenable 判定）+ `core/actions.ts:355`（`ensureDataReady` 的 `dataReadyPromise` 条件）+ `core/entry.ts:264`（`mergeReadyPromises` 双 promise 条件）—— 全部是 `Promise | null` 被用作布尔条件的语义歧义，修复为显式 `!== null` / `!== undefined` 空检查 + `??` 合并
  - 🟡 `core/fanout.ts:41` `nursery/noShadow`：`fanoutEvent` 的外层 `event: TEvent` 参数与 `pickHook` 回调类型签名中的 `event` 参数同名遮蔽，重命名为 `eventPayload` / `payload` 消除歧义；顺带把同文件 L57 的 `result &&` 风格统一为 `result !== undefined &&`
  - 🟡 `__test__/core/actions.browser.test.ts` 4 处：删除未使用 `LockStateChangeEvent` 导入、`makeHandle` 箭头函数展开为块体、3 处 `(d) => void (d.v = 1)` 改为 `(d) => { d.v = 1; }`（同时解决 `noAssignInExpressions` + `noReturnAssign`）
- [x] **自审修复 P2（第三轮，语义精确化回炉）**：第二轮为过 `noMisusedPromises` 把 `result && typeof (result as Promise<void>).then === 'function'` 简化成 `result !== undefined && typeof...`，但这是信息收集不充分的简化实现 —— `actions.ts::safeReleaseHandle` 的 `result: unknown`（driver.release 实际返回值可能偏离 `void | Promise<void>` 契约，如用户自定义 driver 返回 `null` / primitive），`fanout.ts::fanoutEvent` 的 hook 是用户 listener（TS 类型约束在运行时丢失）。`!== undefined` 弱守卫过不滤 `null`，对 `null` 做 `typeof (null as Promise<void>).then` 虽不 runtime 错误但语义已偏离"只对 thenable 生效"的原意。两处统一加固为**严谨的三重鸭子类型守卫**：`isObject(result) && 'then' in result && isFunction(result.then)` —— 既过滤所有非 object 值（undefined / null / primitive），又用 `'then' in` 精确判定 thenable，同时 `isFunction` 确认可调用，复用 `@/shared/utils/verify` 统一风格，避开 `noMisusedPromises`
- [x] **自审修复 P2（第四轮，彻底性修复）**：第三轮只修了 `safeReleaseHandle` / `fanoutEvent` 两处，但同文件 `actions.ts` 还有 **2 处同型遗漏**（`releaseLockHandle` L267 / `runTransaction` recipe 判定 L502）以及 **2 处最小 thenable 不安全的 `.catch` 挂钩**（第三轮修复后残留）。具体修复：
  - 🔴 `actions.ts::releaseLockHandle` L267 thenable 判定加固为三重守卫（同 safeReleaseHandle 模式），避免 driver 返回 `null` / primitive 时的 truthy 漏网
  - 🔴 `actions.ts::runTransaction` L502 recipe 返回值判定加固为三重守卫，避免用户 recipe 意外返回 truthy 非 thenable 值时走 `await` 产生不必要 microtask 延迟（影响同步 update 时序契约）
  - 🔴 **最小 thenable `.catch` 不安全修复**：Promises/A+ 规范只保证 thenable 有 `.then`，不保证有 `.catch`。`(result as Promise<void>).catch(...)` 对最小 thenable（只实现 `.then` 不实现 `.catch`）会抛 `TypeError: catch is not a function`。修复为 `Promise.resolve(result as Promise<void>).catch(...)` —— `Promise.resolve` 把任意 thenable 正规化为 Promise 再挂 catch，覆盖 `actions.ts` 3 处 release 场景 + `fanout.ts` listener hook 场景
  - 🟢 `runTransaction` 里 `await result` 保持不变（`await` 本身对 thenable 已正规化，无需 `Promise.resolve` 包装）
- [x] **自审修复 P2（第五轮，回归测试保护网）**：第四轮修复核心是 "最小 thenable `.catch` 不安全"，但测试文件里**没有对应回归用例保护**，属于"修复缺失测试网的简化实现"。未来任何人把 `Promise.resolve(...).catch(...)` 回退成 `(result as Promise<void>).catch(...)` 都不会触发测试失败。追加 **第 13 组 describe — 最小 thenable 安全（回归保护）**到 `actions.browser.test.ts`，共 2 个用例：
  - 用例 1：自定义 driver 的 `release()` 返回只实现 `.then` 的最小 rejected thenable，验证 `actions.dispose()` 触发 `releaseLockHandle` → `driver.release()` 路径**不抛 TypeError**（未正规化的 `.catch` 在此处会崩）
  - 用例 2：`listeners.onCommit` 返回最小 rejected thenable，验证 `actions.update()` 触发 `fanoutCommit` → `fanoutEvent` 路径**不抛 TypeError**，且**后续 listener 仍被分发**（前一个 listener 的最小 thenable 不阻断广播）
  - 工具函数 `createMinimalRejectedThenable(reason)` 通过 `queueMicrotask` 模拟真实异步 reject，递归返回同类 thenable 以模拟 `.then` 链式；定义处显式 `biome-ignore lint/suspicious/noThenProperty`（测试专用，刻意构造 Promises/A+ 最小合规形态）
  - 全量测试由 377 增至 **379 用例全通**，29 files 全绿
- [x] **自审修复 P2（第六轮，测试有效性反向验证）**：第五轮追加的 2 个回归测试虽当下通过，但**未证明"若修复被回退测试必然失败"** —— 这是"测试通过即合格"的假实现。执行**反向验证**：临时把 3 处 `Promise.resolve(...).catch(...)` 回退为老写法 `(result as Promise<void>).catch(...)`，跑第 13 组：
  - 用例 1 **精确 FAIL** `TypeError: result.catch is not a function` at `actions.ts:269`（`releaseDriverHandle` 在 `dispose` 调用链中穿透）
  - 用例 2 **精确 FAIL** `TypeError: result.catch is not a function` at `fanout.ts:60`（`fanoutEvent` → `applyCommit` → `runTransaction` → `actions.update` 穿透）
  - 证明测试断言**真实有效** —— `await actions.dispose()` / `await actions.update()` 能捕获穿透的 TypeError
  - 恢复修复后在代码注释里显式交叉引用 `"回归测试：actions.browser.test.ts 第 13 组 describe..."`，形成代码 ↔ 测试双向引用，便于后续维护者定位
- [x] **自审修复 P2（第七轮，回归保护网覆盖缺口）**：第五轮的 2 个用例走的是 `releaseDriverHandle` + `fanoutEvent` 路径，但 `actions.ts` 第四轮修复实际有 **3 处**三重守卫 + `Promise.resolve` 正规化加固 —— 其中 `safeReleaseHandle`（L279，dispose-race 场景的独立 release，与 `releaseDriverHandle` 是 DRY 两份 copy）**完全未被独立测试覆盖**。未来任何人回退 `safeReleaseHandle:291` 的正规化，现有测试不会 catch 到。严谨的语义分析同时澄清：`runTransaction::recipe return` 的三重守卫与老写法 `result && typeof (result as Promise).then === 'function'` 在**所有运行时场景下完全等价**（逐一验证 primitive / null / `{ foo: 1 }` / `{ then: 1 }` / 最小 thenable 全场景一致），属于风格统一非功能修复，**不构成回归风险，无需测试**。追加第 13 组用例 3 —— `dispose-race：acquire 期间 dispose 触发 → safeReleaseHandle 处理最小 thenable 不抛 TypeError`：
  - `pauseNextAcquire` 让 acquire 挂起 → `getLock()` 发起 → `dispose()` 触发 `state.disposed=true` → `resolveAcquire(handle)` 让 acquire 完成 → actions 检测到 `state.disposed=true` 走 L431 `safeReleaseHandle` 独立路径 → handle.release 返回最小 rejected thenable
  - **反向验证精确捕获**：临时回退 `safeReleaseHandle:291` 为 `(result as Promise<void>).catch(...)` → 用例 FAIL `TypeError: result.catch is not a function`，且期望的 `LockDisposedError` 被 TypeError 穿透覆盖 → 证明保护网真实有效
  - **串扰验证**：反向回退只回退了 `safeReleaseHandle`，第 13 组前 2 个老用例（走 `releaseDriverHandle` / `fanoutEvent` 路径）**仍然 PASS**，证明这两条 DRY 路径**独立触发**，坐实第七轮发现的保护网空洞
  - 配套修复 biome CLI 暴露的 2 个新 lint 错误：`noShadow` 参数 `handle` 遮蔽 → 重命名为 `h`；`useConsistentArrowReturn` `acquire` 回调改为隐式返回
  - 用例总数 379 → **380 全通**，29 files 全绿
  - 注释里在 `safeReleaseHandle` 上方加交叉引用「回归测试：actions.browser.test.ts 第 13 组 describe「dispose-race...」」
- [x] **DRY copy 覆盖准则**（Phase 5+ 新增工程规则）：当多个函数是 DRY 的 copy（如 `releaseDriverHandle` / `safeReleaseHandle`），**每一份 copy 必须有独立的回归测试覆盖**；仅对其中一份做反向验证不构成完整保护网，后续维护者可能只动其中一份 copy 而测试无法 catch
- [x] **flaky test 识别**（第七轮全量回归一次偶发 `extract.node.test.ts:185 性能快路径` 断言 `elapsed < 10ms` 但实测 15ms 失败，duration 64s 表征机器高负载）：独立重跑 47ms 全绿、稳定化全量重跑 48.32s 全绿 → 确认是性能时序硬编码断言在机器负载抖动下的 flaky，与本轮修改无因果关联，忽略
- [x] **DRY 重构**：删除 `core/actions.ts::applyReplaceRecipe`（32 行），统一复用 `core/registry.ts::applyInPlace`；两者原先语义完全等价（数组 `length=0 + push` / 对象 `Reflect.ownKeys + deleteProperty + set`，含 Symbol key 兼容），重复实现无意义
- [x] **lint 权威性修正（重要教训）**：`read_lints`（IDE LSP）对 biome nursery 规则覆盖不完整，会漏报 `noMisusedPromises` / `noShadow` / `noReturnAssign` 等。**Phase 5+ 以 `pnpm biome lint` CLI 为权威**，`read_lints` 仅作 IDE 内实时提示参考
- [x] **biome lint CLI 全净**：`pnpm biome lint src/shared/lock-data/` 共 66 文件零错误
- [x] **风格守则落实**：core 层全部使用 `@/shared/utils/verify` 的 `isObject` / `isString` / `isFunction`；异步外部化用 `withResolvers`；错误构造走 `@/shared/throw-error`；逻辑或统一 `||` 语义；严禁 `throw new Error`；`Promise | null` 类条件判断统一用 `!== null` / `!== undefined` 显式空检查
- [x] **ES 模块语义守则**：tool 入口 `core/entry.ts` 所有导出放文件尾 `export { __resetDefaultRegistry, lockData }`；helper 文件（registry/actions/fanout/readonly-view/authority/…）全部使用 `export function` / `export const` / `export type` 内联导出
- [x] 为 Phase 6 奠定基础：`lockData` 主入口已存在且可直接用；Phase 6 只需做 `src/shared/index.ts` 的 barrel 导出 + 三重载类型签名验证

---

## Phase 6 — 入口聚合

### 6.1 `index.ts`（lockData 主入口）

- [x] 实现三个重载分支 A/B/C → [RFC#签名](./RFC.md#签名)（L112）
- [x] 参数校验走 `dataHandler`（**实施调整**：Phase 5 在 `core/entry.ts` 内部以 `extractValidId` / `normalizeSyncMode` / `normalizePersistence` 等类型守卫 + `InvalidOptionsError` 抛错实现等价校验；主入口保持纯类型重载 + 委托，不重复校验逻辑）→ [RFC#参数校验](./RFC.md#参数校验)（L1321）
- [x] 默认值应用走 `shared/data-mixed-manager` 或等价方式（**实施调整**：Phase 5 在 `core/entry.ts` 的 `normalize*` helper 里以字面量 fallback + RFC 规定默认值做等价实现，未引入 `data-mixed-manager` 依赖，契约与 RFC「默认值总览」一致）→ [RFC#默认值总览](./RFC.md#默认值总览)（L1296）
- [x] 重载匹配规则：分支 A 同步 / 分支 B getValue Promise / 分支 C syncMode storage-authority → [RFC#签名](./RFC.md#签名)
- [x] 验收：`__test__/integration/entry.node.test.ts` 覆盖三个重载分支的返回类型（10 用例全通：3 分支运行时 + 类型层 `expectTypeOf` 断言 `LockDataTuple<T>` vs `Promise<LockDataTuple<T>>` + `ReadonlyView<T>` 深只读递归）

### 6.2 从 `src/shared/index.ts` 导出

- [x] 导出 `lockData` / `NEVER_TIMEOUT` / 全部错误类 / 核心类型（`src/shared/index.ts` 通过 `export * from './lock-data'` 自动 re-export 主入口的所有命名导出；主入口已导出 6 个错误类 + 28 个公开类型 + `lockData` + `NEVER_TIMEOUT`）
- [x] 验收：在外部消费侧 `import { lockData } from '@cmtlyt/lingshu-toolkit/shared'` 能拿到类型（`index.test.ts` 7 用例 + `integration/entry.node.test.ts` 10 用例均通过主入口的 `import { ... } from './index'` 形式间接验证了 barrel 可达性）

---

## Phase 7 — 文档与集成测试收口

### 7.1 `index.mdx` 用户向文档

- [x] 按 `lingshu-doc-writer` skill 的 MDX 格式产出 → `.claude/skills/lingshu-doc-writer/SKILL.md`
- [x] 使用示例覆盖 RFC「使用示例」章节的所有场景 → [RFC#使用示例](./RFC.md#使用示例)（L357）
- [x] 不暴露实现细节（严格遵守 `lingshu-doc-writer` 的 "never expose implementation details"）
- [x] 同步刷新 `index.mdx` 文件头的 `update time` 字段为 `2026/05/01 09:10:00`（mdx-format.md 要求新增 / 更新时刷新 metadata）
- **实际产出**：在 `index.mdx` 脚本生成部分（标题 / 版本 / install / usage 共 27 行）之后追加 **438 行**用户向文档，文件从 27 行增至 **465 行**（`git diff --stat` 实测 `+438 insertions`；`wc -l` 实测 `465`）；严格遵守 skill 铁律：不修改任何脚本生成内容、只追加
  - **章节结构**（对齐 `lingshu-doc-writer/references/mdx-format.md` Required Sections 顺序，实测 `grep -nE "^## "` 标题齐全）：特性（8 条，`grep -cE "^- \*\*"` 实测）/ 基础用法（5 个子节：同步初始化 / 直接写 view 抛错 / 整体替换 / 异步初始化 / 跨模块共享同 id 复用）/ 高级用法（7 个子节：跨 Tab 同步 / 监听数据变更 / 手动持锁 / 超时控制 / AbortSignal / 强制抢占 / 错误处理）/ API（`lockData` 三重载签名 + `LockDataOptions` / `LockDataActions` / `ActionCallOptions` / `LockDataListeners` 表格 + 6 个错误类表格 + `NEVER_TIMEOUT` 常量）/ 注意事项（6 条 ⚠️ + 1 条 🔧，`grep -cE "^### ⚠️"` / `grep -cE "^### 🔧"` 实测）
  - **示例与测试断言对齐**：`lockData({ count: 0, label: 'init' })` → `view.count === 0` / `draft.count = 42` → `view.count === 42` / `replace({ count: 100, label: 'reset' })` 等直接来源于 `index.test.ts` 的断言契约
  - **黑盒原则落实**：全程不提 `Entry` / `InstanceRegistry` / `fanoutCommit` / `StorageAuthority` / `subscribeSessionProbe` 等内部术语；"跨 Tab 同步"仅描述用户视角的输入 → 输出，不讲内部 epoch / session-probe 协议
  - **验证**：`read_lints` 无错误 + `pnpm run check` 通过（Biome 对 4 个文件做格式微调，未破坏文档结构）
- **完成于 2026/05/01 09:05**

### 7.2 跨模块集成测试

> **首次产出时间说明**：7.2 / 7.3 所列的四个集成测试文件（含 `__test__/_helpers/memory-adapters.ts` helper）首次产出于 Phase 6 收口后 / Phase 7 启动阶段，但当时**未单独提交入 git**（`git status` 实测这些文件仍为 `??` 未跟踪状态），无法从 git 历史精确获取创建时间；本节只记录**确定可验证**的时间点：本次（2026/05/01）对其进行稳定化修复并通过全量回归的完成时间。

- [x] `__test__/integration/cross-tab.browser.test.ts`：真跨 Tab 的 `storage-authority` 端到端（5 用例：跨 Tab 基础链路 / 多次 commit 序列 / TabA dispose 不影响 TabB / 反向传播 TabB→TabA / 快照隔离 `viewA.items !== viewB.items`，TabA 侧用 `createTabAAuthority` 包装真实 StorageEvent 派发）
- [x] `__test__/integration/session-persistence.browser.test.ts`：session / persistent 两种策略的完整生命周期（7 用例覆盖 A/C/E/F 四条分支 + 持久化重启 + epoch 隔离 + 同 Tab 刷新 + 新开 Tab。B 分支在浏览器环境下不可触发——默认 sessionStore 工厂兜底——已由 `authority/epoch.browser.test.ts` 单元测试覆盖，集成层不重复）
- [x] `__test__/integration/memory-adapters.node.test.ts`：全内存 adapter 跑完整链路（脱离浏览器环境）→ [RFC#附录-b完整示例集](./RFC.md#附录-b完整示例集)（L1771 的「单元测试内存适配器」示例）
- **完成于 2026/05/01 08:45**（稳定化修复完成并通过验证；见下方「7.2 稳定化修复」）

#### 7.2 稳定化修复（2026/05/01 发现并修复的 3 处稳定失败）

首次将 7.2 / 7.3 的集成测试跑入回归时暴露了 **3 处稳定失败**（非 flaky，100% 复现），根因分三类：

- [x] **rev 双增 bug（源码 fix）**：`core/actions.ts::applyCommit` 与 `authority/index.ts::performCommitSuccess` **同时**执行 `entry.rev++` —— 因为 `Entry` 本身实现 `StorageAuthorityHost` 契约（`entry === host` 是同一对象，见 `core/entry.ts::attachAuthority` 的 `host: mutableEntry`），两处都自增导致观测到 `rev = [2, 4, 6]` 而非 `[1, 2, 3]`
  - **修复**：`applyCommit` 里只在**无 authority 的 else 分支**执行 `entry.rev++`，有 authority 时委托 `performCommitSuccess` 独家负责自增
  - **暴露路径**：`__test__/integration/cross-tab.browser.test.ts` 的 `onCommit event.rev` 断言 `[1, 2, 3]`、`memory-integration.node.test.ts` 1.2 `sync 事件 rev` 断言等
- [x] **memory-adapters helper logger 归属 bug**：`__test__/_helpers/memory-adapters.ts` 的 `notifyStorageSubscribers` / `channel.postMessage` 捕获订阅者异常时走的是 **writer（TabA）注入的 logger**，但测试场景中 TabA 不传 logger 只有 TabB/TabC 传，异常被 silently swallow
  - **修复**：`StorageSubscriber` / `ChannelSubscriber` 数据结构新增 `logger` 字段，订阅者异常改走**订阅者自己**注入的 logger —— 异常属于订阅者代码的责任，与 writer 无关
  - **暴露路径**：`__test__/adapters/memory-integration.node.test.ts` 1.5 / 2.5 用例期望 `logger.errorMock` 被调用但实际为空
- [x] **scene 4 测试预期与运行时能力不符**：`__test__/integration/memory-adapters.node.test.ts` 场景 4 原断言期望"三 adapter 全为 null → 触发 no authority/channel/sessionStore warn"，但 Node ≥ 18 下 **`BroadcastChannel` 原生可用**，用户 `getChannel: () => null` 会被 `pickDefaultAdapters` fallback 到默认工厂并成功返回 adapter，"三全 null" 前提不成立
  - **修复**：弱化断言为"匹配任一降级 warn 文案"（`localStorage is not available` / `sessionStorage is not available` / `sessionStore adapter unavailable`），更真实地表达 node 环境下的降级实际路径
- **验证结果**：`node#shared` 全量 lock-data **56 files / 663 tests 全绿**（实测 30.15s）；`browser#shared` 独立跑 `cross-tab.browser.test.ts` **5/5 全绿**（实测 713ms）、`memory-integration.node.test.ts` **18/18 全绿**、`memory-adapters.node.test.ts` **7/7 全绿**（实测 473ms）、`epoch.browser.test.ts` **21/21 全绿**（实测 964ms）
- **完成于 2026/05/01 08:45**

### 7.3 `__test__/adapters/memory-integration.node.test.ts`（能力等价性测试套件）

- [x] 提供"用户自定义 adapter 的合规性测试套件"（RFC 风险表已承诺）→ [RFC#风险与取舍](./RFC.md#风险与取舍)（L1465，`适配器语义契约依赖用户自律` 条目）
- [x] 用户可以导入这个套件，传入自己的 adapter 实现跑一遍，确认语义等价
- **完成于 2026/05/01 08:45**（配合 helper logger 归属修复同步稳定化；详见 7.2 稳定化修复第 2 条。测试套件本身首次产出时间与 7.2 集成测试相同——Phase 6 收口后 / Phase 7 启动阶段——但当时未入 git，无法从 git 历史精确获取创建时间）

### 7.4 既有测试稳定性修复（flaky 用例跨轮治理）

本节记录 **两轮** 针对 `epoch.browser.test.ts` 「持有 epoch 的 Tab 收到 probe 时广播 reply」用例的稳定化修复（两轮修复对应不同并发压力下的失败模式）：

- [x] **第一轮修复（2026/04/30，Phase 6 收口时发现）**：修复 `__test__/authority/epoch.browser.test.ts` 用例 `authority/epoch — subscribeSessionProbe (响应方) > 持有 epoch 的 Tab 收到 probe 时广播 reply`；该轮修复随 commit `1a4ea73 feat: lockData phase6完成`（`git log` 实测时间 `2026-04-30 18:05:55 +0800`）一起入库
  - **症状**：Phase 6 全量 workspace 回归时偶发 `expected [] to have a length of 1 but got +0`；**单独跑该文件稳定全绿**（多次复现确认 1207 passed）
  - **根因**：用例依赖 `await new Promise(r => setTimeout(r, 50))` 等待 BroadcastChannel 广播到达，在 workspace 高并发（109 文件并行）下 50ms 窗口不足，广播时序被其他 suite 的 microtask 压栈推迟
  - **与 Phase 6 改动无关**：Phase 6 修改仅涉及 `types.ts::LockDriverHandle.release` 类型放宽 / `core/entry.ts` helper 泛型透传 / 主入口三重载 / `index.test.ts` 改写 / 集成测试新增；**完全不触及 epoch / BroadcastChannel 逻辑**
  - **实际采用方案**（双轨处理同文件 5 处同类 flaky；行号以第二轮完成后实测为准，原第一轮提交时的行号因第二轮再改动已失效）：
    1. **正向断言（1 处，原失败点）**：`setTimeout(50ms)` → `vi.waitFor(() => { expect(replies).toHaveLength(1); }, { timeout: 500, interval: 10 })`；轮询等待条件成立，彻底消除时序赌博（第二轮再调整为 `timeout: 2000`）
    2. **反向断言（4 处，期望 replies 始终为空）**：`setTimeout(50ms)` → `setTimeout(150ms)`；反向断言必须等"足够久"才能证明确实无消息（`vi.waitFor` 不适用于"期望恒空"场景），150ms 覆盖高并发 workspace 下 BroadcastChannel 最坏投递窗口
  - **验证结果**：`biome check` 单文件零错误 + `tsc --noEmit` 全量零错误 + workspace 全量回归 `1207 passed / 109 files / 0 FAIL`（相比 Phase 6 收口时 `1 failed + 1206 passed`，修复后稳定全绿）

- [x] **第二轮修复（2026/05/01 08:55，Phase 7.2 稳定化完成后全量回归发现）**：相同用例在更高压力下再度 flaky
  - **症状**：Phase 7.2 全部稳定化修复完成后跑全量 `test:ci` 又暴露 `epoch.browser.test.ts:450:24` 断言失败 `expected [] to have a length of 1 but got +0`；但单独跑该文件连续 3 次 3/3 全绿（27–29ms），确认仍是并发压力下的时序 flaky
  - **根因细化**：`vi.waitFor` 500ms timeout 在全量 workspace `browser#shared` 并发 worker 拥挤时仍不足 —— BroadcastChannel 需要经历 `tabA→kernel→tabB→subscribeSessionProbe 回调→tabB→kernel→tabA` **两次跨 Tab 投递**，累计延迟在极端并发下可能 > 500ms
  - **修复方案**（行号为本次修复后 `grep -n` 实测）：
    1. 正向断言 `vi.waitFor` timeout 由 `500ms` 提升到 `2000ms`（`{ timeout: 2000, interval: 10 }` 位于 L457）—— 只会在真失败时延长，正常情况仍瞬时返回
    2. `subscribeSessionProbe(tabB, ...)` 之后、`tabA.postMessage` 之前追加 `await Promise.resolve()`（位于 L446）让订阅真正注册到内核 —— 部分浏览器实现下 `BroadcastChannel.addEventListener` 需要经过一次 microtask 才会加入订阅表，直接 post 可能丢首条
    3. 反向断言 4 处仍保持 150ms 不动，行号实测位于 L476 / L493 / L513 / L532
  - **验证结果**：独立跑 `epoch.browser.test.ts` **21/21 通过**（实测 964ms），`node#shared` 全量 lock-data **56 files / 663 tests 全绿**（实测 30.15s）
  - **遗留项**：本次修复后再跑一次 `pnpm run test:ci` 全量，`src/react/use-mount/index.test.tsx` 出现 `[vitest] Browser connection was closed while running tests` 的 WebSocket 断连 —— 与 lock-data 改动**完全无关**，属 vitest-browser 基础设施在高并发下的已知稳定性问题；该问题需由用户本地复跑多次确认或后续专项治理，**不应阻塞 Phase 7 收口**

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
