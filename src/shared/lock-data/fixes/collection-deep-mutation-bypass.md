# Draft 集合内对象深层修改绕过事务跟踪 — 修复方案

## 缺陷复现

```ts
const session = createDraftSession({
  map: new Map<string, { x: number }>([['k', { x: 1 }]]),
});
const draft = session.draft;

// draft.map.get('k') 命中 collection get 分支：
//   'get' 不在 MAP_MUTATION_METHODS 里 → 走 `value.bind(target)` 分支
//   bind 的 this 是原始 Map → 返回的就是真实存进去的 { x: 1 } 引用
const item = draft.map.get('k');
item!.x = 2;        // ❌ 没经过任何 proxy，mutations 不记录
session.rollback(); // ❌ 还原不了，map 里仍是 { x: 2 }
```

同样的口子在所有"读出值"的 collection API 上：
- `Map.get(key)` / `Map.values()` / `Map.entries()` / `Map.forEach`
- `Set.values()` / `Set.entries()` / `Set.forEach` / `Symbol.iterator`

`mutations` 与 `snapshot` 都对此一无所知 → commit/rollback 语义被静默破坏。

## 影响范围

- `core/draft.ts`：`resolveCollectionMember` 的非 mutation 分支直接返回 `value.bind(target)`
- 所有把可变对象塞进 Set/Map 的写法（生产代码即使现在能跑，跨 Tab 同步也不会传播深层修改 → **本来就是错的，只是没被检测出来**）

## 候选方向

### 方向 A：把集合读取结果继续包成子 draft

`Map.get` / 迭代器产出的对象用 `createDraftProxy` 递归包装，路径用伪段 `@map(key)` / `@set(item)` 表达。

- ✅ 调用方零改造
- ⚠️ mutation path 出现伪段 → commit 持久化层、跨 Tab 重放、authority 序列化全部需要兼容
- ⚠️ Set 元素无稳定键 → 需要 WeakMap 维护 item → id 映射
- ⚠️ 与 RFC 顶部「Set/Map 整体克隆 / 中小规模」的设计预期相悖

### 方向 B：运行时禁止集合内保存可变对象

`Map.set` / `Set.add` 入口对 value 做"是否为可变对象"校验，命中即抛错。

- ✅ 实现简单
- ✅ commit 持久化路径完全不变
- ⚠️ 出口（`get` / 迭代）仍然返回原始引用 → 需要配合冻结 / 只读 proxy
- ⚠️ 即使禁了也只是"集合本身能用，但内容必须是值类型"

### 方向 C（采纳）：移除对 Set/Map 的支持，仅允许 JSON 安全类型

**根源：lock-data 是事务式锁数据，commit 后会跨 Tab 同步、可被持久化序列化。Set/Map 在 JSON 上下文里本来就是「需要自定义序列化」的类型，让它出现在 draft 里只会持续制造类似缺陷。**

- ✅ 入口 `createDraftSession(target)` 递归校验 target 内不出现 Set/Map/Date/RegExp/class 实例 等非 JSON 类型
- ✅ 写入（`set` trap）value 同样递归校验，避免 recipe 内绕过
- ✅ 删除全部 collection proxy 代码（~80 行），`draft.ts` 大幅简化
- ✅ `LockDataMutation` 的 `'set-*' / 'map-*'` op 一并移除（仅 draft 内部使用，外部无依赖）
- ✅ `createDraftSession` / `DraftSession` / `LockDataMutation` 入口处补 JSDoc tip，明确"仅 JSON 安全类型"契约
- ⚠️ Breaking 变更：现存测试 `draft.node.test.ts` 中的 Set/Map 用例需要改写为 plain object/array

## 选定方案：方向 C

### JSON 安全类型定义

**允许**：
- `string` / `number`（**不含 NaN/Infinity**，与 `JSON.stringify` 行为对齐）
- `boolean`
- `null`
- plain object：`Object.getPrototypeOf(value) === Object.prototype` 或 `prototype === null`
- plain array：`Array.isArray(value)`
- 嵌套以上类型

**禁止**：
- `undefined`（保守策略，与 `JSON.stringify` 严格对齐：`stringify({x: undefined})` 会丢字段）
- `bigint` / `symbol` / `function`
- Set / Map / Date / RegExp / Error / Promise
- TypedArray / WeakMap / WeakSet
- class 实例（任何 prototype 既非 `Object.prototype` 也非 `null` 的对象）
- 循环引用

### 实施清单

**`draft.ts` 删除**：
- `SET_MUTATION_METHODS` / `MAP_MUTATION_METHODS`
- `CollectionInfo` / `detectCollection`
- `CollectionAccess` / `resolveCollectionMember`
- `buildCollectionMutation`
- `captureCollectionSnapshotOnce`
- `restoreCollection`
- `DraftSnapshotEntry` 中 `'collection'` 分支
- `applyRollback` 中 `'collection'` 分支
- `createDraftProxy::get` 中 isCollection 分支

**`draft.ts` 新增**：
- `assertJsonSafe(value, pathSegments)` helper：递归校验，环检测用 `WeakSet`
- `createDraftSession` 入口调用 `assertJsonSafe(target, [])`
- `createDraftProxy::set` trap 中调用 `assertJsonSafe(value, [...parentPath, key])`
- `createDraftSession` / `DraftSession` JSDoc 补充 "Only JSON-safe values are allowed"

**`types.ts` 清理**：
- `LockDataMutationOp` 移除 `'map-set' | 'map-delete' | 'map-clear' | 'set-add' | 'set-delete' | 'set-clear'`
- `LockDataMutation` JSDoc 同步精简，补充 "Only JSON-safe values" 说明

**测试改造**：
- `__test__/core/draft.node.test.ts`：删除/改写 Set / Map 用例（约 4 个 describe block）
- 新增 `__test__/core/draft-json-only.node.test.ts`，5 组用例

### 关键设计点

1. **校验时机**：入口 + 每次 set 写入。get 不校验（已经被入口 / 上次 set 拦截过，不可能存在违规值）。
2. **错误类型**：API 误用 → `TypeError`，通过 `throwError(ERROR_FN_NAME, msg, TypeError)`，不复用 `LockRevokedError`。
3. **错误信息携带路径**：`'lock-data draft: unsupported value at "user.tags": Set is not JSON-safe (only plain object / array / string / number / boolean / null are allowed)'`，方便用户定位。
4. **环检测**：`WeakSet` 记录已访问 plain object / array，遇到环抛 `'cyclic reference at "..."'`。
5. **校验失败时机**：在 `Reflect.set` 之前抛错 → `target` 状态 / `mutations` / `snapshot` 全部不变（fail-fast，事务语义不被污染）。
6. **顶层 target 自身**：`createDraftSession<T extends object>` 已要求 object，入口校验时直接对 target 调用 `assertJsonSafe`，会顺带验证 target 是 plain object。

### 测试用例（`__test__/core/draft-json-only.node.test.ts`）

1. **入口拦截 - target 内含 Map / Set 抛 TypeError**
2. **入口拦截 - target 内含 Date / RegExp / class 实例抛 TypeError**
3. **入口允许 - 纯 JSON 数据**：plain object 嵌套 array 嵌套 primitive 正常通过
4. **写入拦截 - recipe 里 `draft.x = new Set()` 抛 TypeError，且 mutations / target 不变**
5. **环形引用 - 入口检测到 cycle 抛 TypeError**

### 边界场景

- **顶层 target 是数组**：`createDraftSession([1, 2, 3])` → array 是 JSON 安全 → 通过
- **嵌套深度**：递归校验无深度上限（与 JSON.stringify 行为一致；超大对象由调用方自负）
- **`null` vs `undefined`**：null 通过，undefined 拒绝（保守策略，避免持久化丢字段）
- **NaN / Infinity**：拒绝（`JSON.stringify` 会变 null 静默错误，主动拦截更好）
- **顶层 target = `Object.create(null)`**：通过（`null` prototype 视为 plain object）
- **rollback 后 set**：`validity.isValid` 已 false，`ensureWritable` 先抛 LockRevokedError，根本走不到 `assertJsonSafe`

## 不做的事

- 不引入 mutation path 伪段（commit 持久化层稳定）
- 不为已存在的 Set/Map 提供"自动转换为 object"的兼容层（容易隐藏问题）
- 不递归冻结（freeze 有副作用，且 Object.create(null) 等场景行为不一致）
