# RFC: changeTracker — 对象变更记录与重放工具

> status: accepted
>
> author: cmtlyt
>
> create time: 2026/06/10 11:30:00
>
> rfc version: 0.1.0
>
> scope: `src/shared/change-tracker`

## 版本历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 0.1.0 | 2026/06/10 | 初稿：Patch 类型、深度 Proxy 引擎、recordTransaction / createRecorder / replay 三个 API、自定义类型序列化、数组变异方法合并 |

## 背景与动机

前端协同编辑、状态时间旅行、用户行为录制回放等场景需要精确捕获对象变更并异地重放。现有方案（Redux, MobX, Immer）与特定框架绑定，且缺乏对自定义类型（`Date`, `Map`, `Set`）和跨端序列化的原生支持。

## 目标与非目标

### 目标

- 提供 `recordTransaction` / `createRecorder` / `replay` 三个 API，覆盖事务模式、持续监听、重放三种场景
- **Patch 驱动**：所有变更以 `Patch` 结构记录，支持序列化传输
- **自定义类型**：通过 `options.types` 支持 `Date`、`Map`、`Set` 等非 JSON 安全类型的序列化/反序列化
- **数组变异合并**：拦截 `push`/`pop`/`shift`/`unshift`/`splice` 等数组原型方法，合并为单一 `splice` Patch
- **零副作用**：`recordTransaction` 不修改原始对象，纯记录

### 非目标

- **不**内置任何网络传输逻辑（调用方自行处理 Patch 的发送与接收）
- **不**实现与特定框架（React/Vue）的绑定
- **不**实现 undo/redo 功能（可基于 Patch 列表由上层实现）
- **不**实现冲突合并（OT/CRDT 等协同算法由上层实现）

## 名词约定

| 名词 | 含义 |
| --- | --- |
| Patch（补丁） | 描述单次变更的结构化数据，包含路径、操作类型、值等 |
| PatchOp（操作类型） | 变更操作枚举：`set` / `delete` / `splice` |
| CustomTypeConfig（自定义类型配置） | 注册非 JSON 安全类型的序列化/反序列化规则 |
| TrackerOptions（追踪选项） | 记录时的共享配置，包含 `types` 数组 |
| ReplayOptions（重放选项） | 重放时的配置，继承 TrackerOptions 并增加 `mutate` 选项 |
| RecorderInstance（记录器实例） | `createRecorder` 返回的长期监听对象 |

## API 设计

### 类型定义

```typescript
/** 变更操作类型 */
type PatchOp = 'set' | 'delete' | 'splice';

/** 变更补丁 */
interface Patch {
  /** 变更路径 e.g. ['user', 'profile', 'age'] */
  path: (string | number)[];
  /** 操作类型 */
  op: PatchOp;
  /** set 时的新值（已序列化） */
  value?: unknown;
  /** splice 专用：起始索引 */
  index?: number;
  /** splice 专用：删除数量 */
  deleteCount?: number;
  /** splice 专用：插入项（已序列化） */
  items?: unknown[];
  /** 自定义类型标识，值为 TrackerOptions.types 中注册的 key（仅当 value 匹配某个自定义类型时存在） */
  type?: string;
  /** 记录时间戳 */
  timestamp: number;
}

/** 自定义类型序列化配置 */
interface CustomTypeConfig<T = unknown> {
  /** 类型标识字符串，会被写入 Patch.type 字段，replay 时通过该标识查找 deserialize */
  type: string;
  /** 类型检测 */
  is: (value: unknown) => value is T;
  /** 序列化：将自定义类型转为 JSON 安全值 */
  serialize: (value: T) => unknown;
  /** 反序列化：从 JSON 安全值恢复自定义类型 */
  deserialize: (raw: unknown) => T;
}

/**
 * 共享选项
 *
 * types 是一个有序的自定义类型配置数组。
 * 记录时按数组顺序遍历，对每项调用 is() 判断，首个返回 true 的项即为该值的类型，
 * 其 type 字段写入 Patch.type。
 * 重放时通过 Patch.type 在数组中查找匹配的 config.type，调用其 deserialize 还原。
 * 因此 Recorder 和 Replayer 必须注册相同的 types 数组。
 */
interface TrackerOptions {
  types?: CustomTypeConfig[];
}

/** replay 专用选项 */
interface ReplayOptions extends TrackerOptions {
  /** 是否原地修改 baseObject，默认 false（返回深拷贝） */
  mutate?: boolean;
}

// types 用法示例：
const dateType: CustomTypeConfig<Date> = {
  type: 'Date',
  is: (v): v is Date => v instanceof Date,
  serialize: (v) => v.toISOString(),
  deserialize: (v) => new Date(v as string),
};

const options: TrackerOptions = { types: [dateType] };
```

### API: `recordTransaction`

事务模式 — 在同步闭包内捕获对 draft 的所有修改。

```typescript
function recordTransaction<T extends object>(
  baseObject: T,
  changeFn: (draft: T) => void,
  options?: TrackerOptions
): Patch[];
```

**特性：**
- `changeFn` 接收一个深度代理的 `draft`，对其的任何写操作都会被记录
- 函数返回后，`baseObject` **不被修改**（纯记录，不产生副作用）
- 数组的 `push`/`splice`/`pop` 等变异方法会被合并为单一 `splice` Patch

**示例：**
```typescript
import { recordTransaction } from '@cmtlyt/lingshu-toolkit';

const state = { user: { name: 'init' }, tags: ['a'] };

const patches = recordTransaction(state, (draft) => {
  draft.user.name = 'Alice';
  draft.tags.push('b');
});
// patches:
// [
//   { path: ['user', 'name'], op: 'set', value: 'Alice', timestamp: ... },
//   { path: ['tags'], op: 'splice', index: 1, deleteCount: 0, items: ['b'], timestamp: ... }
// ]
```

### API: `createRecorder`

持续监听模式 — 创建长期代理，适用于异步/离散操作场景。

```typescript
interface RecorderInstance<T extends object> {
  /** 被代理的对象，直接操作即可触发记录 */
  proxy: T;
  /** 提取当前缓冲区的所有 patches 并清空 */
  flush(): Patch[];
  /** 销毁代理，释放内存 */
  dispose(): void;
}

function createRecorder<T extends object>(
  baseObject: T,
  options?: TrackerOptions
): RecorderInstance<T>;
```

**特性：**
- 返回的 `proxy` 可直接当原对象使用，所有写操作自动入缓冲区
- `flush()` 批量获取并清空，适合配合 `requestAnimationFrame` / WebSocket 发送
- `dispose()` 后再操作 `proxy` 会通过 `throwError` 报错

**示例：**
```typescript
import { createRecorder } from '@cmtlyt/lingshu-toolkit';

const recorder = createRecorder(state, {
  types: [
    {
      type: 'Date',
      is: (v): v is Date => v instanceof Date,
      serialize: (v) => v.toISOString(),
      deserialize: (v) => new Date(v as string),
    },
  ],
});

recorder.proxy.user.name = 'Bob';
recorder.proxy.tags.push('vip');

const patches = recorder.flush(); // 获取变更，清空缓冲区
```

### API: `replay`

将 Patch 列表应用于目标对象。

```typescript
function replay<T extends object>(
  baseObject: T,
  patchList: Patch[],
  options?: ReplayOptions
): T;
```

**特性：**
- `mutate: false`（默认）返回深拷贝后的新对象，`baseObject` 不受影响
- `mutate: true` 原地修改并返回 `baseObject` 引用
- `options.types` 必须与 Recorder 端保持对称，否则自定义类型无法恢复
- Patch 按 `timestamp` 升序应用；相同 timestamp 保持数组顺序

**示例：**
```typescript
import { replay } from '@cmtlyt/lingshu-toolkit';

const newState = replay(initialState, receivedPatches, {
  mutate: false,
  types: [dateType], // 必须与 Recorder 端保持一致
});
```

## 实现要点

### 深度代理（Lazy Proxy）

递归创建 Proxy，对嵌套对象懒代理（首次访问时才创建子 Proxy），避免一次性代理整棵对象树：

```text
get(target, prop) →
  if target[prop] is object && not yet proxied →
    create child proxy with path [...parentPath, prop]
    cache and return child proxy
  else →
    return raw value
```

### 数组变异方法拦截

拦截数组原型方法（`push`/`pop`/`shift`/`unshift`/`splice`），合并为单一 `splice` Patch，避免产生大量碎片化的 index set + length set：

```text
arr.push('x', 'y')
→ Patch { op: 'splice', path: ['tags'], index: arr.length, deleteCount: 0, items: ['x', 'y'] }
```

### 路径追踪

每个子 Proxy 通过闭包持有自己的路径前缀，`set`/`deleteProperty` trap 触发时拼接完整路径写入 Patch。

### replay 类型查找优化

`replay` 初始化时将 `types` 数组转为 `Map<string, CustomTypeConfig>`（key 为 `config.type`），后续按 `Patch.type` 直接 O(1) 查找，避免每个 Patch 都遍历数组。

### 报错规范

所有异常使用 `shared/throw-error` 模块的 `throwError` 函数，不直接 `throw new Error`。

## 使用示例

### 基础用法：recordTransaction

```ts
import { recordTransaction } from '@cmtlyt/lingshu-toolkit/shared'

const state = { user: { name: 'init' }, tags: ['a'] }

const patches = recordTransaction(state, (draft) => {
  draft.user.name = 'Alice'
  draft.tags.push('b')
})
// state 未被修改
// patches: [
//   { path: ['user', 'name'], op: 'set', value: 'Alice', timestamp: ... },
//   { path: ['tags'], op: 'splice', index: 1, deleteCount: 0, items: ['b'], timestamp: ... }
// ]
```

### 持续监听：createRecorder + flush

```ts
import { createRecorder } from '@cmtlyt/lingshu-toolkit/shared'

const recorder = createRecorder({ user: { name: 'init' }, tags: ['a'] })

recorder.proxy.user.name = 'Bob'
recorder.proxy.tags.push('vip')

const patches = recorder.flush() // 获取变更，清空缓冲区
// 可发送 patches 到远端

recorder.dispose() // 释放资源
```

### 重放：replay

```ts
import { replay } from '@cmtlyt/lingshu-toolkit/shared'

const newState = replay(initialState, receivedPatches, {
  mutate: false,
  types: [dateType],
})
// initialState 未被修改，newState 是应用 patches 后的新对象
```

### 自定义类型：Date 序列化

```ts
import { createRecorder, replay } from '@cmtlyt/lingshu-toolkit/shared'

const dateType = {
  type: 'Date',
  is: (v): v is Date => v instanceof Date,
  serialize: (v) => v.toISOString(),
  deserialize: (v) => new Date(v as string),
}

const recorder = createRecorder({ createdAt: new Date() }, { types: [dateType] })
recorder.proxy.createdAt = new Date('2026-01-01')

const patches = recorder.flush()
// patches[0].type === 'Date', patches[0].value === '2026-01-01T00:00:00.000Z'

const restored = replay({ createdAt: new Date() }, patches, { types: [dateType] })
// restored.createdAt instanceof Date === true
```

## 后续规划（本期不做）

以下特性作为后续版本的扩展方向，本期不实现：

- **undo/redo**：基于 Patch 列表实现撤销/重做，需要 inverse patch 计算
- **冲突合并**：OT/CRDT 等协同算法，需要 Patch 的 transform 操作
- **React/Vue 集成**：提供 `useChangeTracker` hook，自动触发重渲染

---

## 评审通过记录

**Accepted on 2026/06/10**

- **评审版本**：0.1.0
- **评审通过方**：@cmtlyt（仓库所有者 / RFC 作者）
- **后续动作**：进入实施阶段，详见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)

