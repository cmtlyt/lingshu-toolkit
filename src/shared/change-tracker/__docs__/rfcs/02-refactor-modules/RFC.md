# RFC：changeTracker — 按模块拆分重构

> status: accepted
>
> author: cmtlyt
>
> create time: 2026/06/10 12:42:00
>
> rfc version: 0.1.0
>
> scope: `src/shared/change-tracker`

## 版本历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 0.1.0 | 2026/06/10 | 初稿：将单文件拆分为 types / helpers / proxy-engine / record / replay 五个模块 |

## 背景与动机

当前 `changeTracker` 的全部实现（约 280 行）集中在单一 `index.ts` 文件中，包含类型定义、内部工具函数、Proxy 引擎、三个公开 API 及其辅助函数。随着后续功能扩展（undo/redo、批量优化、新 op 类型等），单文件会持续膨胀，阅读和维护成本上升。

按职责拆分为独立模块后：
- 每个模块职责单一，便于独立阅读和测试
- 后续新增功能（如新 op 类型）只需修改对应模块
- 降低合并冲突概率

## 目标与非目标

### 目标

- 将 `index.ts` 按职责拆分为 5 个内部模块文件
- 保持对外 API 和类型导出完全不变（零 breaking change）
- 保持现有测试全部通过，无需修改测试文件

### 非目标

- **不**新增任何功能或 API
- **不**修改任何运行时行为
- **不**调整对外导出的类型或函数签名

## 名词约定

| 名词 | 含义 |
| --- | --- |
| 入口文件 | `index.ts`，重构后仅负责 re-export |
| 内部模块 | `change-tracker/` 目录下的非 `index.ts` 文件，不被外部直接导入 |

## 方案设计

### 模块拆分方案

```text
src/shared/change-tracker/
├── types.ts          # 类型定义
├── helpers.ts        # 内部工具函数
├── proxy-engine.ts   # 深度 Proxy 引擎
├── record.ts         # recordTransaction + createRecorder
├── replay.ts         # replay 及辅助函数
├── index.ts          # 入口：re-export 公开 API 和类型
├── index.node.test.ts
└── index.mdx
```

内部模块使用行内 `export`（helper file 规范），不被外部直接导入。

### 各模块职责与导出

#### `types.ts` — 类型定义

导出所有类型，包括内部使用的 `PatchOp` 和 `PatchEmitter`：

```typescript
export type PatchOp = 'set' | 'delete' | 'splice';

export interface Patch { /* ... */ }
export interface CustomTypeConfig<T = unknown> { /* ... */ }
export interface TrackerOptions { /* ... */ }
export interface ReplayOptions extends TrackerOptions { /* ... */ }
export interface RecorderInstance<T extends object> { /* ... */ }

export type PatchEmitter = (patch: Patch) => void;
```

#### `helpers.ts` — 内部工具函数

从 `types.ts` 导入类型，导出纯函数：

```typescript
export function serializeValue(value, types): { serialized; typeName? }
export function serializeItems(items, types): { serializedItems; itemTypeName? }
export function isProxyable(value): value is object
export function deepClone<T>(value: T): T
```

#### `proxy-engine.ts` — Proxy 引擎

从 `types.ts` 和 `helpers.ts` 导入，导出代理工厂：

```typescript
export function createDeepProxy<T extends object>(target, path, emit, types): T
```

包含 `ARRAY_MUTATORS` 常量、`emitSplicePatch`、`arrayMutatorHandlers`、`createArrayMutatorTrap` 等内部实现。

#### `record.ts` — 记录 API

从 `types.ts`、`helpers.ts`、`proxy-engine.ts` 导入：

```typescript
export function recordTransaction<T extends object>(baseObject, changeFn, options?): Patch[]
export function createRecorder<T extends object>(baseObject, options?): RecorderInstance<T>
```

#### `replay.ts` — 重放 API

从 `types.ts`、`helpers.ts` 导入（不依赖 Proxy 引擎）：

```typescript
export function replay<T extends object>(baseObject, patchList, options?): T
```

包含 `resolvePathParent`、`deserializeValue`、`applyPatch` 等内部辅助函数。

#### `index.ts` — 入口文件

仅做 re-export，遵循 entry file 末尾集中 `export { xxx }` 规范：

```typescript
export type { CustomTypeConfig, Patch, RecorderInstance, ReplayOptions, TrackerOptions } from './types';
export { createRecorder, recordTransaction } from './record';
export { replay } from './replay';
```

### 模块依赖关系

```text
types.ts          ← 无依赖
helpers.ts        ← types.ts
proxy-engine.ts   ← types.ts, helpers.ts
record.ts         ← types.ts, helpers.ts, proxy-engine.ts
replay.ts         ← types.ts, helpers.ts
index.ts          ← types.ts, record.ts, replay.ts
```

依赖方向单一，无循环依赖。

## 约束

1. **对外 API 零变更**：重构后 `src/shared/index.ts` 的 re-export 不需要任何修改
2. **测试零修改**：现有 `index.node.test.ts` 的 import 路径指向 `index.ts`，重构后仍然有效
3. **内部模块命名**：非 `index.ts` 的模块文件均为内部模块，不应被外部直接导入
4. **行内 export**：内部模块文件使用行内 `export`（helper file 规范）
5. **集中 export**：入口 `index.ts` 使用末尾集中 `export`（entry file 规范）
