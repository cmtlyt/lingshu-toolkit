# lockData API 重构方案：单参数 + getValue 必传 + wrapper Proxy + JSON 拷贝隔离（完全 breaking）

> 范围：`src/shared/lock-data/index.ts` + `src/shared/lock-data/core/{entry,registry,actions,readonly-view}.ts` + `src/shared/lock-data/types.ts` + `src/shared/lock-data/authority/index.ts` + `src/shared/lock-data/adapters/` + `src/shared/lock-data/RFC.md`
>
> 状态：**已敲定，待实施**
>
> 决策摘要：完全 breaking 重构（无兼容层），由 changeset 驱动 major bump；公开 API 收敛为单参数 `options` + `getValue` 必传；**彻底废弃 entry.data 引用稳定契约**，改为 wrapper Proxy + dataRef 间接层；初始化与 commit 链路统一走 `JSON.parse(JSON.stringify(...))` 拷贝隔离；**禁止顶层数组**（类型层条件类型 + 运行时 fail-fast 双重拦截）；`actions.read()` 改名为 `actions.snapshot()`；废弃 `adapters.clone` 适配器整个删除

---

## 0. 阅读导引

| 你想了解 | 直达章节 |
| --- | --- |
| 为什么要做这次重构 | §1 当前 API 的内在矛盾 |
| 新 API 长什么样 | §2 新 API 形态 |
| wrapper Proxy 是什么、为什么必须 | §3 引用稳定契约的废弃 + §4 wrapper Proxy 方案 |
| 顶层数组为什么禁止 + 怎么禁止 | §5 顶层数组双重禁止 |
| `actions.snapshot()` 取代 `read()` 的原因 | §6 actions 接口调整 |
| JSON 拷贝隔离是什么 | §7 JSON 拷贝隔离契约 |
| 实施改动到哪些文件 | §8 改动文件矩阵 |
| 实测信息（行号、调用数等） | §9 实测前置确认清单 |
| 关联设计 / 不做的事 | §10 关键设计点 / §11 不做的事 |
| dataReadyState 状态机为何能简化 | §12 dataReadyState 状态机极简化（缺口 4 决策） |
| 关联文件清单 | §13 关联文件 |
| 缺口 2/3/5/7 决策档案 | §14 缺口 2/3/5/7 决策档案 |

---

## 1. 当前 API 的内在矛盾（设计起点）

### 1.1 公开签名（实测当前 `index.ts:43-77`）

```ts
// 分支 A：同步初始化
function lockData<T>(data: T, options?: LockDataOptions<T>): LockDataTuple<T>;

// 分支 B：异步初始化（getValue 返 Promise）
function lockData<T>(data: T | undefined, options: { getValue: () => Promise<T> }): Promise<LockDataTuple<T>>;

// 分支 C：异步初始化（syncMode='storage-authority'）
function lockData<T>(data: T, options: { syncMode: 'storage-authority' }): Promise<LockDataTuple<T>>;
```

### 1.2 第一个参数的语义二义性

按 `getValue` 的有无 / 形态，第一个参数承担**完全不同**的职责：

| 调用形态 | 第一个参数职责 |
| --- | --- |
| 无 `getValue` | 唯一数据来源，必传 |
| `getValue` 同步返回值 | 完全冗余（`getValue` 返回值优先；RFC L141 旧契约） |
| `getValue` 返 Promise | 占位引用（pending 期间内部模块读到的内容；用户拿不到 view） |

新手必须读完 RFC L141 / L664 才能正确使用 —— 这违反"API 自解释"原则。

### 1.3 顶层数组形态错配（连锁缺陷）

异步分支占位逻辑（实测 `core/registry.ts:483-494`）：

```ts
function resolvePendingPlaceholder<T>(initial: T | undefined): T {
  if (initial === undefined) return {} as T;  // ← 固定 {} 占位
  return initial;
}
```

`getValue: () => Promise.resolve([1,2,3])` + `initial===undefined` 时：
- 占位是 `{}`
- resolve 后 `applyInPlace({}, [1,2,3])` 抛 TypeError（结构错配）
- 顶层数组异步初始化永远走不通

**之前尝试**：在异步分支前置加 fail-fast 校验（`initial` 缺失即抛 `InvalidOptionsError`）。但这违反了分支 B 重载的公开契约（`data: T | undefined`），integration 测试失败，已被用户回滚。

### 1.4 引用稳定契约的代价

RFC 现有契约：「`entry.data` 引用在 Entry 生命周期内永不变更」。

为了维持这一契约，异步路径不得不引入**占位机制**（构造期就要有合法的 `entry.data` 引用）。占位带来的连锁缺陷：

- 顶层数组结构错配（§1.3）
- 占位 `{}` 的内容**根本不是真正的数据**，但 RFC 又承诺 entry.data 引用稳定 —— 这是**虚假承诺**：用户拿到 view 时已经在 dataReadyPromise resolve 之后，pending 期间的引用稳定对用户没有任何价值
- 内部模块（authority init / fanout）在 pending 期间读 entry.data 会拿到占位 `{}`，必须依赖 `dataReadyPromise` 防御性等待

### 1.5 设计目标

本次重构追求三个目标：

1. **API 心智简化**：用户面只剩一个数据来源（`getValue`），不需要在 `data` / `getValue` / `data + syncMode` 之间记忆优先级
2. **顶层数组问题彻底消失**：要么类型层禁止，要么形态完全由 `getValue` 决定
3. **释放引用稳定契约的束缚**：占位机制消失，`entry.dataRef.current` 在每次 commit / init resolve 都可以重新赋值；view 通过 wrapper Proxy 跟随引用变化

---

## 2. 新 API 形态

### 2.1 类型与签名

```ts
// types.ts
type LockDataValueShape<T> = T extends unknown[] ? never : T;

interface LockDataOptions<T extends object> {
  /** 数据初始化函数（必传）；同步返回 → 同步路径；返 Promise → 异步路径 */
  getValue: () => LockDataValueShape<T> | Promise<LockDataValueShape<T>>;
  // 其他原有字段：id / mode / syncMode / persistence / listeners / adapters / timeout / sessionProbeTimeout
}

// index.ts —— 单签名 + 严格条件类型推断返回
function lockData<T extends object, O extends LockDataOptions<T>>(
  options: O,
): O extends { syncMode: 'storage-authority' }
  ? Promise<LockDataTuple<T>>
  : ReturnType<O['getValue']> extends Promise<unknown>
    ? Promise<LockDataTuple<T>>
    : LockDataTuple<T>;
```

### 2.2 用户用法对比

```ts
// 旧 API
lockData({ count: 0 });                                          // 同步常量
lockData({ count: 0 }, { syncMode: 'storage-authority' });       // 同步 + storage 同步
lockData(undefined, { getValue: () => fetch('/api/x') });        // 异步 fetch
lockData({ count: 0 }, { getValue: () => fetch('/api/x') });     // initial 形同虚设

// 新 API
lockData({ getValue: () => ({ count: 0 }) });                                            // 同步常量
lockData({ getValue: () => ({ count: 0 }), syncMode: 'storage-authority' });             // 同步 + storage 同步
lockData({ getValue: () => fetch('/api/x') });                                           // 异步 fetch
// 第四种用法消失：fallback 逻辑由用户在 getValue 内部显式处理（见 §10.2）
```

### 2.3 收益矩阵

| 维度 | 旧 API | 新 API |
| --- | --- | --- |
| 公开重载数量 | 3 重载 + 1 实现签名 | 1 签名（条件类型推断返回） |
| `resolveInitialData` 分支数 | 5 条（含 sync fallback / placeholder / failed patch / sync return / async pending） | 2 条（同步 / 异步） |
| 「`initial` vs `getValue` 优先级」心智 | 必读 RFC L141 | 不存在（数据来源唯一） |
| 顶层数组形态错配 | 有（占位固定 `{}`） | 无（类型层 + 运行时双重禁止；§5） |
| `data` 引用稳定起点 | 调用 `lockData()` 即刻 | **彻底废弃此契约**；改为 view 引用稳定（wrapper Proxy） |
| 删除函数 | — | `resolveSyncFallback` / `resolvePendingPlaceholder` / `buildFailedInitialData` / `buildPendingInitialData` 全部消失 |
| 拷贝隔离 | 无（`initial` 引用直接进 entry.data） | 全链路 `JSON.parse(JSON.stringify(...))` 隔离 + fail-fast |

### 2.4 必须直面的代价

| # | 代价 | 评估 |
| --- | --- | --- |
| 1 | 同步常量场景多写 12 字符（`{ getValue: () => value }`） | 接受（用户决策 Q1） |
| 2 | 「本地缓存兜底 + 远程覆盖」用法消失（旧 API 也未真正实现，§10.2） | 接受（用户决策 Q2） |
| 3 | `syncMode='storage-authority'` 必须传 `getValue` | 接受（用户决策 Q3） |
| 4 | 完全 breaking、无兼容层 | 接受（用户决策 Q6；0.6.0 阶段） |

---

## 3. 引用稳定契约的废弃（解读 B）

### 3.1 旧契约（待废弃）

> RFC：「`data` 引用在 Entry 生命周期内永不变更；所有"替换 data"都是原地修改内容」

实现路径：
- 同步分支：`entry.data = initial`（或 `getValue()` 同步返回值）
- 异步分支：`entry.data = initial ?? {}`（占位）→ resolve 后 `applyInPlace(entry.data, next)` 原地覆写
- commit 路径：`applyInPlace(entry.data, mutated)` 原地覆写
- authority 远程同步：`applyInPlace(host.data, nextSnapshot)` 原地覆写

**实测验证**（grep 全仓 `entry\.data\s*=`）：源码中**没有任何 `entry.data` 重新赋值点**，旧契约被严格遵守。

### 3.2 新契约

> 修订：「**`entry.dataRef` 引用稳定**（构造完成后），`entry.dataRef.current` 在每次 commit / init resolve / authority `host.applyRemote` 都重新赋值；外部 readonly view 通过固定 Proxy + wrapper target 跟随 `dataRef.current` 变化」

数据结构变化：

```ts
// 旧
interface Entry<T> {
  data: T;
  // ...
}

// 新
interface Entry<T> {
  dataRef: { current: T };
  // ...
}
```

实现路径：

| 阶段 | 处理 |
| --- | --- |
| 同步路径（`getValue: () => T` 同步返回值） | Entry 构造期 `dataRef = { current: JSON.parse(JSON.stringify(getValue())) }` |
| 异步路径（`getValue: () => Promise<T>`） | **Entry 提前注册 + dataRef.current 占位**：lockData 主入口先 `getOrCreateEntry()` 注册 Entry（refCount=1），dataRef.current 设为 `{}` 占位；await getValue resolve 后 `dataRef.current = JSON.parse(JSON.stringify(awaited))`；详见 §14.3 |
| 同 Tab 二次调用方命中已存在 Entry | `lockData(sameOptions)` 通过 `getOrCreateEntry` 命中 → refCount++ → 共享同一 `dataReadyPromise` → resolve 后所有持有者拿到同一 dataRef 引用（详见 §14.3 缺口 5 订正） |
| commit 成功 | `dataRef.current = JSON.parse(JSON.stringify(committedNext))` 重新赋值（不再 applyInPlace 到 entry.data） |
| authority 远程快照同步 | `host.applyRemote(nextSnapshot)` 内部执行 `dataRef.current = JSON.parse(JSON.stringify(nextSnapshot))` 重新赋值（详见 §14.1 缺口 2 钩子重构） |

### 3.3 这个变化为什么是良性的

旧契约的"data 引用从一开始稳定"实际上是**虚假承诺**：

- 异步分支的 entry.data 一开始是 `{}` 或用户传的 `initial`，但内容**根本不是真正的数据**
- 用户必须 `await lockData(...)` 之后才能拿到合法 view
- pending 阶段的 entry.data 引用稳定，**对用户没有任何价值**（用户访问不到 view）

新契约把"引用稳定"的语义对齐到正确的层次：

| 层次 | 引用稳定性 |
| --- | --- |
| **`entry.dataRef`**（内部 wrapper 引用） | ✅ 永不变更（构造完成后） |
| **`view`**（用户面 Proxy） | ✅ 永不变更（指向 wrapper Proxy） |
| **`entry.dataRef.current`**（实际数据引用） | ❌ 每次 commit / init resolve / `host.applyRemote` 都重新赋值 |

用户面看到的 view 引用稳定，但**view 内的字段值会跟随 dataRef.current 的变化**（通过 Proxy trap 解引用 `dataRef.current`）。

### 3.4 此契约变化的连锁影响

| 影响 | 说明 |
| --- | --- |
| `applyInPlace` 用法 1（authority applySnapshot 钩子）| 废弃 —— 缺口 2 决策（§14.1）：`applySnapshot` 钩子整体从 deps 删除，改为 `host.applyRemote(next)` 方法；方法内部执行 `dataRef.current = JSON.parse(JSON.stringify(next))` |
| `applyInPlace` 用法 2（异步初始化占位覆写）| 废弃 —— 异步路径不再有占位 |
| `applyInPlace` 用法 3（`actions.replace(next)` 内部 draft mutation 翻译）| **保留** —— 这是对 draft Proxy 的 mutation 翻译工具，与引用稳定无关；从 `core/registry.ts` 迁出到 `core/actions.ts` 内部（不再 export） |
| `createReadonlyView` | 完全重写为 wrapper Proxy（§4） |
| `dataReadyState` 状态机 | 异步路径下 `lockData()` 在 resolve 前不返回元组，外部看不到 `'pending'` 态 —— 状态机可能可以简化为 `'ready' \| 'failed'`（缺口 4，待讨论） |

---

## 4. wrapper Proxy 方案

### 4.1 设计动机

新契约下 `entry.dataRef.current` 在每次 commit / init resolve 都会被重新赋值。如果 view 直接 `new Proxy(entry.dataRef.current, handler)`，target 会被烧死在第一次构造时的引用上 —— 用户保存的 `const cachedView = view` 在 commit 后会指向**旧数据**，违反"view 跟随数据变化"的预期。

可选方案对比：

| 方案 | view 引用稳定 | target 跟随 | 实现复杂度 |
| --- | --- | --- | --- |
| 直接 `Proxy(dataRef.current, ...)` + commit 后重建 view | ❌ | ❌ | 低 |
| 闭包 getter `Proxy(() => dataRef.current, ...)` + 每次 trap 重新解引用 | ✅ | ✅ | 高（trap 实现复杂） |
| **wrapper `Proxy(dataRef, ...)` + trap 全部解引用 `dataRef.current`** | ✅ | ✅ | 中 |

用户选定 wrapper 方案。

### 4.2 wrapper 形态与 Proxy handler

```ts
// core/readonly-view.ts
function createReadonlyView<T extends object>(dataRef: { current: T }): T {
  const cached = READONLY_CACHE.get(dataRef);
  if (cached !== undefined) {
    return cached as T;
  }
  const proxy = new Proxy(dataRef, READONLY_HANDLER) as unknown as T;
  READONLY_CACHE.set(dataRef, proxy);
  return proxy;
}

const READONLY_HANDLER: ProxyHandler<{ current: object }> = {
  get(ref, key, _receiver) {
    const target = ref.current;
    // Set / Map 容器的 mutation / 非 mutation 方法分流（保留现有逻辑）
    const targetType = getType(target);
    if (targetType === 'set' || targetType === 'map') {
      const value = Reflect.get(target, key);
      const member = resolveCollectionMember(target, key, value);
      return member;
    }
    const value = Reflect.get(target, key);
    if (isPlainAccessible(value)) {
      // 子对象走子 ref：每次 get 都为子对象建一个临时 wrapper，配合 WeakMap 缓存
      return createReadonlyView({ current: value });
    }
    return value;
  },
  has(ref, key) {
    return Reflect.has(ref.current, key);
  },
  ownKeys(ref) {
    return Reflect.ownKeys(ref.current);
  },
  getOwnPropertyDescriptor(ref, key) {
    return Reflect.getOwnPropertyDescriptor(ref.current, key);
  },
  getPrototypeOf(ref) {
    return Reflect.getPrototypeOf(ref.current);
  },
  set: rejectMutation,
  deleteProperty: rejectMutation,
  defineProperty: rejectMutation,
  setPrototypeOf: rejectMutation,
};
```

### 4.3 实测验证（已完成）

实测脚本路径：`/tmp/proxy-invariant-probe/probe.mjs`（Node 24.14.1）。

#### 通过项

| 场景 | 结果 |
| --- | --- |
| 普通对象 `view.field` / `view.nested.foo` | ✅ |
| `'field' in view` | ✅ |
| `'current' in view`（隐私泄漏） | ✅ false |
| `Object.keys(view)` 普通对象 | ✅ 返回真实数据字段 |
| `Reflect.ownKeys(view)` | ✅ 返回真实数据字段 |
| `Object.getOwnPropertyDescriptor(view, 'field')` | ✅ 返回真实描述符 |
| `Object.getOwnPropertyDescriptor(view, 'current')` | ✅ undefined（不泄漏 wrapper） |
| `JSON.stringify(view)` 普通对象 | ✅ 正常输出 |
| `Object.entries(view)` | ✅ |
| `view instanceof Object` | ✅ true |
| 写入操作（`view.x = 1` / `delete view.x` / `Object.defineProperty`） | ✅ 抛 ReadonlyMutationError |
| `dataRef.current = newObj` 后 `view.field` | ✅ 跟随到新值 |
| `dataRef.current = newObj` 后 `Object.keys(view)` | ✅ 返回新字段集 |
| 用户访问 `view.current` | ✅ undefined（被 trap 拦截） |

#### 致命项（被三大补丁消解）

| 场景 | 实测结果 | 消解方式 |
| --- | --- | --- |
| 顶层数组 `JSON.stringify(view)` | ❌ TypeError（`length` invariant：trap 报告 non-configurable，但 wrapper 上没有 length 字段） | §5 顶层数组双重禁止 |
| 顶层数组 `Object.keys(view)` | ❌ TypeError（同 length invariant） | §5 顶层数组双重禁止 |
| 顶层数组 `Array.isArray(view)` | ❌ false（target 是 wrapper 不是数组） | §5 顶层数组双重禁止 |
| `dataRef.current = Object.freeze({...})` 时 `Object.keys(view)` | ❌ TypeError（trap 报告 non-configurable，但 wrapper 字段是 configurable） | §7 JSON 拷贝隔离（拷贝出的对象一定不是冻结的） |
| `structuredClone(view)` | ❌ DOMException（Web 标准对 Proxy 的限制，无解） | §6 actions.snapshot() 替代 |

#### 可接受瑕疵

| 场景 | 实测结果 | 处理 |
| --- | --- | --- |
| `Object.isFrozen(view)` | ❌ false（wrapper 不是冻结的，但 view 写入仍被 trap 拒绝） | RFC 文字说明：「判定 view 只读应通过约定，不可依赖 `Object.isFrozen`」 |

### 4.4 子对象 view 的处理

当前 `createReadonlyView` 用 `WeakMap<object, Proxy>` 缓存子对象 Proxy。新方案下：

- **根 view**：缓存 key 是 `dataRef`（wrapper）；commit 后 `dataRef.current` 被重新赋值，但 `dataRef` 引用不变 → 缓存命中，view 引用稳定
- **子对象 view**：缓存 key 是临时 `{ current: value }` —— 每次 get 都构造新 ref → 缓存永远 miss → **缓存膨胀风险**

#### 优化策略

子对象 view 不需要 wrapper（子对象不会被外部"重新赋值"，只会随父对象的 dataRef.current 切换而整体替换）：

```ts
// 子对象路径走传统 Proxy（target 是子对象本身）
function createChildView<T extends object>(target: T): T {
  const cached = READONLY_CACHE.get(target);
  if (cached !== undefined) return cached as T;
  const proxy = new Proxy(target, CHILD_READONLY_HANDLER) as T;
  READONLY_CACHE.set(target, proxy);
  return proxy;
}
```

根 view 用 wrapper-based handler，子对象 view 用 target-based handler，两者共享相同的 trap 逻辑（除 get 返回子 view 的入口不同）。

### 4.5 root view 缓存的 WeakMap key

根 view 的 WeakMap key 是 `dataRef`（wrapper 对象）；同一 Entry 的 dataRef 引用全程稳定，view 引用全程稳定。

跨 Entry 的 view 不共享缓存（不同 Entry 有不同 dataRef）。这与 RFC 现有契约一致。

---

## 5. 顶层数组双重禁止

### 5.1 为什么必须禁止顶层数组

实测 wrapper Proxy 方案下顶层数组的多个核心 API 抛错（§4.3 致命项）：

- `JSON.stringify(view)` 顶层数组抛 `length` invariant TypeError
- `Object.keys(view)` 顶层数组抛 `length` invariant TypeError
- `Array.isArray(view)` 顶层数组永远返回 false（target 是 wrapper 不是数组）

根因：JS Proxy 对数组 `length` 字段的 invariant 强制要求 `configurable: false` 必须在 target 自身存在；wrapper `{ current: T }` 上没有 length 字段，必然违反 invariant。

**绕过方案**（如形态匹配占位）实施复杂且仍有边界缺陷。**根本解法**：直接禁止顶层数组，让用户把数组包一层（`{ list: [...] }`）。

### 5.2 类型层禁止（条件类型）

```ts
// types.ts
type LockDataValueShape<T> = T extends unknown[] ? never : T;

interface LockDataOptions<T extends object> {
  getValue: () => LockDataValueShape<T> | Promise<LockDataValueShape<T>>;
  // ...
}

function lockData<T extends object, O extends LockDataOptions<T>>(
  options: O,
): /* 条件类型推断返回 */;
```

效果：

```ts
// ❌ 编译期错误
lockData<number[]>({ getValue: () => [1, 2, 3] });
//  ^^^^^^^^ Type 'number[]' is not assignable to type 'never'

// ❌ 编译期错误
lockData<string[]>({ getValue: () => Promise.resolve(['a', 'b']) });

// ✅ 包一层即可
lockData({ getValue: () => ({ list: [1, 2, 3] }) });
```

#### 类型层选择理由

| 候选 | 优势 | 劣势 |
| --- | --- | --- |
| A：`{ [K: string]: unknown } & { length?: never }` | 类型简单 | 误伤含 `length` 字段的合法对象（如 `{ length: 10, name: 'foo' }`） |
| B：`T extends object`（不严格排除数组，靠运行时） | 实现最简 | 编译期不阻拦数组，用户错误延迟到运行时才发现 |
| **C：`T extends unknown[] ? never : T`** | **最严格、最干净，编译期完全杜绝** | 类型表达稍复杂 |

用户选 C（决策已锁定）。

### 5.3 运行时禁止（fail-fast）

类型层只能阻拦显式声明 `<T>` 的用户。运行时仍需兜底：

```ts
// core/entry.ts::lockData 主入口（同步路径）
function lockData<T extends object>(options: LockDataOptions<T>): /* ... */ {
  // ... 标准化 options
  // 同步路径：getValue() 同步返回值时立即校验
  const raw = options.getValue();
  if (!isPromiseLike(raw)) {
    if (Array.isArray(raw)) {
      throwError(
        ERROR_FN_NAME,
        'lockData top-level value cannot be an Array; wrap it in an object (e.g. { list: [...] })',
        InvalidOptionsError as unknown as ErrorConstructor,
      );
    }
    // ... 同步路径继续
  }
  // 异步路径：await 之后再校验
  return raw.then((awaited) => {
    if (Array.isArray(awaited)) {
      throwError(
        ERROR_FN_NAME,
        'lockData top-level value cannot be an Array; wrap it in an object (e.g. { list: [...] })',
        InvalidOptionsError as unknown as ErrorConstructor,
      );
    }
    // ... 异步路径继续
  });
}
```

### 5.4 错误类型选择

`InvalidOptionsError` —— 这是用户传参错误（数据形态不合法），不是运行时初始化失败（getValue 抛错），与 `LockDisposedError` 语义边界一致：

| 错误类型 | 触发条件 |
| --- | --- |
| `InvalidOptionsError` | 参数非法（顶层数组 / 必传字段缺失 / 类型错误） |
| `LockDisposedError` | 运行时初始化失败（getValue reject / 同步抛错 / authority init 失败） |

### 5.5 同 Tab 二次调用场景下的双重禁止

> **订正说明**（缺口 5）：跨 Tab 不共享 InstanceRegistry，每个 Tab 独立运行 `getValue()`，不存在「副本 Tab 命中已存在 Entry」场景；本节描述的是**同 Tab 二次调用** `lockData(sameOptions)` 命中已存在 Entry 的路径。

同 Tab 二次调用路径下，二次调用方的 `lockData()` 通过 `getOrCreateEntry` 命中已存在 Entry，不会再次执行 `getValue` —— 但**二次调用方的 options 类型层校验仍然生效**（编译期由 TypeScript 检查；运行时不会再次触发 fail-fast，因为 getValue 不会被调用）。

首次调用方的 fail-fast 拒绝顶层数组后，Entry 根本不会构造（异步路径下 `dataReadyPromise.reject` + `entry.refCount = 0` + `registry.delete(id)`，详见 §14.3.4），二次调用方的命中路径自然也不会走到。

跨 Tab 同 id 路径下，每个 Tab 各自独立运行 `getValue()`，各自独立做顶层数组类型/运行时双重校验，互不干扰。

---

## 6. actions 接口调整：read() → snapshot()

### 6.1 当前 `actions.read()` 实测

实测 `core/actions.ts:752-755`：

```ts
read(): T {
  ensureAlive();
  return deps.entry.adapters.clone(deps.entry.data);
},
```

返回 `entry.adapters.clone(entry.data)` —— 默认 `createSafeCloneFn` 三级降级：`structuredClone` → `JSON.parse(JSON.stringify(...))` → 原值 + warn。

类型签名实测 `types.ts:263 read: () => T`。

### 6.2 改名为 `actions.snapshot()` 的两个动机

#### 动机 1：消解 `structuredClone(view)` 抛 DOMException

实测 wrapper 方案下 `structuredClone(view)` 抛 `DOMException: #<Object> could not be cloned.` —— Web 标准对 Proxy 的硬限制，无解。用户失去"把 view 直接传 postMessage / 序列化"的能力。

`actions.snapshot()` 提供逃生通道：

```ts
const [view, actions] = lockData({ getValue: () => ({ count: 0, list: [1, 2, 3] }) });

// ❌ structuredClone(view) → DOMException
// ❌ window.postMessage(view, '*') → 内部走 structuredClone，同样失败

// ✅ 通过 actions.snapshot() 拿到原生对象
const plain = actions.snapshot();
window.postMessage(plain, '*');                              // ok
localStorage.setItem('cache', JSON.stringify(plain));        // ok
```

#### 动机 2：语义清晰化

`read()` 名字暗示"读取" —— 用户可能误以为返回 view 本身或浅拷贝。`snapshot()` 名字明确"快照"语义：返回当前数据的可序列化深拷贝，与 view 引用完全断开。

### 6.3 新签名

```ts
// types.ts: LockDataActions<T>
interface LockDataActions<T> {
  // ... 其他字段不变
  /**
   * 返回当前数据的可序列化深拷贝（JSON.parse(JSON.stringify(...))）
   * - 与 view 引用完全断开，用户修改不影响 view / entry
   * - 用于 structuredClone / postMessage / 持久化等需要原生对象的场景
   * - 受 disposed 约束：dispose 后调用抛 LockDisposedError
   */
  snapshot: () => T;
}
```

### 6.4 不保留 `read()` 别名 —— 完全 breaking

用户决策 Q（read vs snapshot）= B「彻底 breaking，一个动作一个名字」。不保留 `read()` —— 一个动作一个名字，避免心智负担。

### 6.5 实现

```ts
// core/actions.ts
snapshot(): T {
  ensureAlive();
  return JSON.parse(JSON.stringify(deps.entry.dataRef.current)) as T;
},
```

与 commit 路径快照拷贝（§7.2 #3）行为一致 —— 整个模块统一走 `JSON.parse(JSON.stringify(...))`。

### 6.6 用户面影响

| 场景 | 旧 API | 新 API |
| --- | --- | --- |
| 取数据快照 | `actions.read()` | `actions.snapshot()` |
| 序列化 | `JSON.stringify(actions.read())` | `JSON.stringify(actions.snapshot())` |
| postMessage | `postMessage(actions.read())` | `postMessage(actions.snapshot())` |
| 与 view 配合做差量计算 | `const before = actions.read(); /* mutate */; const after = actions.read();` | `const before = actions.snapshot(); /* mutate */; const after = actions.snapshot();` |

### 6.7 测试影响（实测）

实测 `actions.read()` 调用点 4 处，全部位于 `__test__/core/actions.browser.test.ts`：

| 行号 | 上下文 |
| --- | --- |
| 418 | `expect(() => actions.read()).toThrow(LockDisposedError)` |
| 744 | `const snapshot = actions.read()`（变量名巧合也叫 snapshot，与方法重名） |
| 753 | `actions.read()` |
| 754 | `actions.read()` |

全部改名为 `actions.snapshot()`。生产代码（`src/shared/lock-data/**/*.ts`，不含测试）无 `actions.read()` 调用 —— 实测 grep 验证。

`__test__/adapters/` 目录下的 `adapter?.read()` / `authority.read()` / `store.read()` 是 adapter 自身的 `read` 字段（与 `LockDataActions::read` 无关），保留不动。

---

## 7. JSON 拷贝隔离契约

### 7.1 契约定义

> 所有跨「外部 ↔ Entry」、「Entry ↔ 用户监听器」、「Entry ↔ Entry（authority 远程同步）」边界的对象拷贝，统一走 `JSON.parse(JSON.stringify(value))`，并以此实现：
>
> 1. **引用隔离**：拷贝出的对象与原始对象引用完全断开（包括嵌套子对象），任意一方的修改不影响另一方
> 2. **Fail-fast 校验**：`JSON.stringify` 遇到 `function` / `BigInt` / 循环引用等不可序列化值时抛错，作为参数非法的早期信号
> 3. **冻结状态消解**：`JSON.parse` 出来的对象一定不是 frozen 的，规避 wrapper Proxy 在冻结对象 target 上的 invariant 抛错（§4.3）

### 7.2 全部拷贝点（实测）

| # | 位置 | 旧实现 | 新实现 |
| --- | --- | --- | --- |
| 1 | `core/registry.ts::resolveInitialData`（同步路径） | `entry.data = getValue() 同步返回值`（直接引用） | `entry.dataRef.current = JSON.parse(JSON.stringify(getValue()))` |
| 2 | `core/registry.ts::resolveInitialData`（异步路径 resolve 后） | `applyInPlace(entry.data, awaited)` | `entry.dataRef.current = JSON.parse(JSON.stringify(awaited))` |
| 3 | `core/actions.ts:581`（commit 快照） | `entry.adapters.clone(entry.data)` | `JSON.parse(JSON.stringify(entry.dataRef.current))` |
| 4 | `core/actions.ts:753`（read → snapshot） | `entry.adapters.clone(entry.data)` | `JSON.parse(JSON.stringify(entry.dataRef.current))` |
| 5 | `core/actions.ts:534`（draft session base） | `createDraftSession(entry.data)`（直接引用） | `createDraftSession(JSON.parse(JSON.stringify(entry.dataRef.current)))` |
| 6 | `authority/index.ts:188`（emitSync 二次拷贝） | `clone(nextSnapshot)` | `JSON.parse(JSON.stringify(nextSnapshot))` |
| 7 | `authority/index.ts:179`（远程快照应用，缺口 2 钩子重构后） | `applySnapshot(host.data, nextSnapshot)` | `host.applyRemote(nextSnapshot)`，方法内部执行 `dataRef.current = JSON.parse(JSON.stringify(nextSnapshot))` |

### 7.3 错误传播策略

#### 同步路径下 `JSON.stringify(getValue())` 抛错

`getValue()` 同步返回不可序列化值（function / BigInt / 循环引用）→ `JSON.stringify` 抛错 → 包装为 `LockDisposedError(cause=原错)` 同步抛出，`lockData()` 调用栈直接抛错。Entry **从未被构造**，零资源泄漏。

#### 异步路径下 `JSON.stringify(awaited)` 抛错

`getValue()` 返回 Promise resolve 出不可序列化值 → 在 `await` 后立即 `JSON.stringify` 抛错 → 包装为 `LockDisposedError`，`dataReadyPromise` reject，整个 `lockData()` 返回的 Promise reject 出去。

新方向下「Entry 构造延迟到 resolve 之后」，所以 JSON 失败时 Entry 同样**从未被构造**，零资源泄漏。

#### commit / snapshot / authority 路径下抛错

commit 期间 `JSON.stringify(dataRef.current)` 抛错（用户在 update recipe 内部往 draft 写入了不可序列化值）—— **不应该发生**：draft 层（`core/draft.ts:168/180/190/210`）已经在写入路径做了 JSON-safe 校验，违规值在写入时就被拒绝。如果仍然抛错，按 commit 失败处理（rollback + logger.error）。

### 7.4 与现有 `adapters.clone` 的对比

| 维度 | 旧 `adapters.clone` 默认实现 | 新 `JSON.parse(JSON.stringify(...))` |
| --- | --- | --- |
| Map / Set / Date / TypedArray | ✅ 保留（`structuredClone` 路径） | ❌ 全部丢失或转字符串 |
| function / Symbol / BigInt | ⚠️ 可能 throw DataCloneError，降级 JSON | ❌ JSON.stringify 抛错（fail-fast） |
| 循环引用 | ✅ 保留（structuredClone）| ❌ JSON.stringify 抛错（fail-fast） |
| 性能 | 优于 JSON（单次原生调用） | 较慢（序列化 + 解析） |
| 用户可注入 | ✅（`adapters.clone`） | ❌ 完全删除 |
| 拷贝失败时降级 | 多级降级（structuredClone → JSON → 原值 + warn） | 直接抛错，无降级 |

**核心权衡**：放弃对 Map / Set / Date / TypedArray 的支持，换取语义最简单、最可预测的拷贝模型 + 早期 fail-fast。这是用户决策 Q（解读 B + 严格 JSON）的必然结果。

### 7.5 用户面影响

| 用户原本可用的数据形态 | 新 API 下的结果 |
| --- | --- |
| `{ count: 0, list: [1, 2] }`（plain object） | ✅ 完全支持 |
| `{ created: new Date() }` | ⚠️ Date 被转字符串（`'2025-...'`），用户拿到的是 string 不是 Date |
| `{ tags: new Set(['a', 'b']) }` | ⚠️ Set 被转 `{}`（空对象，`JSON.stringify(new Set())` 输出 `'{}'`），数据丢失 |
| `{ items: new Map() }` | ⚠️ Map 同上，数据丢失 |
| `{ buffer: new Uint8Array([1, 2, 3]) }` | ⚠️ TypedArray 被转 `{ '0': 1, '1': 2, '2': 3 }`（普通对象） |
| `{ fn: () => {} }` | ❌ JSON.stringify 抛错 → fail-fast LockDisposedError |
| `{ a: { b: a } }`（循环引用） | ❌ JSON.stringify 抛 TypeError → fail-fast LockDisposedError |

数据形态约定：**用户必须保证数据是 JSON-safe 的**（plain object / array / string / number / boolean / null）。这条约定与 `core/draft.ts` 现有 JSON-safe 校验（line 168/180/190/210）保持一致 —— **整个 lock-data 模块对外的数据语义全部收窄为 JSON-safe**。

---

## 8. 改动文件矩阵

### 8.1 源码改动

| # | 文件 | 改动类型 | 关键改动（含实测行号） |
| --- | --- | --- | --- |
| 1 | `src/shared/lock-data/types.ts` | 类型 | (a) `LockDataOptions<T>::getValue` 由可选改必传（line 216）；(b) 新增 `LockDataValueShape<T> = T extends unknown[] ? never : T`；(c) `LockDataActions<T>::read: () => T`（line 263）改名为 `snapshot: () => T`；(d) 删除 `type CloneFn`（line 188）；(e) 删除 `LockDataAdapters::clone?`（line 203）；(f) Entry 字段 `data: T` 改为 `dataRef: { current: T }`；(g) 删除类型导出 `CloneFn`（line 326） |
| 2 | `src/shared/lock-data/index.ts` | 公开 API | (a) 删除 3 个具名重载（line 43-50 / 52-56 / 58-62）+ 实现签名（line 66-77）；(b) 重写为单签名 `lockData<T extends object, O extends LockDataOptions<T>>(options: O): /* 条件类型推断 */`；(c) 删除 `CloneFn` 公开导出（line 96） |
| 3 | `src/shared/lock-data/core/entry.ts::lockData` | 实现签名 | line 364-389：从 `(initial: T \| undefined, options?: LockDataOptions<T>)` 改为 `(options: LockDataOptions<T>)`；新增运行时顶层数组 fail-fast（同步路径 + 异步 await 后双重校验，抛 InvalidOptionsError） |
| 4 | `src/shared/lock-data/core/entry.ts::createEntryFactory` | 内部签名 | line 277：删除 `initial: T \| undefined` 闭包参数；line 293 `resolveInitialData(...)` 调用同步删除 `initial` 实参；line 312 `mutableEntry.data: initialPatch.data` 改为 `mutableEntry.dataRef: { current: initialPatch.data }` |
| 5 | `src/shared/lock-data/core/entry.ts::attachAuthority deps 注入` | 注入修改 | line 225 `clone: adapters.clone` 删除；line 226 `applySnapshot: applyInPlace` 整行删除（缺口 2 钩子重构后 deps 不再有 applySnapshot 字段）；host 字段同步：`host: mutableEntry` 不变，但 mutableEntry 需要新增 `applyRemote: (next) => { mutableEntry.dataRef.current = JSON.parse(JSON.stringify(next)); }` 字段（详见 §14.1.5 / §14.2.4） |
| 6 | `src/shared/lock-data/core/entry.ts:383` | view 构造 | `createReadonlyView(entry.data)` 改为 `createReadonlyView(entry.dataRef)` |
| 7 | `src/shared/lock-data/core/registry.ts::resolveInitialData` | 重写 | line 427-466：签名收紧为 `(id, options, logger, onStateChange) => InitialDataPatch<T>`；删除 `initial` 入参；删除"无 getValue → resolveSyncFallback"分支；同步抛错路径改为 `throw createFailedInitError(id, error)`（不再返回 patch） |
| 8 | `src/shared/lock-data/core/registry.ts::resolveSyncFallback` | 删除 | line 470-481；getValue 必传后无调用方 |
| 9 | `src/shared/lock-data/core/registry.ts::resolvePendingPlaceholder` | 删除 | line 488-494；新方向不再有占位概念 |
| 10 | `src/shared/lock-data/core/registry.ts::buildFailedInitialData` | 删除 | line 493-516；同步抛错改为 `throw createFailedInitError(...)`，异步 reject 走 `buildPendingInitialData` 简化版 |
| 11 | `src/shared/lock-data/core/registry.ts::buildPendingInitialData` | 重写 + 简化 | line 515-553：签名 `(logger, source, onStateChange) => InitialDataPatch<T>`；删除 `initial` 入参；不再走"占位 + applyInPlace 覆写"，改为"resolve 后直接 dataRef.current = JSON.parse(JSON.stringify(awaited))" —— 但因为 Entry 构造延迟到 resolve 后，此函数实际可被简化整合到主入口 |
| 12 | `src/shared/lock-data/core/registry.ts::applyInPlace` | 迁出 | line 381-409：从 `core/registry.ts` 迁出到 `core/actions.ts` 内部（不再 export）；用法 1（authority applySnapshot 钩子，缺口 2 后整体改为 host.applyRemote 方法）+ 用法 2（异步占位）废弃，仅保留用法 3（actions.replace 内部 mutation 翻译） |
| 13 | `src/shared/lock-data/core/registry.ts::createFailedInitError` | 保留 | line 562-572：仍被 actions.ts 调用（commit 链路 dataReadyState='failed' 时 reject 用） |
| 14 | `src/shared/lock-data/core/registry.ts:582 export` | 调整 | 移除 `applyInPlace` export（已迁出）；其他保留 |
| 15 | `src/shared/lock-data/core/actions.ts:39` | import 调整 | `import { applyInPlace, createFailedInitError, type Entry } from './registry'` 改为 `import { createFailedInitError, type Entry } from './registry'` + 内部本地实现 `applyInPlace` |
| 16 | `src/shared/lock-data/core/actions.ts:534` | draft session base | `createDraftSession(entry.data)` 改为 `createDraftSession(JSON.parse(JSON.stringify(entry.dataRef.current)))` —— 事务期间 dataRef.current 变化不影响 draft |
| 17 | `src/shared/lock-data/core/actions.ts:581` | commit 快照 | `entry.adapters.clone(entry.data)` 改为 `JSON.parse(JSON.stringify(entry.dataRef.current))` |
| 18 | `src/shared/lock-data/core/actions.ts:743` | replace 实现 | `applyInPlace(draft, next as T)` 保持不变（用法 3，本地实现） |
| 19 | `src/shared/lock-data/core/actions.ts::read` | 删除 + 改名 | line 752-755：`read(): T { ensureAlive(); return deps.entry.adapters.clone(deps.entry.data); }` 删除整个方法；新增 `snapshot(): T { ensureAlive(); return JSON.parse(JSON.stringify(deps.entry.dataRef.current)) as T; }` |
| 20 | `src/shared/lock-data/core/actions.ts` 全文 | 字段访问 | 所有 `entry.data` 改为 `entry.dataRef.current`（实测涉及 line 397/399/534/581/753 等处） |
| 21 | `src/shared/lock-data/core/readonly-view.ts` | 完全重写 | 入参由 `target: T` 改为 `dataRef: { current: T }`；handler 全 trap（get / has / ownKeys / getOwnPropertyDescriptor / getPrototypeOf）重定向到 `dataRef.current`；写 trap 保持 rejectMutation；子对象 view 走传统 target-based Proxy（§4.4） |
| 22 | `src/shared/lock-data/authority/index.ts:53` | host 契约（缺口 2 重构） | `data: T` 字段整行删除；新增 `readonly applyRemote: (next: T) => void;` |
| 23 | `src/shared/lock-data/authority/index.ts:88` | deps 字段（缺口 2 重构） | `readonly applySnapshot: (data: T, nextSnapshot: T) => void;` 整行删除（钩子从 deps 移除，逻辑下沉到 `host.applyRemote`） |
| 24 | `src/shared/lock-data/authority/index.ts:166` | deps 解构 | `const { host, logger, clone, applySnapshot, emitSync } = deps;` 改为 `const { host, logger, emitSync } = deps;`（删除 `clone` + `applySnapshot`） |
| 25 | `src/shared/lock-data/authority/index.ts:179` | 调用点（缺口 2 重构） | `applySnapshot(host.data, nextSnapshot);` 改为 `host.applyRemote(nextSnapshot);` |
| 26 | `src/shared/lock-data/authority/index.ts:188` | emitSync 二次拷贝 | `emitSync({ ..., snapshot: clone(nextSnapshot) })` 改为 `emitSync({ ..., snapshot: JSON.parse(JSON.stringify(nextSnapshot)) })` |
| 27 | `src/shared/lock-data/authority/index.ts` 全文 | 字段访问 | 全文不再有 `host.data` 读取（缺口 2 后 host 不暴露 data 字段，只暴露 applyRemote 方法）；commit 路径下 authority 不读取 data，改由调用方在 `onCommitSuccess.event.snapshot` 显式传入快照 |
| 28 | `src/shared/lock-data/adapters/clone.ts` | 删除 | 整个文件删除（`createSafeCloneFn` / `hasStructuredClone` / `jsonClone` 全部消失） |
| 29 | `src/shared/lock-data/adapters/index.ts` | 调整 | line 27 `CloneFn` import 删除；line 34 `import { createSafeCloneFn } from './clone'` 删除；line 48 `readonly clone: CloneFn` 字段删除；line 77 `const clone: CloneFn = user.clone \|\| createSafeCloneFn(logger)` 整段删除 |

### 8.2 文档改动

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `RFC.md` L52 | `actions.read()` 改为 `actions.snapshot()` |
| 2 | `RFC.md` L82-200（## API 设计） | 重写：单签名 + LockDataOptions getValue 必传 + 顶层数组禁止说明 |
| 3 | `RFC.md` L141 | 删除「`initial` 与 `getValue` 优先级」段落（不再有 initial 概念） |
| 4 | `RFC.md:232` | 注释「getValue 返回 Promise 且 `entry.dataReadyState !== 'ready'`」适配新契约（详见 §12.8 #18，与本条合并实施） |
| 5 | `RFC.md` L352 | 错误类型表新增「顶层数组 → InvalidOptionsError」条目 |
| 6 | `RFC.md` L374 | 异步初始化示例改为新 API 形态 |
| 7 | `RFC.md` L450 | 「同进程同 id 自动共享数据」段落 entry.data 全部改 entry.dataRef |
| 8 | `RFC.md` L467 | 「跨进程数据同步」storage-authority 流程改为「getValue 必传 + 缺口 2 钩子重构：authority 通过 `host.applyRemote(next)` 方法把远程快照下发到宿主，宿主内部执行 `dataRef.current = JSON.parse(JSON.stringify(next))`」 |
| 9 | `RFC.md` L640-682 | InstanceRegistry / dataReadyState 段落重写：删除「占位 {} + warn」描述；说明「entry.dataRef 引用稳定 + entry.dataRef.current 跟随重新赋值」 |
| 10 | `RFC.md` L664 | 删除「首次注册 data === undefined → 占位 {} + warn」 |
| 11 | `RFC.md` L955+ | Actions 实现要点：getValue 异步期间的抢锁段落改为「Entry 构造延迟到 dataReadyPromise resolve 之后」 |
| 12 | `RFC.md` L1225 | storage-authority 首次初始化流程同步重写 |
| 13 | `RFC.md` 新增章节：## actions.snapshot() | 说明用途 / 与 view 的关系 / 与 structuredClone 限制的关系 |
| 14 | `RFC.md` 新增章节：## 顶层数组禁止 | 说明类型层 + 运行时双重拦截 |
| 15 | `RFC.md` 新增章节：## readonly view 的引用稳定契约 | 说明 view 引用稳定但 dataRef.current 变化；`Object.isFrozen(view)` 不可靠 |
| 16 | `IMPLEMENTATION.md` 7.x 章节 | 追加重构条目（API 收敛 + getValue 必传 + wrapper Proxy + JSON 拷贝隔离 + 顶层数组禁止 + read 改 snapshot + adapters.clone 废弃） |
| 17 | `.changeset/<auto>.md` | 创建 major bump changeset：完整 breaking change 描述 |

### 8.3 测试改动

| # | 文件 | 调用数 | 改动 |
| --- | --- | --- | --- |
| 1 | `__test__/core/entry.browser.test.ts` | 19 处 `lockData()` | 全部从 `lockData(initial, options)` 改为 `lockData({ getValue: () => initial, ...options })` |
| 2 | `__test__/core/entry-standalone-driver-isolation.node.test.ts` | 7 处 `lockData()` | 同上 |
| 3 | `__test__/integration/entry.node.test.ts` | 1 处 `lockData()` | 同上 |
| 4 | `__test__/core/entry-standalone-driver-isolation.browser.test.ts` | 1 处 `lockData()` | 同上 |
| 5 | `__test__/_helpers/memory-adapters.ts` | 1 处 `lockData()` | 同上 |
| 6 | `__test__/core/actions.browser.test.ts` | 4 处 `actions.read()`（line 418/744/753/754） | 全部改名为 `actions.snapshot()` |
| 7 | `__test__/core/registry.node.test.ts` | 10 处 `resolveInitialData()` | (a) 补 `'test-id'` 实参；(b) 删除"`initial===undefined` 占位 `{}` + warn"用例；(c) 改写"getValue 同步抛错走 failed 分支（返回 patch）"用例 → 改为"`getValue` 同步抛错 → 同步抛 `LockDisposedError(cause=原错)`" |
| 8 | `__test__/core/registry.node.test.ts` 新增用例 | — | (a) 顶层数组运行时拒绝（`Array.isArray(awaited)` fail-fast）；(b) JSON.stringify 失败的 fail-fast；(c) wrapper Proxy 的引用稳定性（dataRef.current 切换后 view 跟随）|
| 9 | `__test__/core/registry-async-initial-required.node.test.ts` | 整个文件 | 删除（之前 fail-fast 修复时创建，方向已废） |
| 10 | `__test__/adapters/` 全部 | — | `adapters.clone` 注入用例全部删除（`adapters.read` / `authority.read` 等 adapter 自身的 read 字段无关，保留） |

### 8.4 不在本次范围内

- `core/draft.ts`：零改动（draft session 持有 base 拷贝，不再依赖 entry.data 引用）
- `core/fanout.ts`：零改动
- `drivers/` 全部模块：零改动
- `errors/` 全部模块：零改动

### 8.5 commit 策略

**单 commit + major bump**（用户决策 Q6 完全 breaking）：

- 全部改动作为单一 commit 提交，commit message 用中文（按用户偏好）
- 由 changeset 驱动 major version bump（不留兼容层、不分阶段发版）
- changeset 文件描述全部 breaking change：
  1. `lockData()` 签名从双参数 `(initial, options)` 改为单参数 `(options)`
  2. `getValue` 由可选改为必传字段
  3. `actions.read()` 改名为 `actions.snapshot()`
  4. `adapters.clone` 适配器删除（用户不再可注入自定义 clone 实现）
  5. 顶层数组禁止（`lockData<T[]>(...)` 编译期 + 运行时双重拒绝）
  6. `entry.data` 字段重命名为 `entry.dataRef.current`（用户面影响：直接读 entry 内部字段的代码失效，但这本就不是公开 API）
  7. 数据形态收窄为 JSON-safe（Map / Set / Date / TypedArray 不再支持）
  8. `Object.isFrozen(view)` 返回 false 但 view 仍为只读（语义瑕疵，文字说明）

---

## 9. 实测前置确认清单（已逐项实测）

| # | 项 | 实测结果 |
| --- | --- | --- |
| 1 | `LockDataOptions<T>::getValue` 当前是否可选 | ✅ 可选 —— `types.ts:216` `getValue?: () => T \| Promise<T>`；新 API 改必传 |
| 2 | `LockDataActions<T>::read` 当前签名 | ✅ 实测 `types.ts:263` `read: () => T`；新 API 删除改名为 `snapshot: () => T` |
| 3 | `index.ts` 公开重载是否完全收敛为单签名 | ❌ 当前 **3 重载 + 1 实现签名**（line 43-50 / 52-56 / 58-62 / 66-77）；新 API 收敛为 1 签名 + 严格条件类型 |
| 4 | `lockData<T>(options)` 实现签名能否用条件类型自动推断返回 | ✅ 可行 —— `O extends { syncMode: 'storage-authority' } ? Promise<...> : ReturnType<O['getValue']> extends Promise<unknown> ? Promise<...> : LockDataTuple<T>` 三层条件已覆盖 |
| 5 | `createEntryFactory` 移除 `initial` 入参后调用方适配 | ✅ 仅 1 处调用：`core/entry.ts:370 const factory = createEntryFactory<T>(initial)`；新 API 同步去掉实参 |
| 6 | `__test__/` 全量 `lockData(` 调用数 | ✅ 实测 **29 处**，分布 5 文件：`core/entry.browser.test.ts` 19、`core/entry-standalone-driver-isolation.node.test.ts` 7、`integration/entry.node.test.ts` 1、`core/entry-standalone-driver-isolation.browser.test.ts` 1、`_helpers/memory-adapters.ts` 1 |
| 7 | `__test__/` 全量 `actions.read(` 调用数 | ✅ 实测 **4 处**，全部在 `__test__/core/actions.browser.test.ts`（line 418 / 744 / 753 / 754）；其他测试文件 `read()` 调用是 adapter 自身的 read（authority / sessionStore），与 actions 无关 |
| 8 | `entry.data` 现有所有读取点 | ✅ 实测 7 处：`actions.ts:534`（draft session 入参）、`actions.ts:581`（commit clone 快照）、`actions.ts:753`（read 返回的 clone）、`entry.ts:383`（createReadonlyView）、`entry.ts:312`（mutableEntry.data 构造期赋值）；authority `host.data:53` 字段定义 + `applySnapshot(host.data, ...)` 唯一调用点 line 179（缺口 2 后 authority 端不再读 host.data，改为 host.applyRemote 方法主动下发 next） |
| 9 | `entry.data` 现有所有写入点 | ✅ 实测 **0 处重新赋值** + N 处原地覆写（applyInPlace）；RFC 引用稳定契约严格遵守 |
| 10 | `entry.data === undefined`（pending 阶段）对 commit 链路的影响 | ✅ 安全 —— `core/actions.ts:387 ensureDataReady` → 397 `if (entry.dataReadyState === 'pending' && entry.dataReadyPromise !== null) await entry.dataReadyPromise`；commit 访问 entry.data 前必先 await dataReadyPromise；新方向下「Entry 构造延迟到 resolve 后」自然消解此问题 |
| 11 | `entry.data === undefined` 时 `readonly view` Proxy 行为 | ✅ 自然抛 TypeError —— `core/readonly-view.ts:99 new Proxy(target, READONLY_HANDLER)` 原生要求 target 必须是 object；新方向下用户必须 `await lockData(...)` 才能拿到 view，pending 期间 view 还未构造 |
| 12 | **同 Tab** 二次 lockData 调用在首次 `getValue` 还未 resolve 时命中（订正：原描述「跨 Tab 副本」是错的，跨 Tab 不共享 InstanceRegistry，详见 §14.3 缺口 5） | ✅ 共享 dataReadyPromise —— `core/registry.ts:10` 注释 `dataReadyPromise 共享：getValue 返回 Promise 时，同 id 多实例共享同一个就绪 Promise`；二次调用方通过 `getOrCreateEntry` 命中已存在 Entry，refCount++，复用 `entry.dataReadyPromise`；resolve 后所有同 Tab 调用方拿到同一 dataRef 引用 |
| 13 | `lockData()` 同步签名能否在 `getValue: () => T`（同步返回）时同步返回元组 | ✅ 可行 —— `core/entry.ts:469 if (entry.dataReadyPromise === null) return [view, actions]` 已支持"data 同步就绪"的同步返回路径；新 API `getValue` 同步返回值时复用此分支 |
| 14 | `LockDataOptions<T>::getValue` 是否被其他模块使用（除 `resolveInitialData` 外） | ✅ 实测仅 `core/registry.ts::resolveInitialData` 内部消费；`core/actions.ts` 不直接读 `getValue`（commit 路径走 `entry.data` 而非重新调用 `getValue`）；新 API 改必传不影响其他模块 |
| 15 | `adapters.clone` 默认实现 | ✅ 实测 `adapters/clone.ts::createSafeCloneFn` 三级降级：`structuredClone` → `JSON.parse(JSON.stringify(...))` → 返回原值 + warn；新方向下整个文件删除，全部走 JSON |
| 16 | `adapters.clone` 全仓调用点 | ✅ 实测 4 处生产代码：`actions.ts:581` / `actions.ts:753` / `entry.ts:225 attachAuthority deps` / `authority/index.ts:188 emitSync`；全部改 JSON |
| 17 | wrapper Proxy 的 invariant 风险 | ✅ 实测脚本 `/tmp/proxy-invariant-probe/probe.mjs` 完成 10 个场景验证；§4.3 表格记录全部通过项 + 致命项 + 可接受瑕疵 |
| 18 | 顶层数组在 wrapper 方案下是否能工作 | ❌ `JSON.stringify(view) on array` / `Object.keys(view) on array` 抛 length invariant TypeError；`Array.isArray(view)` 永远 false；必须禁止（§5） |
| 19 | 冻结对象作为 dataRef.current 时的 invariant 风险 | ❌ `Object.keys(view)` / `getOwnPropertyDescriptor(view, key)` 抛 invariant TypeError；§7 JSON 拷贝隔离消解（拷贝出的对象一定不是 frozen） |
| 20 | `structuredClone(view)` 行为 | ❌ DOMException —— Web 标准对 Proxy 的硬限制，无解；§6 `actions.snapshot()` 替代 |
| 21 | `Object.isFrozen(view)` | ⚠️ 永远 false（wrapper 不是 frozen），但 view 写入仍被 trap 拒绝；RFC 文字说明 |
| 22 | `applyInPlace` 全部使用点 | ✅ 实测 4 处：`entry.ts:226 applySnapshot:applyInPlace`（用法 1，缺口 2 后整行删除：deps 不再有 applySnapshot 字段，远程同步改走 host.applyRemote 方法）、`registry.ts:526 applyInPlace(data, next)`（用法 2，废弃）、`actions.ts:743 applyInPlace(draft, next)`（用法 3，保留）、`registry.ts:582 export`（迁出后取消）|
| 23 | `package.json` 当前版本（major bump 评估） | ✅ `0.6.0` —— pre-1.0 阶段做完全 breaking 成本最低 |
| 24 | `core/draft.ts` JSON-safe 校验是否覆盖 `actions.replace(next)` 的 `next` | ✅ `draft.ts:168/180/190/210` 已覆盖；新 API 不需要在 replace 入口额外校验 |

---

## 10. 关键设计点

### 10.1 API 简化的真实收益

3 重载 → 1 签名，5 分支 → 2 分支（同步 / 异步），用户心智负担显著下降。但**这只是表面收益**。

更重要的内部收益：

- 「`initial` vs `getValue` 优先级」彻底消失：用户不需要读 RFC L141 才能正确使用
- `entry.data` 引用稳定契约的虚假承诺被废弃：契约对齐到真实的"用户面 view 引用稳定"，内部数据引用变化不暴露给用户
- 占位机制（`{}` + applyInPlace）从 4 个函数（resolveSyncFallback / resolvePendingPlaceholder / buildFailedInitialData / buildPendingInitialData）简化到 0
- 跨「外部 ↔ Entry」边界的拷贝策略统一为 JSON.stringify，消除 structuredClone / JSON / 用户注入 clone 的多路径复杂度

### 10.2 「本地缓存 + 远程覆盖」用法消失的细节

旧 API 看似支持的用法：

```ts
const localCache: User = JSON.parse(localStorage.getItem('user-cache') ?? '{}');
const result = lockData<User>(localCache, { getValue: () => fetch('/api/user') });
```

实测旧 API 的真实行为：

- 调用时立刻构造 Entry，`entry.data = localCache`，`dataReadyState='pending'`
- 但用户拿到的是 `Promise<LockDataTuple<User>>`，必须 await 才能拿到 view
- 内部模块（authority init / fanout）在 pending 期间能读到 entry.data 的内容（localCache），但**这不是 RFC 显式承诺的契约**
- 用户**自己**拿不到 view，"先显示缓存再覆盖"功能根本**不能通过 lockData 实现**
- fetch reject 时 `dataReadyState='failed'`，用户拿到的 Promise reject，根本拿不到 localCache —— **旧 API 的"伪兜底"从未真正工作过**

新 API 下用户应该这样写（fallback 显式化）：

```ts
const result = await lockData<User>({
  getValue: async () => {
    try {
      return await fetch('/api/user').then(r => r.json());
    } catch {
      return JSON.parse(localStorage.getItem('user-cache') ?? '{"id": 0, "name": "Guest"}');
    }
  },
});
```

**真正失去的能力是无的**（旧 API 也没真正实现）；**失去的"假象"是"传 initial 看起来是 fallback"的语法甜头**。新 API 把 fallback 逻辑明确归给 `getValue`，消除了语义陷阱。

### 10.3 `data` 引用稳定的语义重定位

| 层次 | 旧契约 | 新契约 |
| --- | --- | --- |
| 用户面 view 引用 | 不稳定（异步路径下 await 后才能拿到，但拿到后就稳定） | **稳定**（lockData 返回的 view 引用永不变更） |
| 内部 entry.data 引用 | **稳定**（永不重新赋值，只 applyInPlace 原地覆写） | 不稳定 —— `entry.dataRef.current` 每次 commit / init resolve / `host.applyRemote` 都重新赋值 |
| 内部 entry.dataRef 引用 | n/a（不存在 wrapper） | **稳定**（构造后永不变更） |
| view 看到的字段值 | 跟随 applyInPlace 变化（同步可见） | 跟随 dataRef.current 重新赋值变化（同步可见） |

**用户面的引用稳定性反而增强了**：旧契约下用户必须 await 才能拿到稳定 view，新契约下 lockData 主入口同步路径直接返回稳定 view，异步路径返回的 Promise resolve 出稳定 view。

### 10.4 wrapper Proxy 的 invariant 缝合

wrapper 方案的设计本质是「**把 Proxy 的 target 与"实际数据"解耦**」：

- target 是 wrapper `{ current: T }`，地址全程稳定 → Proxy 引用全程稳定
- handler 全部 trap 重定向到 `dataRef.current` → 数据跟随重新赋值变化

但 Proxy invariant 强制要求 target 自身满足某些约束：
- `Array.isArray(proxy)` 看 target 内部 `[[Class]]` 标记 → wrapper 不是数组，永远 false → §5 禁止顶层数组消解
- 数组 `length` 字段的 non-configurable invariant → wrapper 上没有 length → 同上消解
- 冻结字段 invariant 要求 target 上字段也 non-configurable → §7 JSON 拷贝隔离消解（拷贝出的对象一定不是 frozen）
- `structuredClone` 不识别 Proxy → §6 `actions.snapshot()` 替代

**三大补丁分别消解一类风险**，不留死角。

### 10.5 JSON-safe 数据约定的传染性

新方向下，整个 lock-data 模块对外的数据语义全部收窄为 JSON-safe：

- 初始化（`getValue`）：必须返回 JSON-safe 数据 —— `JSON.stringify` 抛错 → fail-fast `LockDisposedError`
- 写入（`actions.update` recipe / `actions.replace`）：必须写入 JSON-safe 值 —— draft 层（line 168/180/190/210）拒绝违规写入
- 读取（`view` / `actions.snapshot()`）：返回的也是 JSON-safe 数据
- 跨 Tab 同步（authority / channel）：序列化走 JSON.stringify，反序列化走 JSON.parse

整个数据流在每一个边界都强制 JSON-safe，**违规值无法在任何路径下进入 entry.dataRef.current**。这是一个非常干净的边界条件 —— 用户拿到的数据形态完全可预测。

### 10.6 breaking change 的成本评估

`package.json` 当前版本 0.6.0（pre-1.0 阶段），用户体量小：

- 0.x 版本本就允许 breaking minor bump（semver 约定）
- 本次重构虽是 major bump（changeset 驱动），但 pre-1.0 阶段的迁移成本远低于 1.x 之后
- 不保留兼容层、不留 deprecated 别名 —— 一次性切换到新 API，避免长期维护双套

### 10.7 `applyInPlace` 函数的最终定位

旧定位：「为了维护 entry.data 引用稳定的工具」 —— 错误理解。

新定位：「**在保持 target 引用不变的前提下，让 target 的所有自有属性 / 数组项与 source 完全一致**」。它有两个独立用途：

1. **事务层的"整体替换 → 逐项 mutation"翻译器**（用法 3：`actions.replace(next)` 内部 `applyInPlace(draft, next)`）—— 通过对 draft Proxy 做逐项操作，触发 Proxy trap，让 draft session 把这些操作记录为 mutations 数组
2. ~~**维护引用稳定的"原地覆写"工具**（用法 1、2）~~ —— 新方向下废弃

用法 3 与「entry.data 引用稳定」无关，**无法被 wrapper 直接赋值替代**（draft 层依赖逐项 mutation 翻译，整体赋值会让 mutations 数组为空，commit 退化为无操作）。

---

## 11. 不做的事

### 11.1 不保留 `data` 字段做语法糖

```ts
// ❌ 不做：保留 data 与 getValue 互斥
lockData({ data: { count: 0 } });             // 语法糖
lockData({ getValue: () => ({ count: 0 }) }); // 完整形态
```

理由：又回到了"两条数据来源"的复杂度，违反"减少分支"目标。同步常量场景多写 12 字符（`{ getValue: () => value }`）是可接受的代价。

### 11.2 不提供 `constant<T>(value: T): () => T` 工具函数

```ts
// ❌ 不做：在 shared/utils 增加 constant 工具
import { constant } from '@cmtlyt/lingshu-toolkit';
lockData({ getValue: constant({ count: 0 }) });
```

理由：用户多学一个 API 不偿失。原生写法 `getValue: () => ({ count: 0 })` 已经足够简洁。

### 11.3 不在 `syncMode='storage-authority'` 路径下让 `getValue` 仅作为 fallback

```ts
// ❌ 不做：storage 命中时跳过 getValue 执行
lockData({
  getValue: () => expensiveCompute(),
  syncMode: 'storage-authority',
  // 隐式语义：storage 拉到 → getValue 不执行
});
```

理由：违反"`getValue` 职责唯一"原则 —— 让它在不同 syncMode 下语义不一致（一会儿是"初始数据来源"，一会儿是"storage 拉不到的 fallback"）。`getValue` 的计算代价应由用户在内部决策（lazy 求值、缓存判定），不是由 lockData 通过隐式条件跳过。

### 11.4 不提供 deprecated 兼容层

理由：0.6.0 阶段 breaking 成本最低，兼容层增加维护负担。changeset 描述完整列举 breaking change 即可，用户按 changelog 迁移。

### 11.5 不保留 `actions.read()` 别名

```ts
// ❌ 不做：read 作为 snapshot 别名
const actions = { snapshot, read: snapshot };
```

理由：用户决策 Q（read vs snapshot）= B 「彻底 breaking，一个动作一个名字」。

### 11.6 不保留 `adapters.clone` 用户注入接口

```ts
// ❌ 不做：保留 adapters.clone 让用户注入 lodash.cloneDeep / structuredClone 等
lockData({
  getValue: () => ({...}),
  adapters: { clone: lodashCloneDeep },
});
```

理由：用户决策"删除全部，统一走 JSON" —— 整个 lock-data 模块的数据语义全部收窄为 JSON-safe（§10.5），保留用户注入会破坏边界一致性。

### 11.7 不在 view 上实现真正的 `Object.isFrozen(view) === true`

```ts
// ❌ 不做：在 wrapper 上 Object.freeze 让 isFrozen 返回 true
const dataRef = Object.freeze({ current: ... });  // ⚠️ 这会让 wrapper.current 不可重新赋值
```

理由：wrapper 必须支持 `dataRef.current` 重新赋值（commit / `host.applyRemote`），不能 freeze。`Object.isFrozen(view) === false` 这个语义瑕疵接受 RFC 文字说明的处理方式（用户决策已锁定）。

### 11.8 不支持顶层数组（哪怕是绕过类型层用 `as any`）

```ts
// ❌ 编译期错误（类型层 T extends unknown[] ? never : T 排除）
lockData<number[]>({ getValue: () => [1, 2, 3] });

// ❌ 运行时也会被拒绝（fail-fast Array.isArray 校验）
lockData({ getValue: () => [1, 2, 3] as any });
```

理由：wrapper Proxy 方案下顶层数组的 `JSON.stringify` / `Object.keys` / `Array.isArray` 全部抛 invariant TypeError 或返回错误结果（§4.3 实测）。无法绕过 Proxy invariant 强制约束。

### 11.9 不在 `actions.replace(next)` 入口额外做 JSON 校验

理由：`core/draft.ts` 已经在写入路径覆盖 JSON-safe 校验（line 168/180/190/210）。`replace(next)` 通过 `applyInPlace(draft, next)` 触发 draft Proxy trap，trap 内部的现有校验已经覆盖。新增校验是冗余。

### 11.10 不在 commit 路径做 fail-fast 校验

```ts
// ❌ 不做：commit 期间 JSON.stringify 抛错时 fail-fast 整个模块
const snapshot = JSON.parse(JSON.stringify(entry.dataRef.current));
// 抛错 → throw LockDisposedError 让整个 entry 失效
```

理由：commit 期间不可序列化数据**不应该出现**（draft 层已经拦截）。如果仍然出现，按 commit 失败处理即可（rollback + logger.error），不需要让整个 entry 进入终态。

---

## 12. dataReadyState 状态机极简化（缺口 4 决策）

### 12.1 背景

实测 `core/registry.ts:34` 当前定义：

```ts
type DataReadyState = 'pending' | 'ready' | 'failed';
```

三态，不含 `'idle'` —— `'idle'` 是 `LockPhase`（`types.ts:40`）字段，与 dataReadyState 是两个独立状态机，本节不涉及。

新方向的两个根本性改变让此三态状态机失去存在意义：

1. **同步路径下 `getValue()` 抛错 → Entry 不构造**（§3 决策）：fail-fast 直接 throw `LockDisposedError`，调用栈传播，Entry 从未注册到 InstanceRegistry
2. **异步路径下 Entry 构造延迟到 `dataReadyPromise` resolve 之后**（§10.1 决策）：用户拿到的 `Promise<LockDataTuple>` resolve 时，Entry 已经处于 'ready' 态；resolve 失败时 Entry 同样从未构造

**仍然需要"等待就绪"的场景**（详见 §14.3 缺口 5 订正）：

1. **同 Tab 二次调用方命中已存在 Entry**：首次调用方的异步 `getValue()` 还没 resolve 时，Entry 被提前注册到 InstanceRegistry（refCount=1）；二次调用方 `lockData(sameOptions)` 命中此 Entry（refCount=2），必须等待 dataReadyPromise resolve
2. **`attachAuthority` 异步 init 完成等待**：`mergeReadyPromises(getValueReady, authorityReady)` 让 `await lockData(...)` 包含 authority.init() 的完成
3. **异步初始化期间 Entry 提前注册自身**：lockData 主入口 await 自己的 dataReadyPromise，resolve 后才把元组 `[view, actions]` 交付给调用方

### 12.2 决策：半极简方案（用户决策 Q1=D + Q2=A）

| 字段 | 旧 | 新 |
| --- | --- | --- |
| `dataReadyState: 'pending' \| 'ready' \| 'failed'` | 存在 | **删除** |
| `dataReadyPromise: Promise<void> \| null` | 存在 | **保留** |
| `dataReadyError: unknown` | 存在 | **删除** |
| `onStateChange` 闭包回调 | 存在（`createEntryFactory` 通过闭包回写状态） | **删除** |
| `DataReadyState` 类型 + 类型导出 | `core/registry.ts:34` 定义 + `core/registry.ts:574` 导出 | **删除** |

### 12.3 语义重定义

| 场景 | Entry 字段语义 |
| --- | --- |
| Entry 存在 | 数据**必然已就绪**（同步路径下立即就绪；异步路径下 resolve 后才构造）—— Entry 的存在本身成为就绪的证据 |
| `entry.dataReadyPromise === null` | 同步路径（`getValue: () => T`）下 Entry 构造瞬间已就绪；调用 actions 无需 await |
| `entry.dataReadyPromise !== null` | 异步路径（`getValue: () => Promise<T>`）下 Entry 提前注册（refCount=1）但 `dataRef.current` 仍为占位；`lockData()` 主入口与同 Tab 二次调用方 / authority.init 等待方均 await 此 Promise（详见 §14.3） |
| `entry.dataReadyPromise` reject | 异步初始化失败；所有 await 持有者一起拿到 reject，由 `ensureDataReady` 内部 catch 包装为 LockDisposedError |

### 12.4 代码影响：删除点（按文件分组，含实测行号）

#### 12.4.1 `core/registry.ts`

| # | 行号 | 删除内容 |
| --- | --- | --- |
| 1 | 34 | `type DataReadyState = 'pending' \| 'ready' \| 'failed'` 类型定义 |
| 2 | 104-106 | Entry 接口字段 `dataReadyState: DataReadyState` + `dataReadyError: unknown` |
| 3 | 356-365 | `InitialDataPatch` 接口字段 `readonly dataReadyState: DataReadyState` + `readonly dataReadyError: unknown` —— 实测 line 351 注释 + line 355-356 字段定义；新方向下 `InitialDataPatch` 整体可简化为 `{ data: T; dataReadyPromise: Promise<void> \| null }` |
| 4 | 425、431 | `resolveInitialData` 函数体注释 + 入参签名 `onStateChange: (state: DataReadyState, error: unknown) => void` |
| 5 | 497、519 | `buildFailedInitialData` / `buildPendingInitialData` 入参签名 `onStateChange: (state: DataReadyState, error: unknown) => void`（这两个函数本身已在 §8.1 #10/#11 标记删除/重写，签名同步消失） |
| 6 | 438、454 | 同步路径返回值字段 `dataReadyState: 'ready', dataReadyError: undefined`（line 438 整段在 getValue 必传后随分支删除，§8.1 #7） |
| 7 | 510 | `buildFailedInitialData` 返回值字段 `dataReadyState: 'failed'`（函数本身已删除） |
| 8 | 527、532、537 | `buildPendingInitialData` 内部 `onStateChange('ready'/'failed', ...)` 三处调用（函数本身已删除） |
| 9 | 545 | `buildPendingInitialData` 返回值字段 `dataReadyState: 'pending'`（函数本身已删除） |
| 10 | 555-560 | `createFailedInitError` 函数顶部注释中「`dataReadyError 字段成对出现` ... `避免契约漂移`」三行 —— 函数本身保留（仍被 Actions 层 catch 包装链路调用），但注释引用的字段已不存在，需改写为：「由 Actions 层在 `dataReadyPromise` reject 时调用，对外统一抛 LockDisposedError」 |
| 11 | 574 | `export type { DataReadyState, ... }` 中的 `DataReadyState` 移除 |

#### 12.4.2 `core/entry.ts`

| # | 行号 | 删除内容 |
| --- | --- | --- |
| 12 | 281-291 | `entryRef` 闭包变量 + `onStateChange` 闭包函数定义（含内联类型 `(state: 'pending' \| 'ready' \| 'failed', error: unknown) => void`）+ `entryRef = mutableEntry` 赋值；整段删除 |
| 13 | 293 | `resolveInitialData(options, initial, adapters.logger, onStateChange)` 调用参数表中的 `onStateChange` 实参（同时配合 §8.1 删除 `initial` 入参，签名整体改为 `resolveInitialData(id, options, adapters.logger)`） |
| 14 | 324-325 | `mutableEntry` 字面量初始化 `dataReadyState: initialPatch.dataReadyState, dataReadyError: initialPatch.dataReadyError`（连同字段一起删除） |
| 15 | 458-461 | `finalizeResult` 函数 JSDoc 注释「同步就绪 → 立即检查 `dataReadyState === 'failed'`...」改写为「同步就绪 → 立即返回元组（Entry 存在则数据必然就绪）」 |
| 16 | 469-475 | `finalizeResult` 同步路径的 `if (entry.dataReadyState === 'failed') { void actions.dispose(); throw createFailedInitError(entry.id, entry.dataReadyError); }` —— 整段删除：新方向下同步路径下 Entry 不存在 failed 态（同步抛错时 Entry 不构造，调用栈已直接抛错），同步路径只剩 `return tuple` |
| 17 | 479-487 | `finalizeResult` 异步路径 `entry.dataReadyPromise.then(_, (error) => ...)`：实测 line 484 已经使用 `error` 形参（不依赖 `dataReadyError` 字段），**逻辑保持不变**；仅 line 481-483 注释中「`authority.init 失败已被 attachAuthority 内部 warn + swallow`」沿用，无需改写 |

#### 12.4.3 `core/actions.ts::ensureDataReady`（实测 line 382-407）

| # | 行号 | 删除内容 |
| --- | --- | --- |
| 18 | 384-386 | JSDoc 三行注释 `* - dataReady 'failed' → reject LockDisposedError(cause=原因)` + `* - dataReady 'pending' → await dataReadyPromise（等待期不计入 acquireTimeout）` 改写为：`* - 数据未就绪（同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册场景）→ await dataReadyPromise；reject 时包装为 LockDisposedError` + `*   等待期不计入 acquireTimeout` |
| 19 | 392-394 | `if (entry.dataReadyState === 'failed') { throw createFailedInitError(entry.id, entry.dataReadyError); }` 整段（含闭合花括号）删除（failed 态由 dataReadyPromise reject 兜底） |
| 20 | 395-396 | 两行注释 `// Entry 契约：dataReadyState === 'pending' ↔ dataReadyPromise !== null（resolveInitialData 保证）` + `// 这里用显式 !== null 避开 \`Promise \| null\` 做布尔条件触发的 noMisusedPromises 告警` 删除（双字段同步不变量消失） |
| 21 | 397 | `if (entry.dataReadyState === 'pending' && entry.dataReadyPromise !== null)` 改为 `if (entry.dataReadyPromise !== null)` |

`ensureDataReady` 简化后完整形态（基于实测 line 384-407 改写）：

```ts
/**
 * 进入抢锁流程前的前置检查：
 * - disposed 终态 → reject LockDisposedError
 * - 数据未就绪（同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册场景）→ await dataReadyPromise；reject 时包装为 LockDisposedError
 *
 * 等待期不计入 acquireTimeout
 */
async function ensureDataReady<T extends object>(deps: ActionsDeps<T>, state: ActionsInternalState): Promise<void> {
  if (state.disposed) {
    throwDisposed();
  }
  const { entry } = deps;
  // entry.dataReadyPromise === null：主 Tab / 同步路径，数据已就绪，直接返回
  // entry.dataReadyPromise !== null：异步初始化未就绪场景（同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册），等待 getValue 与 authority.init 的合成 Promise resolve
  // dataReadyPromise reject 时（主 Tab 初始化失败）→ await 抛错 → catch 包装为 LockDisposedError
  if (entry.dataReadyPromise !== null) {
    try {
      await entry.dataReadyPromise;
    } catch (error) {
      throw createFailedInitError(entry.id, error);
    }
    if (state.disposed) {
      throwDisposed();
    }
  }
}
```

### 12.5 代码影响：保留点

| # | 位置 | 保留理由 |
| --- | --- | --- |
| 1 | `core/registry.ts::createFailedInitError`（line 562-572） | 仍被两处调用：(a) `core/entry.ts:486` `finalizeResult` 异步路径 await reject 包装；(b) `core/actions.ts::ensureDataReady` 异步初始化未就绪场景（同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册）等待失败包装。函数签名 `(id, cause) => Error` 不依赖被删除字段，无需改造（仅顶部注释改写，见 §12.4.1 #10） |
| 2 | `Entry::dataReadyPromise` 字段 | 异步初始化未就绪场景（详见 §14.3 缺口 5）的等待依据：同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册自身 |
| 3 | `core/entry.ts::mergeReadyPromises`（实测 line 254-264） | 异步路径仍需合成「getValue + authority.init」统一就绪 Promise，逻辑不变 |
| 4 | `InitialDataPatch::data` 字段 + `InitialDataPatch::dataReadyPromise` 字段 | 简化后 `InitialDataPatch` 形态收敛为 `{ data: T; dataReadyPromise: Promise<void> \| null }` |

### 12.6 错误传播链路对比（半极简方案）

| 触发点 | 旧链路（三字段） | 新链路（单字段） |
| --- | --- | --- |
| 主 Tab 同步 `getValue()` 抛错 | `resolveInitialData → buildFailedInitialData → onStateChange('failed', cause) → entry.dataReadyState='failed' + entry.dataReadyError=cause →`（Entry 已构造）`→ finalizeResult 检测 failed → throw LockDisposedError` | `resolveInitialData` 同步抛 `LockDisposedError`（包装为 `createFailedInitError(id, cause)`）→ `lockData()` 调用栈直接抛错（**Entry 不构造**） |
| 主 Tab 异步 `getValue()` reject | `source.then(_, reason => onStateChange('failed', reason))` → `entry.dataReadyState='failed' + dataReadyError=reason` →（Entry 已构造）→ `dataReadyPromise.reject` → `finalizeResult 异步分支 catch → throw LockDisposedError` | `source.then(awaited => 构造 Entry, reason => entryConstructPromise.reject(reason))` → `lockData()` 返回的 Promise reject（**Entry 不构造**） |
| 同 Tab 二次调用方命中后首次调用的异步初始化失败 | 二次调用方 `ensureDataReady` 读 `entry.dataReadyState === 'failed'` → 同步 throw（快路径） | 二次调用方 `ensureDataReady` `await entry.dataReadyPromise` → 抛错 → `catch (error) { throw createFailedInitError(entry.id, error); }` |

### 12.7 关键不变量（消除契约漂移）

旧契约：

```
dataReadyState === 'pending' ↔ dataReadyPromise !== null
dataReadyState === 'failed'  ↔ dataReadyError !== undefined && dataReadyPromise reject
dataReadyState === 'ready'   ↔ dataReadyPromise === null
```

三个不变量手工维护，一旦 `onStateChange` 漏写一处就破契约。

新契约：

```
dataReadyPromise === null   ↔ 数据已就绪（同步路径 / 异步路径已 resolve 后）
dataReadyPromise !== null   ↔ 异步初始化未就绪（同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册），settle 结果由 promise 自身决定
```

单字段，不变量天然成立 —— Q4 决策结论：注释「`dataReadyState === 'pending' ↔ dataReadyPromise !== null`」自动消失，无契约漂移风险。

### 12.8 改动文件矩阵（追加到 §8）

#### 源码改动（追加到 §8.1）

| # | 文件 | 改动 |
| --- | --- | --- |
| 30 | `src/shared/lock-data/core/registry.ts` | (a) 删除 `type DataReadyState`（line 34）；(b) 删除 Entry 接口字段 `dataReadyState` / `dataReadyError`（line 104-106）；(c) 简化 `InitialDataPatch` 为 `{ data: T; dataReadyPromise: Promise<void> \| null }`（删除 line 355-356 两个字段）；(d) 删除 `onStateChange` 入参（line 425/431/497/519）；(e) 改写 `createFailedInitError` 顶部注释（line 555-560）；(f) 移除类型导出 `DataReadyState`（line 574） |
| 31 | `src/shared/lock-data/core/entry.ts` | (a) 删除 `entryRef` 闭包变量 + `onStateChange` 闭包函数（line 281-291）；(b) 调整 `resolveInitialData` 调用，移除 `onStateChange` 实参（line 293）；(c) 删除 `mutableEntry` 字面量初始化 `dataReadyState` / `dataReadyError`（line 324-325）；(d) 简化 `finalizeResult` 同步路径，删除 failed 检查（line 469-475）；(e) JSDoc 注释同步更新（line 458-461） |
| 32 | `src/shared/lock-data/core/actions.ts` | (a) `ensureDataReady` 删除 failed 快路径（line 392-393）；(b) 改判断为单字段 `dataReadyPromise !== null`（line 397）；(c) JSDoc 注释更新（line 384-385） |

#### 文档改动（追加到 §8.2）

| # | 文件 | 改动（含实测行号） |
| --- | --- | --- |
| 18 | `RFC.md:232` | 注释「`getValue` 返回 Promise 且 `entry.dataReadyState !== 'ready'`」改写为「`getValue` 返回 Promise 且 `entry.dataReadyPromise !== null`（异步初始化未就绪：同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册）」 |
| 19 | `RFC.md:648` | 表格条目「`dataReadyState` `'pending' \| 'ready' \| 'failed'`；转换规则见下」整行删除 |
| 20 | `RFC.md:658` | 「按 `options.getValue` 返回同步值 / Promise 设置 `dataReadyState`」改写为「按 `options.getValue` 返回同步值 / Promise 设置 `dataReadyPromise`」 |
| 21 | `RFC.md:676-682`（`dataReadyState 状态转换`隐式有限状态机段落） | 整段删除，替换为「Entry 对外可见 ↔ 数据已就绪（fail-fast 语义）；异步初始化未就绪场景（同 Tab 二次调用方命中 / authority.init 等待 / 异步初始化期间提前注册）通过 `dataReadyPromise` 等待 resolve」 |
| 22 | `RFC.md:962`「若 `entry.dataReadyState === 'failed'`，任何 action 调用直接 reject `LockDisposedError`」 | 改写为「异步初始化未就绪场景下首次调用的初始化失败时，`dataReadyPromise` reject；同 Tab 所有持有此 Entry 的调用方在 action 时通过 `ensureDataReady` 抛 `LockDisposedError`（`cause` 字段携带 `getValue` 原始 reject 原因）」 |

#### 测试改动（追加到 §8.3）

| # | 文件 | 改动 |
| --- | --- | --- |
| 11 | `__test__/core/registry.node.test.ts` | 删除所有 `expect(entry.dataReadyState).toBe(...)` / `expect(entry.dataReadyError).toBe(...)` 断言；改为对 `dataReadyPromise` 行为的断言（`null` / `pending` / `rejected`）+ Entry 是否成功构造的存在性断言 |
| 12 | `__test__/integration/entry.node.test.ts` | 同上 |
| 13 | `__test__/authority/init-dispose-race.node.test.ts` | 涉及 `dataReadyState` 断言的全部改写为对 `dataReadyPromise` settle 状态的断言 |

### 12.9 收益

1. **代码量减少**：删除 1 个状态字段（dataReadyState）+ 1 个错误字段（dataReadyError）+ 1 套 onStateChange 回调闭包（`core/entry.ts:281-291` 实测 11 行）+ 9 处状态赋值（实测 `core/registry.ts:425/431/497/519` 4 处 onStateChange 入参 + entry.ts:324-325 字段初始化 2 处 + actions.ts:392-394 failed 快路径 3 处）；4 个待删辅助函数（`registry.ts:470/483/493/515` 共约 70 行）—— 净减少行数：4 函数（约 70 行）+ onStateChange 闭包（11 行）+ 字段/赋值（约 20 行）+ JSDoc 注释（约 10 行）合计约 110 行
2. **契约漂移风险归零**：三条手工维护的双/三字段同步不变量被消除
3. **错误传播链路单一通道**：错误只通过 `dataReadyPromise.reject` 传播，不再由 `dataReadyState` + `dataReadyError` 双字段携带
4. **fail-fast 语义彻底落地**：「Entry 存在 ↔ 已就绪」—— Entry 的存在本身成为就绪的证据，无需额外字段标记
5. **`dataReadyPromise` 真实用途明确**：详见 §14.3 缺口 5 订正 —— 跨 Tab 不共享 InstanceRegistry，所谓"副本 Tab 命中"场景实际不存在；真实用途是「同 Tab 二次 lockData 共享 + authority.init 等待 + 异步初始化期间 Entry 提前注册以支撑 refCount++」

---

## 13. 关联文件

### 13.1 必须改动的源码文件

- `src/shared/lock-data/index.ts`：单签名 + CloneFn 公开导出删除（§8.1 #2）
- `src/shared/lock-data/types.ts`：getValue 必传 + LockDataValueShape + read→snapshot + CloneFn 删除 + Entry.dataRef + dataReadyState/dataReadyError 删除（§8.1 #1 + §12.8 #30）
- `src/shared/lock-data/core/registry.ts`：resolveInitialData 重写 + 4 函数删除 + applyInPlace 迁出 + DataReadyState 类型/字段/导出删除（§8.1 #7-#14 + §12.8 #30）
- `src/shared/lock-data/core/entry.ts`：lockData 主入口单参数 + createEntryFactory 删 initial + onStateChange 闭包删除 + finalizeResult 简化（§8.1 #3-#6 + §12.8 #31）
- `src/shared/lock-data/core/actions.ts`：entry.data → entry.dataRef.current + read → snapshot + JSON 拷贝 + applyInPlace 内联 + ensureDataReady 单字段化（§8.1 #15-#20 + §12.8 #32）
- `src/shared/lock-data/core/readonly-view.ts`：完全重写为 wrapper Proxy（§8.1 #21）
- `src/shared/lock-data/authority/index.ts`：缺口 2 钩子重构 —— `host.data` 字段删除 + 新增 `host.applyRemote(next)` 方法 + `StorageAuthorityDeps::applySnapshot` 字段整体删除 + clone 依赖删除（§8.1 #22-#27 + §14.1）
- `src/shared/lock-data/adapters/clone.ts`：整文件删除（§8.1 #28）
- `src/shared/lock-data/adapters/index.ts`：clone 字段 + createSafeCloneFn 引用删除（§8.1 #29）

### 13.2 必须改动的文档文件

- `RFC.md`：## API 设计 + dataReadyState + 引用稳定契约 + storage-authority 流程 + 顶层数组禁止 + actions.snapshot 章节，全部需要重写（§8.2 + §12.8 文档改动）；具体行号见 §8.2 表 1-17 与 §12.8 表 18-22
- `IMPLEMENTATION.md`：7.x 章节追加重构条目（§8.2 #16）

### 13.3 必须改动的测试文件

- `__test__/core/entry.browser.test.ts`：19 处 `lockData()` 改单参数（§8.3 #1）
- `__test__/core/entry-standalone-driver-isolation.node.test.ts`：7 处（§8.3 #2）
- `__test__/integration/entry.node.test.ts`：1 处 + dataReadyState 断言改写（§8.3 #3 + §12.8 #12）
- `__test__/core/entry-standalone-driver-isolation.browser.test.ts`：1 处（§8.3 #4）
- `__test__/_helpers/memory-adapters.ts`：1 处（§8.3 #5）
- `__test__/core/actions.browser.test.ts`：4 处 `actions.read()` → `actions.snapshot()`（§8.3 #6）
- `__test__/core/registry.node.test.ts`：10 处 `resolveInitialData()` + 占位用例 + dataReadyState 断言改写（§8.3 #7 + #8 + §12.8 #11）
- `__test__/core/registry-async-initial-required.node.test.ts`：整文件删除（§8.3 #9）
- `__test__/adapters/`：clone 注入用例删除（§8.3 #10）
- `__test__/authority/init-dispose-race.node.test.ts`：dataReadyState 断言改写（§12.8 #13）

### 13.4 历史关联

- `fixes/initial-data-shape-mismatch.md`：已删除，被本方案完全取代

### 13.5 changeset

- `.changeset/<auto>.md`：major bump，完整 breaking change 描述（§8.5 commit 策略）

---

## 14. 缺口 2/3/5/7 决策档案

### 14.1 缺口 2：authority 钩子重构 —— `applySnapshot` 废弃改为 `host.applyRemote(next)` 方法

#### 14.1.1 背景

旧 `StorageAuthorityDeps<T>::applySnapshot: (data: T, nextSnapshot: T) => void`（实测 `authority/index.ts:88`）由调用方注入，钩子内部需要感知如何把 `next` 写到 `data` —— 这是个职责倒挂：authority 模块不应该知道宿主的 data 存储形态（旧版是「`data: T` 引用」，新版是「`dataRef: { current: T }` wrapper」）。

实测唯一调用点 `authority/index.ts:179` 同步执行 `applySnapshot(host.data, nextSnapshot)`，所有其他 5 处引用都是字段定义/类型声明/解构。

#### 14.1.2 决策（用户决策 C）

把 `applySnapshot` 钩子整体废弃，改为在 `StorageAuthorityHost<T>` 契约上暴露 `applyRemote(next: T): void` 方法 —— authority 内部不感知 dataRef wrapper 实现细节，宿主自行实现「如何把 next 落到 dataRef.current」。

#### 14.1.3 契约变更

```ts
// 旧
interface StorageAuthorityHost<T extends object> {
  data: T;
  rev: number;
  lastAppliedRev: number;
  epoch: string | null;
}
interface StorageAuthorityDeps<T extends object> {
  readonly host: StorageAuthorityHost<T>;
  readonly applySnapshot: (data: T, nextSnapshot: T) => void;
  // ...
}

// 新
interface StorageAuthorityHost<T extends object> {
  // data 字段彻底从 host 契约消失（authority 不读 data）
  readonly applyRemote: (next: T) => void;
  rev: number;
  lastAppliedRev: number;
  epoch: string | null;
}
interface StorageAuthorityDeps<T extends object> {
  readonly host: StorageAuthorityHost<T>;
  // applySnapshot 字段彻底删除（钩子从 deps 移除）
  // ...
}
```

#### 14.1.4 调用点改写

| 文件 | 行号 | 旧 | 新 |
| --- | --- | --- | --- |
| `authority/index.ts` | 53 | `data: T;` 字段 + 注释 | 删除字段；改为 `readonly applyRemote: (next: T) => void;` |
| `authority/index.ts` | 88 | `readonly applySnapshot: (data: T, nextSnapshot: T) => void;` | 删除整行 |
| `authority/index.ts` | 166 | `const { host, logger, clone, applySnapshot, emitSync } = deps;` | 删除 `applySnapshot`：`const { host, logger, emitSync } = deps;`（`clone` 同时删除，见 §8.1 #24） |
| `authority/index.ts` | 179 | `applySnapshot(host.data, nextSnapshot);` | `host.applyRemote(nextSnapshot);` |

#### 14.1.5 宿主实现迁移（`core/entry.ts`）

| 旧 | 新 |
| --- | --- |
| `attachAuthority` deps 注入：`applySnapshot: applyInPlace` | 删除 |
| Entry 字段（StorageAuthorityHost 兼容）：`data: T` | 删除字段；新增 `applyRemote: (next) => { entry.dataRef.current = JSON.parse(JSON.stringify(next)); }` |

#### 14.1.6 测试影响

- `__test__/authority/integration.browser.test.ts`：实测 22 处 `applySnapshot: simpleApplySnapshot` 全部改写。host 字段改 `applyRemote`，deps 删 `applySnapshot` 字段；`simpleApplySnapshot` 函数本体迁移到 host 构造期闭包内
- `__test__/authority/init-dispose-race.node.test.ts`：line 144/163/182/187/230/237/238 共 7 处涉及 `applySnapshot` mock，全部改写为 `applyRemote` mock 方式

#### 14.1.7 收益

1. **职责正交**：authority 不再感知宿主存储形态；将来 wrapper Proxy 切换到其他实现（Signal / Atom）时 authority 模块零改动
2. **删除一个 deps 字段**：`StorageAuthorityDeps::applySnapshot` 彻底消失，构造期心智负担减一
3. **测试桩简化**：mock authority 时只需提供 `host.applyRemote` 即可，无需配套 `applySnapshot` 字段

---

### 14.2 缺口 3：Entry 字段命名 —— 选择 `dataRef: { current: T }`（React 风格）

#### 14.2.1 决策（用户决策 A）

Entry 字段命名采用 `dataRef: { current: T }` —— React 风格，含义直观（联想 `useRef`），与 `{ current: T }` wrapper 形状语义一致。

#### 14.2.2 字段契约

```ts
interface Entry<T extends object> {
  readonly id: string;
  readonly lockId: string | undefined;
  /**
   * 数据引用容器；wrapper 自身（包括外层 `dataRef` 引用）在 Entry 生命周期内
   * 永不变更，但 `dataRef.current` 在每次 commit / init resolve / authority
   * applyRemote 时被重新赋值
   *
   * `readonly` 修饰的是「外层 dataRef 字段不可重新赋值」；`current` 字段本身
   * 是 mutable 的，由模块内部通过 `entry.dataRef.current = next` 改写
   */
  readonly dataRef: { current: T };
  // ... 其他字段不变
}
```

#### 14.2.3 命名一致性审计

| 模块 | 字段访问点 | 改写 |
| --- | --- | --- |
| `core/registry.ts:67` | `readonly data: T;` | `readonly dataRef: { current: T };` |
| `core/registry.ts:360` | `InitialDataPatch::data` | `InitialDataPatch::data: T`（保留 —— 这是「初始值」单次产物，不是 wrapper） |
| `core/registry.ts:452` | `data: raw as T` | `data: raw as T`（同上保留） |
| `core/entry.ts:312` | `mutableEntry.data: initialPatch.data` | `mutableEntry.dataRef = { current: initialPatch.data }` |
| `core/entry.ts:383` | `createReadonlyView(entry.data)` | `createReadonlyView(entry.dataRef)` |
| `core/actions.ts` 全文 | `entry.data` | `entry.dataRef.current` |
| `authority/index.ts` | `host.data`（缺口 2 后已不存在） | host.applyRemote 内部访问 entry.dataRef.current |

#### 14.2.4 Entry 接口完整定义（含 applyRemote，与 §14.1 协同）

为支撑缺口 2 的 `host.applyRemote(next)` 方法，Entry 接口同步新增 `applyRemote` 字段：

```ts
interface Entry<T extends object> {
  readonly id: string;
  readonly lockId: string | undefined;
  readonly dataRef: { current: T };
  /**
   * authority 远程同步入口：authority 内部调用 host.applyRemote(next) 时
   * 走入此方法，方法内部封装「JSON 拷贝隔离 + dataRef.current 重新赋值」语义
   *
   * `readonly` 修饰：函数引用本身不变；函数体内部对 dataRef.current 写入是
   * 受控的内部状态变更
   */
  readonly applyRemote: (next: T) => void;
  // ... 其他字段不变
}
```

构造期赋值（`core/entry.ts:312` 之后）：

```ts
mutableEntry.dataRef = { current: initialPatch.data };
mutableEntry.applyRemote = (next: T): void => {
  mutableEntry.dataRef.current = JSON.parse(JSON.stringify(next));
};
```

#### 14.2.5 关键设计考量

1. **`InitialDataPatch::data` 字段名保留**：这是 factory 一次性返回给 Entry 构造的「初始值产物」，不是引用 wrapper，没必要改名为 `initialDataRef`。Entry 构造期会把 `patch.data` 包装为 `{ current: patch.data }`
2. **`readonly dataRef`**：外层字段不可重新赋值（保证 wrapper Proxy 的 target 永不切换）；`current` mutable
3. **不引入 getter `get data(): T`**：避免「同时存在 `data` 和 `dataRef` 两种访问方式」造成的认知漂移，所有内部访问统一走 `dataRef.current`

#### 14.2.6 收益

1. **语义清晰**：`{ current: T }` wrapper 形状与 React `useRef` 一致，新人零成本理解
2. **避免命名冲突**：旧 `data` 字段在多处类型定义中出现（`InitialDataPatch::data` / `attachAuthority` / 测试），改名为 `dataRef` 让"wrapper 化"的字段从命名上就能识别
3. **强可读性**：`entry.dataRef.current = next` 的访问形式比 `entry.data = next` 更明确表达"这是个 wrapper"

---

### 14.3 缺口 5：`dataReadyPromise` 真实用途订正 + 异步初始化期间提前注册

#### 14.3.1 实测发现的设计误判

§12.3 中描述「`dataReadyPromise !== null`（仅副本 Tab 命中场景出现）」是错的。实测：

1. **跨 Tab 不共享 `InstanceRegistry`**：`createInstanceRegistry()` 是模块级单例，每个 Tab 独立 import 模块 → 独立的 Registry Map → 跨 Tab 完全独立
2. **每个 Tab 各自调用 `getValue()`**：跨 Tab 不存在「副本 Tab 命中主 Tab 已构造的 Entry」场景
3. **跨 Tab 数据同步靠 authority 协议**：其他 Tab（物理意义上的另一个浏览器 Tab，与 InstanceRegistry 副本无关）通过 `authority.subscribe` 收到 storage event → `host.applyRemote(next)` 改写 dataRef.current → wrapper Proxy 自动跟随

#### 14.3.2 `dataReadyPromise` 真实使用场景（订正版）

| 场景 | 描述 |
| --- | --- |
| **同 Tab 二次调用 `lockData(sameOptions)` 命中已存在 Entry** | 用户在异步 getValue 还没 resolve 时第二次 `lockData()` —— InstanceRegistry 命中 + refCount++ + 共享 dataReadyPromise |
| **`attachAuthority` 异步 init 完成等待** | `mergeReadyPromises(getValueReady, authorityReady)` 让 `await lockData()` 包含 authority.init() 的完成 |

#### 14.3.3 决策（用户决策 C）：异步初始化期间 Entry 提前注册

> 异步初始化期间 Entry 提前注册（`refCount = 1`） + `dataReadyPromise` 共享给二次调用方（`refCount++`）；resolve 失败时所有持有者一起拿到 reject

这意味着新方向下「Entry 构造延迟到 resolve 之后」需要**重新审视**：

| 路径 | 旧方向（§3.2 描述） | 缺口 5 决策后的修正 |
| --- | --- | --- |
| 同步 `getValue: () => T` | 同步构造 Entry | **同步构造 Entry**（不变） |
| 异步 `getValue: () => Promise<T>` | **延迟构造 Entry**（resolve 后才 `getOrCreateEntry`） | **提前构造 Entry**（getValue 调用瞬间 → 提前构造 Entry 占位 dataRef + dataReadyPromise；await getValue → resolve 后赋值 dataRef.current；reject 则 dataReadyPromise reject + Entry 标记销毁） |

#### 14.3.4 异步路径生命周期（订正版）

```
lockData(options)
  │
  ├─ 步骤 1：Entry 提前构造 + 注册到 InstanceRegistry
  │   ├─ getOrCreateEntry(id, options, factory) → factory 内部：
  │   │   ├─ dataRef = { current: PLACEHOLDER }  // 内部占位 {}，不暴露给用户
  │   │   ├─ dataReadyPromise = getValuePromise.then(awaited => {
  │   │   │     assertJsonSafe(awaited, [], new WeakSet(), 'getValue');  // 缺口 7
  │   │   │     if (Array.isArray(awaited)) throw new InvalidOptionsError(...);  // §5.3
  │   │   │     dataRef.current = JSON.parse(JSON.stringify(awaited));
  │   │   │   }).catch(err => {
  │   │   │     entry.refCount = 0;       // 触发 teardowns
  │   │   │     registry.delete(id);       // 让后续 lockData 命中 miss
  │   │   │     throw createFailedInitError(id, err);
  │   │   │   })
  │   │   └─ refCount = 1（首次注册）
  │   │
  │   └─ 期间同 Tab 二次调用方 lockData(sameOptions)：
  │       ├─ getOrCreateEntry 命中已存在 Entry → refCount++
  │       └─ 共享 dataReadyPromise（同一个 Promise 实例）
  │
  ├─ 步骤 2：finalizeResult 异步分支等待 dataReadyPromise
  │   ├─ const view = createReadonlyView(entry.dataRef)  // wrapper Proxy 立即可构造
  │   ├─ const actions = createActions({ entry, ... })   // actions 立即可构造
  │   └─ return entry.dataReadyPromise.then(() => [view, actions], err => {
  │         actions.dispose();
  │         throw createFailedInitError(entry.id, err);
  │       })
  │
  └─ 步骤 3：调用方收到的 Promise 在 dataReadyPromise resolve 后才 resolve
      ├─ 用户 const [view, actions] = await lockData(...) 拿到元组时，dataRef.current 已就绪
      └─ 此时 view 上任何字段访问都返回真实数据
```

**关键时序保证**：
1. **同步阶段**：`lockData()` 入口同步执行到 `getOrCreateEntry()` 完成，Entry 立即可见于 registry
2. **同 Tab 二次调用**：在主调用 await dataReadyPromise 期间，二次调用 `lockData(sameId)` 立即命中（不等 getValue）
3. **元组交付**：所有调用方（包括首次和二次）都通过 `dataReadyPromise.then(() => [view, actions])` 在 ready 后才拿到元组

#### 14.3.5 PLACEHOLDER 的处理

异步路径下 `dataRef.current` 在 resolve 前是占位值。决策：使用 `{}` 空对象作为占位（类型断言为 `T`）。

**为什么选 `{}` 而非 `null` / `undefined`**：

| 场景 | `{}` 占位 | `null` 占位 |
| --- | --- | --- |
| 用户能否在 await 完成前访问 view | 拿不到 view —— `lockData()` 的 Promise 在 dataReadyPromise resolve 后才返回元组 | 同 |
| 内部偶然访问（authority.init 完成回调） | wrapper Proxy `get` trap 解引用 `{}.someKey` 返回 `undefined` | NPE 抛错 |
| 实现复杂度 | 最简单（一行 `{ current: {} as T }`） | 需要全路径补 null 检查 |
| `JSON.stringify(dataRef.current)` 副作用 | 输出 `'{}'`（无副作用） | 输出 `'null'`（语义异常） |

**关键不变量**：「PLACEHOLDER 永不暴露给调用方」由 §14.3.4 步骤 2-3 的时序保证 —— 调用方拿到 `[view, actions]` 元组时，`dataRef.current` 已经被 resolve 后赋值为真实数据。即使调用方调用 `actions.snapshot()` 也安全（`ensureDataReady` 已经在 actions 入口 await dataReadyPromise，详见 §12.4.3 #21 简化后的实现）。

**异常路径的安全性**：异步 reject 时 §14.3.4 step 1 catch 内 `entry.refCount = 0` + `registry.delete(id)` 立即触发 teardowns，PLACEHOLDER 状态下的 Entry 资源被回收，不留悬挂。

#### 14.3.6 失败传播

异步 reject 时：
1. `dataReadyPromise.reject(err)` —— 所有 await 的持有者一起拿到 LockDisposedError
2. `entry.refCount = 0` 触发 teardowns（authority.dispose / driver.destroy / registry.delete）
3. **不**走 `actions.dispose()` —— Entry 还没把 actions 交给任何调用方，直接标记销毁即可

#### 14.3.7 与缺口 4 半极简的兼容性确认

缺口 4 决策「Entry 一旦构造就必然 ready」**仍然成立**：

- 同步路径：Entry 构造瞬间 dataRef.current 已是合法值（getValue 同步返回 + JSON 拷贝）→ `dataReadyPromise = null`
- 异步路径：Entry 构造瞬间 dataRef.current 是占位值 → `dataReadyPromise !== null`，await 后 dataRef.current 才是合法值

「Entry 必然 ready」的真实语义是「Entry 一旦**对用户可用**（即返回 `[view, actions]` 元组）就必然 ready」，而不是「Entry 一旦构造就必然 ready」。订正：

| 旧 §12.3 描述 | 订正描述 |
| --- | --- |
| Entry 存在 → 数据必然已就绪 | **Entry 对外可见**（`lockData()` 返回的元组已交付给调用方）→ 数据必然已就绪 |
| `dataReadyPromise === null` → 数据已就绪（同步路径） | 不变 |
| `dataReadyPromise !== null` 仅副本 Tab 出现 | **`dataReadyPromise !== null` 出现在以下两种场景：(1) 异步 getValue 期间的 Entry 内部状态；(2) 同 Tab 二次调用方命中 Entry 时；(3) authority.init 等待场景** |

#### 14.3.8 `ensureDataReady` 简化兼容性

§12.4.3 中 `ensureDataReady` 改为单字段 `if (entry.dataReadyPromise !== null) await ...`。缺口 5 决策**完全兼容**：

- 同 Tab 二次调用：调用方拿到 `[view, actions]` 时 dataReadyPromise 已被外层 `lockData()` 等待 resolved；后续 actions 操作时 `dataReadyPromise` 已是 settled Promise，await 立即继续
- authority.init 等待：authority 注入路径下 `attachAuthority` 内部已通过 mergeReadyPromises 把两个就绪 Promise 合一，actions 层只看到一个 dataReadyPromise

---

### 14.4 缺口 7：`assertJsonSafe` 提取为公共工具 + getValue/replace 入口校验

#### 14.4.1 背景

实测 `core/draft.ts:161-228` 已有完整 JSON-safe 校验函数 `assertJsonSafe`，但仅在以下时机调用：

| 调用点（实测行号） | 时机 |
| --- | --- |
| `core/draft.ts:285` | draft Proxy `set` trap：用户 `update(recipe)` 内对 draft 写入时 |
| `core/draft.ts:342` | `createDraftSession(target)` 入口：draft session 构造时 |

**关键缺口**：`getValue()` 返回值 + `actions.replace(next)` 入参不经过 `assertJsonSafe` —— 依赖 `JSON.parse(JSON.stringify(...))` 兜底，但这个兜底**会静默丢失数据**：

| 输入 | `JSON.stringify` 结果 | 用户感知 |
| --- | --- | --- |
| `new Date()` | 字符串 `'2025-...'` | 静默丢失 Date 类型 |
| `new Set([1,2])` | `'{}'` | 静默丢失 Set 数据 |
| `new Map()` | `'{}'` | 静默丢失 Map 数据 |
| `new Uint8Array([1,2,3])` | `'{"0":1,"1":2,"2":3}'` | 静默转 plain object |

#### 14.4.2 决策（用户决策 B）

把 `assertJsonSafe` 提取为模块级公共工具（`core/utils/json-safe.ts` 或 `lock-data` 内部 utils），所有进入 entry 的数据（getValue 返回值 / actions.replace 入参）resolve 后立即调用 fail-fast 校验 —— 边界一致。

#### 14.4.3 文件结构调整

| 操作 | 文件 |
| --- | --- |
| 新建 | `src/shared/lock-data/utils/json-safe.ts`（导出 `assertJsonSafe` + 辅助 `formatPath` / `describeNonJsonValue` / `isPlainObject`） |
| 修改 | `src/shared/lock-data/core/draft.ts`：删除内部 `isPlainObject`（line 88-92，5 行）+ `formatPath`（line 94-110，17 行）+ `describeNonJsonValue`（line 112-150，39 行）+ `assertJsonSafe`（line 161-228，68 行）共约 129 行；改为 `import { assertJsonSafe } from '../utils/json-safe'`；line 31 `import { throwError } from '@/shared/throw-error'` 在 draft.ts 仍保留（其他位置如 line 257 `ensureWritable` 仍调用 throwError） |

#### 14.4.4 调用点扩展

| 调用点 | 时机 | 失败处理 |
| --- | --- | --- |
| `core/registry.ts::resolveInitialData`（同步路径） | `getValue()` 同步返回值 → 立即 `assertJsonSafe` | 抛 LockDisposedError（包装 TypeError），Entry 不构造 |
| `core/registry.ts::resolveInitialData`（异步路径 await 后） | `awaited = await getValue()` → 立即 `assertJsonSafe` | dataReadyPromise reject，触发 §14.3.6 失败传播 |
| `core/actions.ts::replace(next)`（实测 line 731-748：方法主体；line 733-735 是 `if (!isObject(next)) { throwError(...); }` 同步类型校验） | 入参 `next` 在 line 735 之后、line 736 `enqueueWrite` 之前同步调用 `assertJsonSafe(next, [], new WeakSet(), 'replace')` | 同步抛 TypeError，不消耗写队列槽位 |
| `core/draft.ts:285`（保留） | draft Proxy set trap | 同步抛 TypeError，rollback |
| `core/draft.ts:342`（保留） | createDraftSession 构造 | 同步抛 TypeError |

#### 14.4.5 与 §7 JSON 拷贝隔离的协同

新方向下「JSON 拷贝隔离」（§7）和「assertJsonSafe 校验」（缺口 7）形成**两道闸**：

| 闸 | 触发位置 | 作用 |
| --- | --- | --- |
| 闸 1：`assertJsonSafe` | getValue resolve 后 / replace 入参 / draft 写入 | **fail-fast 拒绝** Set/Map/Date/TypedArray/function/BigInt 等非 JSON-safe 类型 |
| 闸 2：`JSON.parse(JSON.stringify(...))` | dataRef 赋值 / commit 快照 / snapshot read / emitSync 二次拷贝 | **引用隔离**（拷贝出的对象与原始引用断开） |

闸 1 通过后，闸 2 必然不会抛错（assertJsonSafe 已经保证了 JSON-safe），所以 §7.3 中「`JSON.stringify` 抛错」的兜底场景**几乎不会触发**（除非用户主动绕过，例如用 `as any` 强转）。但 §7.3 兜底逻辑保留，作为「最后一道防线」。

#### 14.4.6 错误信息一致性

`assertJsonSafe` 内部用 `throwError(ERROR_FN_NAME, ...)` 抛 TypeError（实测 `core/draft.ts:31` 引入 `throwError`）。提取到 `utils/json-safe.ts` 后保持相同的报错形态：

```
[lockData] draft only supports JSON-safe values, got "Set" at "tags"
```

新调用点（getValue / replace）抛错时把上下文从 `draft` 改为 `getValue` / `replace`：

| 调用点 | 错误前缀 |
| --- | --- |
| draft set trap / createDraftSession | `[lockData] draft only supports JSON-safe values, ...` |
| getValue resolve 后 | `[lockData] getValue must return JSON-safe values, ...` |
| actions.replace 入参 | `[lockData] replace requires JSON-safe values, ...` |

实现方式：`assertJsonSafe` 函数签名扩展为：

```ts
// 旧签名（core/draft.ts:161）
function assertJsonSafe(value: unknown, path: readonly PropertyKey[], seen: WeakSet<object>): void;

// 新签名（utils/json-safe.ts，contextLabel 默认 'draft'）
function assertJsonSafe(
  value: unknown,
  path: readonly PropertyKey[],
  seen: WeakSet<object>,
  contextLabel?: 'draft' | 'getValue' | 'replace',
): void;
```

内部所有 `throwError(ERROR_FN_NAME, ...)` 调用点（实测 line 168/180/190/210/220）的报错信息字符串前缀按 `contextLabel` 分支：
- `'draft'`：保持现状 `draft only supports JSON-safe values, ...`
- `'getValue'`：`getValue must return JSON-safe values, ...`
- `'replace'`：`replace requires JSON-safe values, ...`

递归调用 `assertJsonSafe` 时（line 202 数组元素 / line 227 对象属性）需要传递 `contextLabel`，保证错误前缀在递归路径上保持一致。

#### 14.4.7 改动文件矩阵（追加到 §8.1）

| # | 文件 | 改动 |
| --- | --- | --- |
| G7-1 | `src/shared/lock-data/utils/json-safe.ts` | **新建**：导出 `assertJsonSafe(value, path, seen, contextLabel?: 'draft' \| 'getValue' \| 'replace')` + 辅助 `formatPath` + `describeNonJsonValue` + `isPlainObject`；contextLabel 默认 `'draft'`；递归调用透传 contextLabel |
| G7-2 | `src/shared/lock-data/core/draft.ts:88-228` | 删除内部 `isPlainObject`（line 88-92）+ `formatPath`（line 94-110）+ `describeNonJsonValue`（line 112-150）+ `assertJsonSafe`（line 161-228）共约 129 行；改为 `import { assertJsonSafe } from '../utils/json-safe'`；line 31 `throwError` 引入保留（其他位置仍调用） |
| G7-3 | `src/shared/lock-data/core/registry.ts::resolveInitialData` | 同步路径 `getValue()` 返回值 + 异步 `awaited` 后 → 调用 `assertJsonSafe(value, [], new WeakSet(), 'getValue')` |
| G7-4 | `src/shared/lock-data/core/actions.ts::replace`（实测 line 731-748：方法主体；line 733-735 是 `if (!isObject(next)) { throwError(...); }` 同步类型校验） | 在 line 735 之后、line 736 `enqueueWrite` 之前插入 `assertJsonSafe(next, [], new WeakSet(), 'replace')` |

#### 14.4.8 收益

1. **错误时机统一**：所有进入 entry 的数据在最早时机 fail-fast，用户立即看到「got Set / Map / Date」等清晰错误，而不是「数据莫名变了形态」
2. **消除静默丢失**：缺口 7 之前 `JSON.stringify(new Date())` 静默转字符串、`JSON.stringify(new Set())` 静默转 `'{}'` 这类用户难以诊断的 bug 彻底消失
3. **代码复用**：避免在多个调用点重复 JSON-safe 校验逻辑
4. **错误信息可定位**：路径 `formatPath` 输出 `'tags'` / `'items[0].created'` 等精确路径，让用户立即定位违规字段
5. **draft.ts 体积减少约 129 行**（实测 line 88-92 / 94-110 / 112-150 / 161-228 共 4 个函数迁出）：draft 模块只保留 Proxy 事务核心逻辑

