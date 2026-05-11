# lockData 实施清单

> 基于 RFC.md (0.1.5, accepted on 2026/05/08) 的逐步落地计划
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
- **类型判断**：**优先使用 `@/shared/utils` 的语义函数替代原生 `typeof` 运行时判断**
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

### 2.2 ~~`adapters/clone.ts`~~ ❌ 已废弃（RFC 0.1.5 删除）

> **废弃说明**：RFC 0.1.5 引入 JSON 拷贝隔离契约后，所有快照派生统一走 `JSON.parse(JSON.stringify(...))`，不再需要 `CloneFn` / `createSafeCloneFn` / `adapters/clone.ts`。原有实现已删除，相关测试文件 `__test__/adapters/clone.node.test.ts` 已移除。

- ~~[x] 实现 `createSafeCloneFn(logger?)`~~
- ~~[x] 三层降级~~
- ~~[x] 工厂构造阶段一次性探测~~
- ~~[x] 验收~~

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
- [x] **风格守则落实**：authority 层全部使用 `@/shared/utils` 的 `isObject` / `isString` / `isNumber`；异步外部化用 `withResolvers`（probeForExistingSession）；`shared/throw-error` 未出现本期硬依赖（本层只 logger.warn/error 降级，不向外 throw）
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
- [x] **自审修复 P2（第三轮，语义精确化回炉）**：第二轮为过 `noMisusedPromises` 把 `result && typeof (result as Promise<void>).then === 'function'` 简化成 `result !== undefined && typeof...`，但这是信息收集不充分的简化实现 —— `actions.ts::safeReleaseHandle` 的 `result: unknown`（driver.release 实际返回值可能偏离 `void | Promise<void>` 契约，如用户自定义 driver 返回 `null` / primitive），`fanout.ts::fanoutEvent` 的 hook 是用户 listener（TS 类型约束在运行时丢失）。`!== undefined` 弱守卫过不滤 `null`，对 `null` 做 `typeof (null as Promise<void>).then` 虽不 runtime 错误但语义已偏离"只对 thenable 生效"的原意。两处统一加固为**严谨的三重鸭子类型守卫**：`isObject(result) && 'then' in result && isFunction(result.then)` —— 既过滤所有非 object 值（undefined / null / primitive），又用 `'then' in` 精确判定 thenable，同时 `isFunction` 确认可调用，复用 `@/shared/utils` 统一风格，避开 `noMisusedPromises`
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
- [x] **风格守则落实**：core 层全部使用 `@/shared/utils` 的 `isObject` / `isString` / `isFunction`；异步外部化用 `withResolvers`；错误构造走 `@/shared/throw-error`；逻辑或统一 `||` 语义；严禁 `throw new Error`；`Promise | null` 类条件判断统一用 `!== null` / `!== undefined` 显式空检查
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

### 7.5 契约缺陷修复（Phase 7 收口后用户 review 反馈）

> 本节记录 Phase 7 文档与集成测试收口完成后，由用户 review 暴露并修复的源码契约缺陷。**不属于** Phase 7 范围内的任务，但因发现于 Phase 7 收口期间，归档于此便于追溯。

- [x] **`authority/extract.ts::parseAuthorityRaw` 缺 `snapshot` 字段存在性校验**（2026/05/06 修复）
  - **症状**：`{"rev":1,"epoch":"x"}` 这类残缺值（rev / epoch 都合法但 `snapshot` key 完全缺失）通过校验，返回 `{ rev: 1, ts: 0, epoch: 'x', snapshot: undefined }` 被当成合法记录传递到应用层，与该函数 JSDoc 上声明的"缺 rev / epoch / snapshot 字段返回 null"契约**自相矛盾**
  - **影响范围**：
    - `readIfNewerFallback` 路径（旧格式 / 手动写入 / 自定义 adapter 产物）会把脏数据当作合法值返回 `{ rev, snapshot: undefined }` 给 `applyAuthorityIfNewer`
    - 应用层虽有 `isObject(result.snapshot)` 兜底（让 `undefined` 走 `logger.warn` 分支），但日志文案为"snapshot is not an object"而非"非法结构"，**误导排障**
  - **修复**（`src/shared/lock-data/authority/extract.ts`）：在 `isNumber(obj.rev)` / `isString(obj.epoch)` 校验之后追加 `if (!Reflect.has(obj, 'snapshot')) return null;`
    - **采用 `Reflect.has` 而非真值判定**的关键考量：合法 snapshot 允许是 `null` / `false` / `0` / `''` / `[]`（注释中明确"snapshot 可能是 null / 数组 / 原始类型"），所以**不能**用 `obj.snapshot != null` 这类真值检查，必须用键存在性
    - **`Reflect.has` 与 `'snapshot' in obj` 语义等价**（都查原型链），但 `Reflect.has` 作为函数式 API 语义更显式；对 `JSON.parse` 产物（plain object，无 Object.prototype 上的 `snapshot` 属性污染）两者结果一致
  - **测试补强**（`src/shared/lock-data/__test__/authority/extract.node.test.ts`）：追加 3 组用例
    1. `readIfNewer` 兜底路径缺 snapshot → 返回 null（覆盖原始反馈场景 `{"ts":100,"rev":1,"epoch":"persistent"}`）
    2. `parseAuthorityRaw` 直接路径缺 snapshot → 返回 null（含 / 不含 ts 两种残缺形态）
    3. `parseAuthorityRaw` 处理合法 falsy snapshot（`null` / `false` / `0` / `''`）→ 全部正常通过校验（防止修复用错了真值判定）
  - **验证**（2026/05/06 11:39 本地实测）：
    - `read_lints` 无错误
    - `pnpm run test:ci src/shared/lock-data/__test__/authority/extract.node.test.ts` → **node#shared 33/33 全绿**（实测 600ms / tests 20ms / transform 102ms）
    - 同时跑通的工作流：`source ~/.nvm/nvm.sh && cd ... && nvm use && pnpm run test:ci <filepath>`（已总结到根目录 `AGENTS.md` 的「Agent 运行环境」段）
  - **关联文件**：`authority/extract.ts`（核心修复）/ `__test__/authority/extract.node.test.ts`（测试补强）；调用方 `authority/index.ts::applyAuthorityIfNewer` 无需改动 —— 应用层兜底保留作为深度防御

- [x] **`authority/index.ts::performInit` 与 `dispose()` 并发悬挂 push/pull 监听**（2026/05/06 修复）
  - **症状**：`createStorageAuthority(...).init()` 内部 `await resolveEpoch(...)` 是唯一异步切点；外部在这段等待期间调用 `dispose()` 后，`state.disposed = true` 且 `unsubscribers` 已清空，但 `await` 恢复后步骤 3（`attachAuthorityPushSubscription`）/ 步骤 4（`attachActivationPullSubscription`）/ 步骤 5（初次 `applyAuthorityIfNewer('pull-on-acquire', ...)`）仍会执行，将一个**已声明销毁的实例重新接回 storage 事件流**：`authority.subscribe` 注册的 unsubscribe 回调被 push 进空数组后再无人消费、`window.addEventListener('pageshow' / 'visibilitychange', ...)` 同理悬挂、初次 pull 还会触发 `emitSync` 把数据应用到一个事实上已废弃的 host
  - **影响范围**：
    - 任何先 `init()` 后立刻 `dispose()` 的取消语义场景（如组件 mount → unmount 极快、StrictMode 双调用、外部 cancel 控制流）都会留下监听器内存泄漏 + 监听器回调在销毁后被错误唤起
    - 跨用例污染：销毁后仍接到 storage 事件 → 触发 onSync 重入 → 是 Phase 7.4 治理 flaky 用例时未根治的潜在背景源之一
  - **修复**（`src/shared/lock-data/authority/index.ts::performInit`）：在 `await resolveEpoch(epochCtx)` 恢复后立即追加 `if (state.disposed) return resolved;` 短路返回
    - **关键设计点 1：仍然 `return resolved`**：`init()` 契约是 `Promise<ResolveEpochResult>`，宿主 `dataReadyPromise` 在 await 它；短路返回让契约不破坏（不会卡住 await），同时彻底跳过所有副作用（不回写 `host.epoch`、不挂 push/pull、不做初次 pull）
    - **关键设计点 2：不复用 `state.initialized` flag**：`initialized` 防"重复 init"，`disposed` 防"销毁后副作用"，两者语义独立必须分立
    - **关键设计点 3：不需要事务化撤销**：dispose 已 close channel + 清空 unsubscribers，只要主动跳过 step 3-5 就不会再产生需要清理的资源；step 1（`attachSessionProbeResponder`）在 await 之前就已 push 进 `state.unsubscribers`，dispose 时已被消费，不存在悬挂
  - **测试补强**（`src/shared/lock-data/__test__/authority/init-dispose-race.node.test.ts`，**新增 6 组用例**）：
    1. `await resolveEpoch` 期间调用 dispose → `authority.subscribe` / `authority.read` 调用计数为 0（push 订阅 + 初次 pull 都没挂上）
    2. 同上场景下 `host.epoch` 保持 null（不被回写）
    3. 同上场景下 `applySnapshot` / `emitSync` 均未被调用（初次 pull 不应错误唤起监听器）
    4. 反向校验 1：正常路径（先完成 init 再 dispose）push 订阅照常挂上
    5. 反向校验 2：C 分支（sessionStore 已有 epoch）正常路径下 `authority.read` 照常触发初次 pull —— 防止修复误伤
    6. dispose 幂等：连续两次调用，`channel.close` 仅被触发一次
    - **构造异步 await 切点的方式**：`persistence: 'session'` + 自定义 silent channel（postMessage 不回环、subscribe 注册但永不被外部触发）→ `resolveEpoch` 走 session-probe 超时分支（F 分支），稳定地等待 `sessionProbeTimeout` 才 settle，这段窗口期可精准插入 `dispose()` 调用
  - **方案归档**：`src/shared/lock-data/fixes/init-dispose-race.md`（缺陷复现路径、为何用 disposed 而非 initialized、为何仍要返回 resolved、测试设计依据）
  - **验证**（2026/05/06 12:11 本地实测）：
    - `read_lints` 无错误
    - `pnpm run test:ci src/shared/lock-data/__test__/authority/init-dispose-race.node.test.ts` → **node#shared 6/6 全绿**（实测 1.04s / tests 195ms）
    - `pnpm run test:ci src/shared/lock-data` 全量回归 → **35 files / 450 tests 全绿**（实测 19.00s）
    - `pnpm run check` → 全仓 194 文件 clean
  - **关联文件**：`authority/index.ts::performInit`（核心修复，仅追加 1 个 if 分支）/ `__test__/authority/init-dispose-race.node.test.ts`（新增）/ `fixes/init-dispose-race.md`（方案文档归档）

- [x] **`core/actions.ts::handleRevoke` 未清空 `acquiredByGetLock` 导致下一次 update 误留锁**（2026/05/06 修复）
  - **症状**：`acquiredByGetLock` 是「上一次锁是通过 `getLock()` 主动留下的」状态位，`maybeAutoRelease` 用它决定 recipe 结束后是否自动释放（`if (alreadyHeld || state.acquiredByGetLock) return;`）。`handleRevoke` 是所有 revoke 路径（driver `onRevokedByDriver('force')` / `holdTimeout` 触发 / 用户主动 `revoke()`）的统一收口，但只清理了 `aliveToken` / `currentHandle` / `holdTimer`，**漏清** `acquiredByGetLock`。如果上一轮锁是 getLock 拿的（flag=true），revoke 之后 flag 残留，下一次普通 `update()` 跑完 `maybeAutoRelease(false)` 时仍会被 `state.acquiredByGetLock=true` 提前 return，**普通 update 抢的锁被永久留住**，直到下次显式 `release()/getLock()/dispose()` —— 行为像「死锁但无报错」
  - **影响范围**：
    - 任何先 `getLock()` 后被外部 revoke（其他 Tab force / hold-timeout）再继续调用 `update()` 的串联场景：锁泄漏导致其他 Tab / 同 id 实例无法进入临界区
    - 与 `update()` 文档约定的「recipe 边界自动释放」语义相违
    - 与 `performRelease`（已清 flag）/ `doDispose`（已清 flag）的归零行为不对称，是状态机护栏的明显疏漏
  - **修复**（`src/shared/lock-data/core/actions.ts::handleRevoke`）：在 `state.aliveToken = ''` 之后追加 `state.acquiredByGetLock = false;`，与 `aliveToken / handle / holdTimer` 一起作为「持锁周期出口」的原子归零操作
    - **关键设计点 1：修复点选在 handleRevoke 而非 ensureHolding 入口**：handleRevoke 是 revoke 的唯一收口，与 performRelease / doDispose 形成「持锁周期出口必清 flag」的对称性；入口侧防御违背「flag 谁置位谁负责清理」，且无法处理 revoke 后调用方不再触发新 update / 直接 dispose 的语义对称性
    - **关键设计点 2：不在 ensureHolding 入口主动重置**：若 `alreadyHeld === true`，用户可能在前一次 `getLock()` 之后接着调 `update()`，此时 `acquiredByGetLock` 应保留前一次置位语义；入口处粗暴清零会破坏 getLock + update 串联场景
    - **关键设计点 3：不影响 revoked 事件语义**：修复仅改 flag，不影响 `transitionTo('revoked')` / `fanoutRevoked` 的事件广播；订阅 `onRevoked` / `onLockStateChange` 的监听器无感知
  - **测试补强**（`src/shared/lock-data/__test__/core/actions-revoke-getlock.node.test.ts`，**新增 3 组用例**）：
    1. `getLock` → `triggerRevoke('force')` → `update(recipe)` → 断言 `actions.isHolding === false` 且 `releaseCount === 1`（自动释放生效）
    2. `getLock` → `triggerRevoke('timeout')` → `update(recipe)` → 同样自动释放（验证 reason 字段不影响清理逻辑）
    3. 反向校验：`getLock` → 不 revoke → `update(recipe)` → 断言 `actions.isHolding === true` 且 `releaseCount === 0`（getLock 语义未被误伤）
    - **不依赖 fakeTimers**：直接通过 `triggerRevoke('timeout')` 驱动 handleRevoke 的 timeout 路径，避免 fakeTimers 与 async/await microtask 调度交互的脆弱时序
  - **方案归档**：`src/shared/lock-data/fixes/revoke-clear-acquired-by-get-lock.md`（缺陷复现路径、为何修复点选在 handleRevoke 而非入口、为何不在入口主动重置、测试设计依据）
  - **验证**（2026/05/06 12:32 本地实测）：
    - `read_lints` 无错误
    - `pnpm run test:ci src/shared/lock-data/__test__/core/actions-revoke-getlock.node.test.ts` → **node#shared 3/3 全绿**（实测 952ms / tests 14ms）
    - `pnpm run test:ci src/shared/lock-data/__test__/core/` 子目录回归 → **8 files / 151 tests 全绿**（含既有 actions.browser.test.ts 31 个用例）
    - 联合跑 `actions-revoke-getlock.node.test.ts + actions.browser.test.ts` → **34/34 全绿**（实测 17.19s）
    - `pnpm run check` → 全仓 195 文件 clean（biome 自动规整了新增注释格式）
  - **关联文件**：`core/actions.ts::handleRevoke`（核心修复，新增 1 行赋值 + 4 行行内注释）/ `__test__/core/actions-revoke-getlock.node.test.ts`（新增）/ `fixes/revoke-clear-acquired-by-get-lock.md`（方案文档归档）

- [x] **`core/actions.ts::performAcquire` catch 路径在 dispose-race 下违反终态契约**（2026/05/06 修复）
  - **症状**：`dispose()` 与 in-flight `driver.acquire()` 竞争时，`doDispose` 触发 `disposedController.abort(...)` → driver 监听 `ctx.signal` 立即 reject（`AbortError`）→ `performAcquire` 进入 catch 分支。旧实现不区分 dispose 引发的 abort 和正常 acquire 失败，盲目执行 `state.aliveToken = '' / transitionTo(idle, token) / throw translateAcquireError(...)`，造成两处违例：
    1. 已经流转到 `disposed` 终态的实例又广播一次 `idle` 状态变更，**违反「disposed 是终态」契约**——`onLockStateChange` 监听器先收到 `disposed` 再收到 `idle`
    2. 调用方拿到 `LockAbortedError` / `LockTimeoutError` 而非 `LockDisposedError`，**与「disposed 后任何方法都 reject LockDisposedError」契约不一致**——上层无法区分「外部 signal abort」与「实例 disposed」
  - **影响范围**：
    - 任何先发起 `update()` / `getLock()` 后立刻 `dispose()` 的取消场景（组件 unmount 极快、StrictMode 双调用、AbortController 控制流）：监听器收到错乱的 phase 序列、调用方收到错误的 error 类型
    - 与成功路径的对称性缺失：`performAcquire` 在 acquire 成功后已经检查 `state.disposed` 并走 `throwDisposed`（L411-415），但失败路径漏齐了同样的检查
  - **修复**（`src/shared/lock-data/core/actions.ts::performAcquire`）：在 catch 分支起始处优先检查 `state.disposed`，是则直接 `throwDisposed(error)` 保留 disposed 终态，把原 abort/timeout 错误作为 cause 透传便于排障
    ```ts
    } catch (error) {
      if (state.disposed) {
        throwDisposed(error);  // ← 修复点：保留 disposed 终态 + 抛 LockDisposedError
      }
      state.aliveToken = '';
      transitionTo(deps, state, 'idle', token);
      throw translateAcquireError(error, signalBundle.timeoutController);
    }
    ```
    - **关键设计点 1：修复点选在 catch 起始处**——这是 dispose-race 唯一可观察的状态机违例点，与成功路径 L411-415 的 `if (state.disposed) throwDisposed()` 形成对称
    - **关键设计点 2：用 `throwDisposed(error)` 把原错误作为 cause**——`throwDisposed` 已支持 cause 参数（L295-297），与 `ensureDataReady` 中 `if (state.disposed) throwDisposed()` 的写法保持一致；保留原 abort/timeout 错误便于排障定位是哪条路径触发了 dispose
    - **关键设计点 3：finally 仍然执行 `signalBundle.dispose()`**——try/catch/finally 的 finally 块在 catch 路径 throw 之后仍会执行，signal 资源不会泄漏
    - **关键设计点 4：不影响正常失败路径**——非 disposed 场景下 catch 仍走原有 `transitionTo(idle) + translateAcquireError` 逻辑（abort / timeout / driver 内部故障）
  - **测试补强**（`src/shared/lock-data/__test__/core/actions-dispose-race.node.test.ts`，**新增 3 组用例**）：
    1. `update()` 启动 → `dispose()` → 断言 `update` 拒绝时是 `LockDisposedError` 而非 `LockAbortedError`
    2. 同上场景 → 断言 `onLockStateChange` 序列为 `['acquiring', 'disposed']`，**`'disposed'` 之后不再有 `'idle'`**（终态契约保留）
    3. 反向校验：`callOpts.signal` abort（不触发实例 dispose）→ 断言仍走原失败路径，phase 为 `['acquiring', 'idle']`、错误类型是 `LockAbortedError`、`actions.isHolding === false`（实例可继续使用）
    - **stub driver 增强**：在 `pauseNextAcquire` 模式下监听 `ctx.signal.addEventListener('abort')`，abort 时 reject `AbortError` —— 这是缺陷复现的前提条件（旧 stub 仅按 pause/resume 时序，无 signal 响应能力）
  - **方案归档**：`src/shared/lock-data/fixes/dispose-race-acquire-catch.md`（缺陷复现路径、与成功路径的对称性缺失、为何用 `throwDisposed(error)` 透传 cause、为何 finally 仍执行 `signalBundle.dispose()`、测试设计依据）
  - **验证**（2026/05/06 13:26 本地实测）：
    - `read_lints` 无错误
    - `pnpm run test:ci src/shared/lock-data/__test__/core/actions-dispose-race.node.test.ts` → **node#shared 3/3 全绿**（实测 928ms / tests 13ms）
    - `pnpm run test:ci src/shared/lock-data/__test__/core/` 子目录回归 → **9 files / 154 tests 全绿**（含既有 actions.browser.test.ts 31 个 + actions-revoke-getlock.node.test.ts 3 个 + 本次新增 3 个）
    - `pnpm run check` → 全仓 196 文件 clean
  - **关联文件**：`core/actions.ts::performAcquire`（核心修复，仅追加 1 个 if 分支 + 6 行注释）/ `__test__/core/actions-dispose-race.node.test.ts`（新增）/ `fixes/dispose-race-acquire-catch.md`（方案文档归档）

- [x] **`core/actions.ts` actions 实例对未 await 的并发写操作不安全**（2026/05/06 修复）
  - **症状**：`ensureHolding` 仅在 `phase === 'holding' && aliveToken !== ''` 时复用既有锁，其他状态（包括 `acquiring` / `committing`）一律走 `performAcquire()`。当用户**未 await 第一次写操作就发起第二次写操作**（`update#1` 还在 `await driver.acquire`，调用方紧接着发出 `update#2` / `replace#1` / `getLock#1`）时，第二次会直接覆盖 `currentToken` / `aliveToken` / `currentHandle`，触发两类深层错乱：
    1. **`acquiring` 期间重入 → 伪 `LockRevokedError`**：`update#1` 拿到 `handle#A` 时 `aliveToken` 已被 `update#2` 改写为 `B` → 走 revoke 分支抛 `LockRevokedError`，但实际并未被任何外部源 revoke —— 调用方误以为锁被驱动撤销
    2. **`committing` 期间重入 → driver handle 泄漏**：`update#1` 在 `await recipe(draft)` 阶段，`update#2` 进入 `performAcquire` 拿到 `handle#B` 时 `state.currentHandle = handle#B` **直接覆写 `handle#A`**，`handle#A` 引用丢失，**永远不会被 release**（WebLocks driver 意味着锁永久持有直到页面关闭；自定义 driver 可能造成跨进程锁死）
  - **影响范围**：
    - 任何允许调用方未 await 写操作的场景（用户事件并发触发、StrictMode 双调用、并行流水线、组件快速 unmount/remount 等）
    - WebLocks / 自定义 driver 的 handle 资源泄漏（不会自动恢复，需进程重启）
    - 错误类型语义错乱：调用方收到的 `LockRevokedError` 与实际撤销源完全无关，无法基于错误类型做正确的恢复决策
  - **修复方案权衡**：
    - 候选 A（采纳）：在 `ActionsInternalState` 引入 `writeChain: Promise<void>` 串行链，所有写操作通过 `.then(task, task)` 严格 FIFO 排队
    - 候选 B（放弃）：重入直接抛 `LockBusyError`，破坏现有调用方契约（用户合理预期 `update()` 排队），且引入新错误类型成本高
    - 候选 C（放弃）：committing 期复用 pending 结果，会丢失第二次调用的 recipe 语义
  - **修复**（`src/shared/lock-data/core/actions.ts`）：
    1. `ActionsInternalState` 新增 `writeChain: Promise<void>` 字段（初始 `Promise.resolve()`），随同 `createInitialState` 同步初始化
    2. 新增 `enqueueWrite<R>(state, task): Promise<R>` helper，三处关键设计：① `state.writeChain.then(task, task)` 保证无论前一个任务成功或失败下一个都继续；② 链尾 `next.then(swallow, swallow)` 吞掉 rejection 隔离链上后续任务；③ 调用方拿到 `next` 本身（task 真实结果），不被 chain 的吞错版本污染
    3. 改造 `update` / `replace` / `getLock` 三个入口：把「`ensureHolding` + `runTransaction` + `maybeAutoRelease`」整体包到 `enqueueWrite` 中，task 内部再次 `ensureAlive()` 兜底「排队期间被 dispose」场景。`ensureAlive` 与参数校验仍在排队前同步执行（保持 fail-fast 契约不变）
    ```ts
    function enqueueWrite<R>(state: ActionsInternalState, task: () => Promise<R>): Promise<R> {
      const swallow = (): void => {/* 隔离链上后续任务，调用方仍从 next 拿到真实错误 */};
      const next = state.writeChain.then(task, task);
      state.writeChain = next.then(swallow, swallow);
      return next;
    }
    ```
    - **关键设计点 1：写串行化而非拒绝重入**——符合用户对 `update()` 的合理预期（"未 await 重入应该排队，不应该报错"），零破坏性
    - **关键设计点 2：调用方 Promise 与 chain 隔离**——`next = chain.then(task, task)` 是真实结果通道，`writeChain = next.then(swallow, swallow)` 是排队信号通道；前一个任务失败的真实错误原样 reject 给当前调用方，后续排队者从 fresh 的 chain 上恢复不被污染
    - **关键设计点 3：dispose 协同无需额外改动**——`doDispose` 已通过 `disposedController.abort()` 中断 in-flight `driver.acquire`；排队中的任务轮到自己执行时调 `ensureAlive()` 命中 `state.disposed` 抛 `LockDisposedError`，与 dispose-race 修复的终态契约对齐
    - **关键设计点 4：`performAcquire` / `runTransaction` / `release` 不需改**——它们的并发不安全是「上层不该让多个调用同时进入」，串行化后天然消失
  - **测试补强**（`src/shared/lock-data/__test__/core/actions-concurrent-write.node.test.ts`，**新增 5 组用例**）：
    1. `acquiring` 期间重入 `update`：暂停 driver.acquire → 同时发 update#1 + update#2（不 await #1）→ 断言 ① `entry.rev=2`、② `onCommit` 顺序严格 `[1, 2]`、③ `onRevoked` 未触发（无伪事件）、④ 各自走完整 acquire→release（`acquireCount=2 / releaseCount=2`）
    2. `committing` 期间重入 `update`：第一个 update 的 recipe 是 async 阻塞 → 重入第二个 update → 断言 `entry.rev=2`，`acquireCount=2 / releaseCount=2`（修复前 handle#A 会被 handle#B 覆盖丢失，release 计数不平衡）
    3. `update` + `replace` 交叉：data 最终值是 replace 写入的对象（`{v: 999, tag: 'replaced'}`），串行后两次操作各自 acquire→release
    4. `update` + `getLock` 交叉：update 完成 release 后 getLock 重新 acquire，`acquireCount=2 / releaseCount=1`（getLock 后 `acquiredByGetLock=true` 保留锁），主动 `release()` 后 `releaseCount=2`
    5. 排队期间 `dispose`：update#1 卡在 acquire（gate 不 resume）→ update#2 排队 → `dispose()` → 断言 update#2 抛 `LockDisposedError`（不是 abort/timeout，符合终态契约）
    - **stub driver 增强**：在 `pauseNextAcquire` 模式下监听 `ctx.signal.addEventListener('abort')` → reject `AbortError`（与真实 driver 行为对齐，让 dispose 路径可观察）
  - **方案归档**：`src/shared/lock-data/fixes/concurrent-acquire-serialize.md`（缺陷复现路径、错乱 1/2 时间线表、候选方向 A/B/C 权衡、关键设计点、边界场景、测试设计）
  - **验证**（2026/05/06 13:47 本地实测）：
    - `read_lints` 无错误
    - `pnpm run test:ci src/shared/lock-data/__test__/core/actions-concurrent-write.node.test.ts` → **node#shared 5/5 全绿**（实测 1.69s / tests 33ms）
    - `pnpm run test:ci src/shared/lock-data/__test__/core/` 子目录回归 → **10 files / 159 tests 全绿**（含既有 actions.browser.test.ts 31 个 + actions-revoke-getlock 3 个 + actions-dispose-race 3 个 + 本次新增 5 个）
    - `pnpm run check` → 全仓 197 文件 clean
  - **关联文件**：`core/actions.ts`（核心修复：`ActionsInternalState` 新增 `writeChain` 字段、`createInitialState` 初始化、新增 `enqueueWrite` helper、改造 `update`/`replace`/`getLock` 三个入口）/ `__test__/core/actions-concurrent-write.node.test.ts`（新增）/ `fixes/concurrent-acquire-serialize.md`（方案文档归档）

- [x] **`core/draft.ts` 集合内对象深层修改绕过 proxy 跟踪**（2026/05/06 修复）
  - **症状**：`createDraftSession` 对 Set / Map 提供了 collection proxy 跟踪 mutation 方法（`add` / `set` / `delete` / `clear`），但「读出来的值」分支用 `value.bind(target)` 直接绑定到原始集合 → `draft.map.get('k')` 返回的就是真实存进去的对象引用。调用方对该引用做深层修改（`item.x = 2`）**完全绕过 proxy trap**，`mutations` 不记录、`snapshot` 不抓 prevValue、`rollback()` 还原不了，事务的 commit / rollback 语义被静默破坏。同样的口子在 `Map.values() / entries() / forEach / Symbol.iterator` 与 `Set` 的对应迭代 API 上都存在
  - **影响范围**：
    - 任何把可变对象塞进 Set / Map 的写法（`map.set('k', { x: 1 })` / `set.add({ id: 1 })`）：commit 阶段广播的 mutations 缺失深层修改、跨 Tab 同步不会传播 → **生产路径上本来就是错的，只是运行时没检测出来**
    - 跨 Tab 序列化：authority 副本写入只发布显式记录的 mutations，集合内对象的深层修改完全丢失 → 跨 Tab 数据漂移
    - rollback 失败：recipe 抛错时 lock-data 承诺整事务回滚，但绕过 proxy 的修改无法被恢复 → 状态不一致
  - **修复方案权衡**：
    - 候选 A（放弃）：把集合读取结果继续包成子 draft，路径用伪段 `@map(key)` / `@set(item)` 表达。代价是 mutation path 出现伪段后 commit 持久化层、跨 Tab 重放、authority 序列化、type 定义全部需要兼容，与 RFC 顶部「Set/Map 整体克隆 / 中小规模」的设计预期相悖；Set 元素无稳定键还需要 WeakMap 维护 item → id 映射
    - 候选 B（放弃）：仅入口拦截「Set/Map 内不能放可变对象」，配合出口 `Object.freeze`。需要保留 collection proxy 全部代码（~80 行），且 `Object.freeze` 有副作用（用户存入的对象被强制冻结，影响 lock-data 之外的代码）
    - 候选 C（采纳）：**移除对 Set / Map 的支持，仅允许 JSON 安全类型**。lock-data 的数据本身要参与跨 Tab 同步与持久化序列化，集合类型在 JSON 上下文里本来就是「需要自定义序列化」的类型，让它出现在 draft 里只会持续制造类似缺陷
  - **修复**（采纳候选 C，`src/shared/lock-data/core/draft.ts`）：
    1. **删除全部 collection proxy 代码**：`SET_MUTATION_METHODS` / `MAP_MUTATION_METHODS` / `CollectionInfo` / `detectCollection` / `CollectionAccess` / `resolveCollectionMember` / `buildCollectionMutation` / `captureCollectionSnapshotOnce` / `restoreCollection`，连带 `DraftSnapshotEntry` 的 `'collection'` 分支与 `applyRollback` 的 collection 分支
    2. **新增 `assertJsonSafe(value, path, seen)` helper**：递归校验 JSON 安全契约 —— 允许 `string` / `number`（不含 NaN/Infinity）/ `boolean` / `null` / plain object（`Object.getPrototypeOf === Object.prototype || === null`）/ array；禁止 `undefined` / `bigint` / `symbol` / `function` / Set / Map / Date / RegExp / class 实例 / TypedArray / 循环引用 等。`seen: WeakSet` 仅跟踪当前路径上访问过的容器（递归回溯时 `delete`），保证「同一兄弟节点的相同引用」不被误判为环
    3. **新增 `formatPath` / `describeNonJsonValue` helper**：错误消息携带 `'a.b[0].c'` 风格路径与具体类型描述（`Set` / `Map` / `Date` / `class instance (Foo)` / `NaN` / `function` 等）
    4. **`createDraftSession` 入口校验**：进入函数体首行调用 `assertJsonSafe(target, [], new WeakSet())` —— fail-fast 拒绝非 JSON 数据，避免后续操作产生不可回滚的副作用
    5. **`createDraftProxy::set` trap 写入校验**：在 `Reflect.set` 之前调用 `assertJsonSafe(value, [...parentPath, key], new WeakSet())` —— 入口已校验 target，但 recipe 内的赋值 value 可能是任意类型，必须重新校验。在写入前抛错可保证 target / mutations / snapshot 不被污染
    6. **JSDoc tip**：`createDraftSession` 函数签名与 `DraftSession` 接口都补充 JSDoc，明确 JSON-only 契约 + 给出 `Set<T>` → `T[]` / `Map<K, V>` → `Record<string, V>` 的迁移建议
    - **关键设计点 1：从设计上移除而非打补丁**——集合类型在 JSON 上下文里持续制造类似缺陷的根因是「Set / Map 不是 JSON 一等公民」。打补丁只能修单点，移除支持才能根治
    - **关键设计点 2：入口 + 写入双重校验**——入口校验拒绝初始非法 target；写入校验拒绝 recipe 内赋非法值。两道防线协同保证「draft 上下文中永远不会出现非 JSON 值」
    - **关键设计点 3：`undefined` / NaN / Infinity 一并拒绝**——保守对齐 `JSON.stringify` 行为：`undefined` 在 stringify 时被丢弃、NaN/Infinity 被静默转成 `null`；主动拦截优于运行时漂移
    - **关键设计点 4：错误消息携带路径**——`'draft only supports JSON-safe values, got "Set" at "user.tags"'` 让用户秒级定位违规点
    - **关键设计点 5：写入校验在 `Reflect.set` 之前抛错**——保证 target / mutations / snapshot 不被污染（fail-fast），与现有「ensureWritable 在 mutation log 之前」的对称
  - **同步清理 types.ts**：`LockDataMutationOp` 从 8 个值缩减到 2 个（`'set' | 'delete'`），删除 `'map-set' | 'map-delete' | 'map-clear' | 'set-add' | 'set-delete' | 'set-clear'`。事先 grep 确认这 6 个 op 仅在 `draft.ts`（实现）+ `types.ts`（定义）+ `__test__/core/draft.node.test.ts`（测试）3 个文件出现，commit / persist / authority 路径均无依赖
  - **测试改造**（`src/shared/lock-data/__test__/core/draft.node.test.ts`）：删除 `createDraftSession - Set / Map 追踪` 整个 describe block（9 个用例）；修正 1 个用例 `'rollback 被删除的属性恢复为"不存在"而非 undefined'` 改为 `Reflect.deleteProperty` 触发删除（原 `session.draft.a = undefined` 在新契约下会被拒绝），更名为 `'rollback 后被删除的属性恢复为原值'`
  - **测试补强**（`src/shared/lock-data/__test__/core/draft-json-only.node.test.ts`，**新增 24 个用例 / 4 组 describe**）：
    1. **入口拦截 - 非 JSON 值**（12 个）：Map / Set / 嵌套深处 Set / 数组内 Map（索引路径）/ Date / RegExp / class 实例（描述类名 `class instance (Foo)`）/ function / bigint / NaN / Infinity / undefined（提示用 null）+ 错误信息携带 lockData 前缀
    2. **入口允许 - 纯 JSON 数据**（4 个）：plain object 嵌套 array 嵌套 primitive / `Object.create(null)` 视为 plain object / 顶层为数组 / 同一引用出现在两个兄弟节点不被误判为环
    3. **写入拦截 - recipe 里赋非 JSON 值**（4 个）：赋值 new Set 抛 TypeError 且 target / mutations 不被污染、后续合法写入仍可工作 / 赋值 Date / 赋值含 NaN 的对象（路径深入到 `x.a.b`）/ rollback 后非 JSON 值的失败写入不影响最终状态
    4. **环形引用拦截**（3 个）：对象自循环 / 深层环（路径 `root.child.child`）/ 数组自循环
  - **方案归档**：`src/shared/lock-data/fixes/collection-deep-mutation-bypass.md`（缺陷复现路径、影响范围、候选方向 A/B/C 权衡、JSON 安全类型定义、实施清单、关键设计点、测试用例索引、边界场景、不做的事）
  - **验证**（2026/05/06 14:48 本地实测）：
    - `read_lints` 无错误（`isPlainObject` 返回类型用 type predicate `value is Record<string, unknown>` 收窄以匹配 biome `noMisleadingReturnType` 规则；测试中环形引用结构改用 `interface` 替代 `type` 以匹配 `useConsistentTypeDefinitions`）
    - `pnpm run test:ci src/shared/lock-data/__test__/core/draft-json-only.node.test.ts src/shared/lock-data/__test__/core/draft.node.test.ts` → **node#shared 39/39 全绿**（draft.node.test 15 个 + draft-json-only.node.test 24 个）
    - `pnpm run test:ci src/shared/lock-data/__test__/core/` 子目录回归 → **11 files / 174 tests 全绿**（含既有 actions.browser 31 个 + actions-revoke-getlock 3 个 + actions-dispose-race 3 个 + actions-concurrent-write 5 个 + 本次新增 24 个）
    - `pnpm run test:ci src/shared/lock-data/__test__/authority/init-dispose-race.node.test.ts` → 6/6 全绿；`extract.node.test.ts` → 33/33 全绿；`src/shared/lock-data/index.test.ts` → 14/14 全绿（含 browser）
    - `pnpm run check` → 全仓 198 文件 clean
  - **关联文件**：`core/draft.ts`（核心修复：删除 ~80 行 collection proxy 代码、新增 `assertJsonSafe` / `formatPath` / `describeNonJsonValue` / `isPlainObject` 4 个 helper、`createDraftSession` 入口与 `createDraftProxy::set` trap 加校验、JSDoc tip）/ `types.ts`（`LockDataMutationOp` 缩减为 `'set' | 'delete'` + JSDoc 追加 JSON-only 契约说明）/ `__test__/core/draft.node.test.ts`（删除 Set/Map 追踪 describe block、修正 1 个用例）/ `__test__/core/draft-json-only.node.test.ts`（新增）/ `fixes/collection-deep-mutation-bypass.md`（方案文档归档）

- [x] **`core/entry.ts` standalone 实例 `__local__` 占位 id 泄漏到 driver / authority**（2026/05/06 修复）
  - **症状**：`acquireStandalone()` 内部以 `factory('__local__', ...)` 调用 `createEntryFactory`，把展示用占位 id 当成「真实 id」喂给下游所有判定。结果：① `pickDriver({ id: '__local__', ... })` 不再走「无 id 短路 → LocalLockDriver」分支，落到 BroadcastDriver / WebLocksDriver 等跨 Tab driver；② `attachAuthority` 在 `syncMode === 'storage-authority'` 时 `lockId !== undefined` 判定通过，意外启用 StorageAuthority；③ 所有未命名实例都落到同一个 `'__local__'` 命名空间，driver acquire name `${LOCK_PREFIX}:__local__` / authority storage key 全部撞车 → 「无 id 仅限本地 + 实例隔离」语义被静默破坏，本应隔离的实例被串到跨 Tab 通道
  - **影响范围**：
    - 用户 `lockData(initial, options)`（不传 id）+ `mode: 'web-locks'` / `mode: 'broadcast'` / `mode: 'storage'` 任一显式跨 Tab driver → 实际启用对应跨 Tab driver，acquire name 是 `lock-data:__local__`，多个无 id 实例互相串扰
    - 用户 `lockData(initial, { syncMode: 'storage-authority' })`（不传 id）→ StorageAuthority 启用，向 localStorage 写 `__local__` 命名空间的 key，跨 Tab 复活伪造数据
    - 用户在同一 Tab 内创建 2+ 个无 id 实例 → 共享 `__local__` driver acquire name，acquire 串行化（应当并行）
  - **修复方案权衡**：
    - 候选 A（放弃）：在 `pickDriver` / `attachAuthority` 内部识别 `id === '__local__'` 当成无 id。把魔法值知识扩散到下游模块，且 `'__local__'` 字符串作为合法用户 id 也不可区分（虽然概率低，但不应靠概率保证语义）
    - 候选 B（放弃）：standalone 路径不调 `factory`，单独搭一条「无 id 实例构建链」。代价是双份代码路径，driver / authority / dispose / teardown 全部要复制一遍，与 Registry 路径维护两套等价逻辑
    - 候选 C（采纳）：**拆分 `Entry.id`（展示用，恒非空字符串）与 `Entry.lockId`（语义判定用，standalone = `undefined`）**。Registry 路径 `lockId === id`，standalone 路径 `lockId === undefined` + `id === '__local__'`。下游所有「我是不是 standalone」的判定改用 `lockId`，错误消息 / 日志 / dispose teardown key 用 `id`，职责分离
  - **修复**（采纳候选 C）：
    1. **`core/registry.ts`**：
       - `Entry<T>` interface 新增 `lockId: string | undefined` 字段（语义判定用，与 `id` 拆开）+ JSDoc 标注「`id` 用于展示 / 错误消息 / teardown key；`lockId` 用于 driver / authority 语义判定」
       - `EntryFactory` 签名从 `(id, options, ctx) => Entry<T>` 扩展为 `(id, lockId, options, ctx) => Entry<T>`
       - `getOrCreateEntry` 调 `factory(id, id, options, { registerTeardown })` —— Registry 路径 `lockId === id`
    2. **`core/entry.ts`**：
       - `createEntryFactory` 闭包参数从 `(id, options, ctx)` 改为 `(id, lockId, options, ctx)`，下游 `pickDriver({ id: lockId, mode })` 与 `attachAuthority({ lockId, ... })` 全部用 `lockId` —— `lockId === undefined` 时 `pickDriver` 命中无 id 短路返回 LocalLockDriver，`attachAuthority` 命中 `lockId === undefined` 跳过（无 id 不启用 authority）
       - 返回的 Entry 对象 `lockId` 字段透传 factory 收到的 `lockId`
       - `acquireStandalone` 调 `factory('__local__', undefined, options, { registerTeardown })` —— `id` 用占位字符串保证非空，`lockId` 显式传 `undefined` 表达「无 id」
    3. **`core/actions.ts`**：
       - 新增 `buildAcquireName<T extends object>(entry: Entry<T>): string` helper：返回 `${LOCK_PREFIX}:${entry.lockId ?? '__local__'}`（standalone 退化到占位字符串只用于本地 driver name，不影响隔离 —— LocalLockDriver 内部按 entry 实例隔离 acquire 状态）
       - `performAcquire` 中 driver acquire name 从 `${LOCK_PREFIX}:${entry.id}` 改为 `buildAcquireName(entry)` —— Registry 路径仍是 `${LOCK_PREFIX}:${id}`（行为不变），standalone 路径变成 `${LOCK_PREFIX}:__local__` 但只透到 LocalLockDriver（已被 pickDriver 选中），跨 Tab driver 不再收到该 name
    - **关键设计点 1：双字段拆分而非魔法值识别**——`lockId === undefined` 是显式语义信号，下游判定不依赖字符串比较；`id` 在错误消息 / teardown key 中保留人类可读的 `'__local__'` 占位
    - **关键设计点 2：Registry 路径零行为变化**——`lockId === id` 让既有用户态代码（pickDriver、attachAuthority、performAcquire）的实际入参保持一致，回归测试无破坏
    - **关键设计点 3：标准 driver name 不暴露 standalone 给跨 Tab 通道**——standalone 路径 driver acquire name 只透到 LocalLockDriver，pickDriver 短路保证跨 Tab driver 永远收不到 `__local__` name
    - **关键设计点 4：authority 启用条件由 lockId 主导**——`syncMode === 'storage-authority' && lockId !== undefined` 双条件，standalone 即使配错 syncMode 也不会意外启用 StorageAuthority
  - **测试改造**（既有用例适配）：
    - `__test__/core/registry.node.test.ts`：7 处 stub factory 签名改为 `(id, lockId, options, ctx)`；buildFactory 加 `if (lockId !== id) throw new Error(...)` 断言（用 throw 替代 expect 避免 biome `useExpectAssertions` 在 helper 中误报）
    - `__test__/core/actions.browser.test.ts`：`createStubEntry` 添加 `lockId: id` 字段（模拟 Registry 路径）以匹配新 Entry 接口
  - **测试补强**（**新增 6 个用例**）：
    - `__test__/core/entry-standalone-driver-isolation.node.test.ts`（5 个 / Node 环境用 stub driver 验证语义）：
      1. `mode='web-locks'` + 无 id → 不抛错且实际走 LocalLockDriver（pickDriver 命中无 id 短路）
      2. `syncMode='storage-authority'` + 无 id → StorageAuthority 不启用（authorityHandle === null，无 localStorage 写入）
      3. CustomDriver 收到的 acquire name id 段为 `'__local__'`（验证 buildAcquireName 输出契约）
      4. 两个无 id 实例并发 update → 各自独立 acquire / release（counter 各加 1，无串扰）
      5. dispose 后 teardown key 是 `'__local__'`（错误消息 / 日志可读性）
    - `__test__/core/entry-standalone-driver-isolation.browser.test.ts`（1 个 / Browser 环境）：
      1. 有真实 id + `mode='web-locks'` → 仍走 WebLocksDriver（验证 `lockId !== undefined` 时 pickDriver 不退化）
  - **方案归档**：`src/shared/lock-data/fixes/standalone-id-leak.md`（缺陷复现路径、影响范围矩阵、候选方向 A/B/C 权衡、双字段拆分契约、实施清单、关键设计点、测试用例索引）
  - **验证**（2026/05/06 15:30 本地实测）：
    - `read_lints` 无错误
    - `pnpm run test:ci src/shared/lock-data/__test__/core/entry-standalone-driver-isolation.node.test.ts` → **node#shared 5/5 全绿**
    - `pnpm run test:ci src/shared/lock-data/__test__/core/entry-standalone-driver-isolation.browser.test.ts` → **browser#shared 1/1 全绿**
    - `pnpm run test:ci src/shared/lock-data/__test__/core/registry.node.test.ts` → 既有 stub 签名适配后全绿
    - `pnpm run test:ci src/shared/lock-data/__test__/core/` → 子目录全量回归全绿（含 actions.browser / actions-revoke-getlock / actions-dispose-race / actions-concurrent-write / draft / draft-json-only / registry / entry-standalone-driver-isolation）
    - `pnpm run check` → 全仓 clean
  - **关联文件**：`core/registry.ts`（Entry 接口 + EntryFactory 签名 + getOrCreateEntry 调用点）/ `core/entry.ts`（createEntryFactory 用 lockId、acquireStandalone 传 undefined）/ `core/actions.ts`（buildAcquireName helper、performAcquire 改 driver acquire name）/ `__test__/core/registry.node.test.ts`（stub factory 签名适配）/ `__test__/core/actions.browser.test.ts`（createStubEntry 加 lockId）/ `__test__/core/entry-standalone-driver-isolation.node.test.ts`（新增）/ `__test__/core/entry-standalone-driver-isolation.browser.test.ts`（新增）/ `fixes/standalone-id-leak.md`（方案文档归档）

- [x] **lockData API 单签名重构 + wrapper Proxy 方案 + 三大补丁**（2026/05/08 完成 / 🚨 BREAKING CHANGE / major bump）
  - **背景**：原三重载 + 双参数 `lockData(initial, options)` 暴露多处契约漏洞 ——
    ① `getValue` 与 `initial` 形成「冗余首值通道」语义混淆；② 异步路径下 `entry.data` 引用稳定契约依赖 `applyInPlace` 原地改写，对 readonly-view 的 wrapper 时机假设过强；③ 顶层数组（`unknown[]`）允许传入但 `commit/snapshot` 拷贝隔离会丢失 mutation 细节；④ `actions.read()` 与全局 `read()` 命名冲突；⑤ `dataReadyState` 三态 + `dataReadyError` 字段冗余（同步抛错路径下 Entry 根本不构造）；⑥ `assertJsonSafe` 仅覆盖 `update` 路径，`getValue` 返回值与 `replace` 入参绕过校验；⑦ `authority host.data` 引用契约被 `lockId` 拆分后仍未对齐 dataRef wrapper
  - **决策路径**（设计文档 `fixes/api-getvalue-only-redesign.md` §1-§14 详述）：
    - 方案演进：方案 A（保留 `initial`+`getValue` 双通道）→ 方案 B（合并到 `getValue` 单参数）→ wrapper Proxy + 三大补丁（最终方案）
    - **wrapper 方案核心**：以 `entry.dataRef: { current: T }` 替代 `entry.data` 引用稳定契约 —— 所有 readonly-view / authority / actions 通过同一个稳定 wrapper ref 访问数据，"重新赋值"通过修改 `.current` 完成，彻底消除 `applyInPlace` 原地改写依赖
    - **三大补丁**：① 顶层数组类型层 `LockDataValueShape<T>` 条件类型禁止 + 运行时 fail-fast；② `actions.read()` 改名为 `snapshot()` 避开命名冲突；③ JSON 拷贝隔离契约（`structuredClone` → `JSON.parse(JSON.stringify)` 限制）覆盖所有进入 `dataRef.current` 的入口
    - **半极简状态机**（设计文档 §12）：删除 `dataReadyState/dataReadyError` 字段；保留 `dataReadyPromise: Promise<T> | null` 单标志位；同步抛错路径 Entry 根本不构造（直接抛 `LockDisposedError`），异步路径 Entry 构造延迟到 resolve 后
    - **authority host 契约重构**（设计文档 §14.1）：`StorageAuthorityHost.data: T` 字段废弃；新增 `host.applyRemote(next: T): void` 方法 —— authority 不感知 dataRef wrapper 实现细节
    - **assertJsonSafe 公共闸**（设计文档 §14.4）：从 `core/draft.ts` 提取到 `utils/json-safe.ts`，`getValue` resolve 后 + `replace` 入参 + 同步返回值 + 异步 awaited 全部走同一道 fail-fast 校验
  - **修复**（11 个源码文件 + 多个测试文件 + 2 个文档）：
    1. **`types.ts`**：新增 `LockDataValueShape<T> = T extends unknown[] ? never : T` 类型工具；`LockDataOptions.getValue` 改为必传 + `LockDataValueShape<T>` 限制；`LockDataActions::read` 改名为 `snapshot`；删除 `CloneFn` 类型 + `LockDataAdapters.clone` 字段
    2. **`index.ts`**：删除三重载（同步签名 / 异步签名 / 通用签名），重写为单签名 + `LockDataValueShape<T>` 条件类型；调用 `lockDataImpl(options as unknown as LockDataOptions<T>)` 兜底类型转换；删除 `CloneFn` 公开导出 + 新增 `LockDataValueShape` 公开导出
    3. **`utils/json-safe.ts`**（新建）：`assertJsonSafe` + `assertNotTopLevelArray` + `cloneByJson` + `assertJsonSafeInput` 四个公共工具，从 `draft.ts` 迁移 JSON 安全校验逻辑
    4. **`core/registry.ts`**：重写 `resolveInitialData` 为 `prepareEntryData`（单参数 + getValue 必传 + 同步抛错走 `LockDisposedError` + 异步返回 `EntryInitialData`）；`Entry` 接口 `data: T → dataRef: { current: T }` + 新增 `applyRemote: (next: T) => void`；删除 `dataReadyState/dataReadyError` 字段；删除 `resolvePendingPlaceholder/buildFailedInitialData/resolveSyncFallback/buildPendingInitialData/applyInPlace`；新增 `EntryInitialData` 接口 + `cloneByJson` 工具；新增 `createFailedInitError(id, cause)` helper（同步路径 + 异步路径统一调用）
    5. **`core/readonly-view.ts`**：完全重写为 wrapper Proxy 方案（`new Proxy(dataRef, handler)` + 全 trap 重定向到 `dataRef.current`）；`createReadonlyView` 入参改为 `dataRef: { current: T }`；删除 Set/Map/Date 特殊处理（JSON-safe 契约已在入口拒绝）；导出 `DataRef` 类型
    6. **`core/entry.ts`**：`createEntryFactory` 删除 `initial` 参数；`lockData` 主入口改单参数 `options` + 顶层数组运行时 fail-fast；`mutableEntry` 新增 `dataRef + applyRemote`；`attachAuthority deps` 删除 `clone/applySnapshot:applyInPlace` 注入；`createReadonlyView` 入参改 `dataRef`；`finalizeResult` 删除 `dataReadyState` 判断 + 直接透传 dataReadyPromise reject（不二次包装）；新增 `buildApplyRemote(dataRef)` helper（authority 远程同步 / 异步 getValue resolve 共用单一入口）
    7. **`core/actions.ts`**：拆分为 `actions.ts`（物理 542 行 / 非空白 499 行）+ `actions-helpers.ts`（物理 399 行 / 非空白 369 行）以满足 biome `noExcessiveLinesPerFile.maxLines: 500 + skipBlankLines: true` 限制；删除 `applyInPlace` 来自 registry 的引用，新增 `cloneByJson/assertJsonSafeInput` 引用；`ensureDataReady` 删除 `dataReadyState` 判断；`entry.data` 全部改 `entry.dataRef.current`；`read()` 改名为 `snapshot()`；`commit` 快照走 `cloneByJson`；`replace` 路径调用 `assertJsonSafeInput`
    8. **`core/actions-helpers.ts`**（新建）：`applyInPlace`、`buildAcquireName`、`issueToken`、`releaseDriverHandle`、`resolveAcquireTimeout`、`resolveHoldTimeout`、`safeReleaseHandle`、`throwDisposed`、`toMilliseconds`、`translateAcquireError`、`ActionsInternalState`、`createInitialState`、`enqueueWrite`、`clearHoldTimer`、`attachSignalAutoDispose`、`noop` 等辅助函数
    9. **`adapters/index.ts`**：删除 `CloneFn` 引入 + `createSafeCloneFn` 引入；`ResolvedAdapters` 删除 `clone` 字段；`pickDefaultAdapters` 删除 clone 解析逻辑
    10. **`adapters/clone.ts`**：删除（不再需要 CloneFn 实现）
    11. **`authority/index.ts`**：`StorageAuthorityHost` 删除 `data: T` + 新增 `applyRemote: (next: T) => void`；`StorageAuthorityDeps` 删除 `clone + applySnapshot`；`applyAuthorityIfNewer` 改用 `host.applyRemote(nextSnapshot)`；`emitSync` 内 clone 改 `cloneByJson`
  - **测试改造**（既有用例适配 + 新增覆盖）：
    - `index.test.ts` 4 处 `lockData(initial, options)` 双参数 → `lockData({ getValue, ... })` 单参数
    - `__test__/core/entry.browser.test.ts` 4 处异步路径 + 同步抛错路径用例改写（同步抛错改为 `try/catch + void lockData()`，cause 链路验证 `LockDisposedError(cause=boom)`）
    - `__test__/core/entry-standalone-driver-isolation.browser.test.ts` 1 处旧形态适配
    - `__test__/core/registry.node.test.ts` 重写：`buildFactory` + `createMockAdapters` 适配 `dataRef + applyRemote`；删除旧 `resolveInitialData` 三大段测试；新增 **`prepareEntryData` 测试组**（同步路径：`firstValue` 经 `cloneByJson` 隔离、`getValue` 缺失 `TypeError`、同步抛错 `LockDisposedError`、顶层数组 `InvalidOptionsError`、非 JSON-safe `TypeError`；异步路径：`Promise.resolve` 携带 `awaited`、`Promise.reject` 为 `LockDisposedError`、resolve 顶层数组 reject、resolve 非 JSON-safe reject、多次 await 同一 dataReadyPromise 共享语义）；18 处 `getOrCreateEntry({}, ...)` 类型适配（声明全局 `noopOptions`，sed 批量替换）
    - `__test__/core/actions.browser.test.ts` + `actions-concurrent-write.node.test.ts` + `actions-revoke-getlock.node.test.ts` + `actions-dispose-race.node.test.ts`：`buildActions` 第二个入参类型从 `LockDataOptions<T>` 改为 `Pick<LockDataOptions<T>, 'listeners' | 'signal' | 'timeout'>`（`BuildActionsOptions<T>`），避免 `getValue` 必传约束污染测试用例
    - `__test__/core/readonly-view.node.test.ts`：完全重写为 wrapper Proxy 测试 + `delete view.name` 用例加 biome ignore 注释（验证 deleteProperty trap 必须用 delete 操作符）
    - `__test__/integration/memory-adapters.node.test.ts` 9 处旧形态批量改写（场景 1-7 全部从 `lockData(initial, options)` → `lockData({ id, getValue, ... })`）
    - `__test__/integration/entry.node.test.ts` 重写为单签名集成契约测试（`LockDataTuple<T> | Promise<LockDataTuple<T>>` 联合类型断言收窄）
    - `__test__/authority/integration.browser.test.ts` + `__test__/authority/init-dispose-race.node.test.ts`：host 工厂适配 `applyRemote` 方法 + `dataRef.current` 字段
    - `__test__/core/actions.browser.test.ts:670` 用例：`gate.reject(LockDisposedError(cause=boom))` 模拟 `prepareEntryData` 真实包装契约（修正测试期望与实际契约不一致）
    - 删除 `__test__/adapters/clone.node.test.ts` + `registry-async-initial-required.node.test.ts`（API 已废弃）
  - **关键设计点 1：单签名 + 条件类型精确推断（2026/05/08 二次重构升级）**——
    - **初版（2026/05/08 上午）**：单签名返回 `LockDataTuple<T> | Promise<LockDataTuple<T>>` 联合类型，调用方通过 `instanceof Promise` 运行时区分；同步路径仍需 `as LockDataTuple<T>` 断言才能解构，类型层有"是否 Promise"歧义
    - **终版（2026/05/08 下午）**：升级为条件类型自动推断，`function lockData<const O extends LockDataOptions<unknown>>(options: O): LockDataResolveReturn<O>` 单泛型 + `T` 从 `O['getValue']` 反推（调用方无需显式传任何泛型），三层条件分支：① `syncMode='storage-authority'` 时强制 `id: string`（缺 `id` 推为 `never`，编译期 fail-fast）；② 否则按 `getValue` 返回值是 `Promise<unknown>` 决定 `Promise<LockDataTuple<T>>`；③ 否则 `LockDataTuple<T>`
    - **关键技术点**：① `LockDataInfer<O>` 用 `Awaited<R> extends infer T extends object` 把同步 / 异步统一反推 `T`；② `LockDataResolveReturn<O>` 在 `LockDataValueShape<LockDataInfer<O>>` 为 `never` 时直接 `never`（顶层数组类型层禁止）；③ 约束位置仅用 `LockDataOptions<unknown>`（避免「O 的约束依赖 `LockDataInfer<O>`、`LockDataInfer<O>` 又依赖 O」的循环推断）；④ `LockDataReturn<T, O>` 第二参数约束放宽为 `object` 而非 `LockDataOptions<X>`（`LockDataListeners.onCommit` 逆变位置导致双向不变 → 必须 `object` 兜底协变）
    - **测试断言重写**：`index.test.ts` / `entry.node.test.ts` 删除全部 `as readonly [...]` / `as LockDataTuple<...>` 断言（共 6 处）；`expectTypeOf` 同步路径用 `toEqualTypeOf<LockDataTuple<Counter>>()`、异步路径用 `toEqualTypeOf<Promise<LockDataTuple<Counter>>>()` 精确分离；新增 `syncMode='storage-authority'` 缺 `id` → `never` 的类型层断言；`memory-adapters.node.test.ts` / `cross-tab.browser.test.ts` / `session-persistence.browser.test.ts` 共 35 处 `lockData<XXX>(...)` 显式泛型调用全部清理为 `lockData(...)` + `getValue: (): XXX => {...}` 显式返回类型注解
    - **类型测试抽离（2026/05/08 收尾，参考 `src/shared/condition-merge/index.test-d.ts` 模式）**：把 11 处 `expectTypeOf` 类型断言从 runtime 测试中分离到独立的 `.test-d.ts` 文件 —— 新建 `src/shared/lock-data/index.test-d.ts`（覆盖 lockData 同步 / 异步路径精确推断 + `syncMode='storage-authority'` 缺 id 推为 `never` + `ReadonlyView<T>` 加 readonly 共 4 项类型契约）+ `src/shared/lock-data/__test__/integration/entry.test-d.ts`（覆盖三条初始化路径类型契约 + `ReadonlyView<T>` 嵌套递归 readonly + 函数类型透传不递归）；从 `index.test.ts` / `entry.node.test.ts` 移除全部 `expectTypeOf` 断言及不再使用的 `LockDataTuple` / `ReadonlyView` 类型导入；配套 `vitest.project.config.ts:19` 的 `typecheck.include = ['src/${namespace}/**/*.test-d.ts']` 已支持自动收口（CI 环境 `enabled=!CI_TEST` 跳过省时间，本地 + `tsc --noEmit` 仍能强制校验）。**收益**：runtime 测试聚焦 runtime 行为、类型测试聚焦编译期契约，关注点分离；与仓库其它工具（`condition-merge` / 等）的测试组织风格保持一致
    - **`LockDataValueShape<T>` 类型层禁止顶层数组**保留不变，运行时 `Array.isArray(awaited)` fail-fast 兜底
  - **关键设计点 2：wrapper Proxy 引用稳定契约**——`dataRef` 引用本身在 Entry 生命周期内永不变更，所有"重新赋值"通过修改 `.current` 完成（commit / applyRemote / 异步 resolve）；readonly-view 直接以 dataRef 作为 Proxy target，`Object.isFrozen(view) === false` 是已知瑕疵（已在 RFC 文字说明声明：判型不可靠，约定式只读）
  - **关键设计点 3：Entry 构造延迟 + 同步抛错 fail-fast**——同步抛错路径 Entry 根本不构造（直接抛 `LockDisposedError`，不进 registry），异步抛错路径 Entry 构造延迟到 `dataReadyPromise.resolve` 之后；`finalizeResult` 直接透传 `dataReadyPromise` reject（不二次包装），让用户拿到的 cause 直接指向 `getValue` 原始错误
  - **关键设计点 4：JSON-safe 公共闸单点收敛**——所有进入 `dataRef.current` 的值（同步 / 异步 / authority 远程同步 / replace 入参 / update commit）都在 `assertJsonSafeInput` 统一校验，校验失败 fail-fast，调用方拿到 `firstValue` 时已是 JSON 安全状态
  - **关键设计点 5：authority 钩子重构**——`host.applyRemote(next)` 方法替代 `host.data` 字段直读 + `applySnapshot` 钩子，authority 层完全不感知 dataRef wrapper 实现细节（仅依赖 `applyRemote` 方法签名）
  - **关键设计点 6：actions.ts 文件拆分**——`actions.ts` 主流程（非空白 499 行）+ `actions-helpers.ts` 辅助函数（非空白 369 行），满足 biome `noExcessiveLinesPerFile.maxLines: 500 + skipBlankLines: true` 限制；拆分按职责（主流程 vs 辅助函数）而非按行数硬切
  - **方案归档**：`fixes/api-getvalue-only-redesign.md`（重写后内容：方案演进 → wrapper 方案 → 三大补丁 → Q1-Q8 决策 → 设计文档 §14.1-§14.4 缺口订正）
  - **过期文档清理**：删除 `fixes/initial-data-shape-mismatch.md`（fail-fast 方案已被新 API 完全取代）
  - **验证**（2026/05/08 09:30 本地实测）：
    - `pnpm run check` → 全仓 200 文件 clean
    - `pnpm run test:ci src/shared/lock-data/` → **40/40 测试文件通过 + 461/461 用例全绿**
    - `read_lints src/shared/lock-data` → 仅 IDE 索引缓存对已删除文件的陈旧报错（`adapters/clone.ts` + `__test__/adapters/clone.node.test.ts`，shell `find` 多次确认实际不存在）
    - `pnpm run build` → 84 文件生成在 dist，shared 70.3KB / react 2.8KB / vue 0.45KB，esm0/esm1 双产物声明文件正常生成
  - **关联文件**：`types.ts` / `index.ts` / `utils/json-safe.ts`（新建）/ `core/registry.ts` / `core/readonly-view.ts` / `core/entry.ts` / `core/actions.ts` / `core/actions-helpers.ts`（新建）/ `adapters/index.ts` / `adapters/clone.ts`（删除）/ `authority/index.ts` / `authority/serialize.ts` / 大量 `__test__/**` 测试文件 / `RFC.md`（受影响章节全文重写）/ `fixes/api-getvalue-only-redesign.md`（重写）/ `fixes/initial-data-shape-mismatch.md`（删除）

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

- **设计源头**：[`./RFC.md`](./RFC.md) (0.1.5, accepted on 2026/05/08)
- **编码规范**：`../../../AGENTS.md`（报错走 `shared/throw-error`）
- **项目测试约定** `../../../vitest.config.ts`
