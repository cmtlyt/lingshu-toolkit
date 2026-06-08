# history-tree 实施清单

> 基于 RFC v0.1.0（accepted）

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 类型定义：`HistoryTreeOptions<T>`、`HistoryTree<T>`、`HistoryNodeInfo<T>` |
| `core.ts` | 核心实现：`createHistoryTree` 函数 |
| `index.ts` | 入口：re-export `createHistoryTree` 及类型 |
| `__test__/history-tree.test.ts` | 单元测试：覆盖 12 个场景 |

## 实施步骤

### 1. types.ts — 类型定义

导出以下类型：

```ts
HistoryTreeOptions<T> {
  initialData: T
  generateId?: () => string
}

HistoryNodeInfo<T> {
  readonly id: string
  readonly data: T
  readonly parentId: string | null
  readonly childrenIds: readonly string[]
}

HistoryTree<T> {
  commit(data: T): string
  checkout(nodeId: string): void
  getPathData(): T[]
  getCurrentNode(): HistoryNodeInfo<T>
  getNode(nodeId: string): HistoryNodeInfo<T>
  getRoot(): HistoryNodeInfo<T>
  readonly currentId: string
  get currentData(): T
  get parentData(): T | null
  get size(): number
}
```

### 2. core.ts — 核心实现

内部数据结构：

- `nodes: Map<string, HistoryNode<T>>` — 存储所有节点
- `rootId: string` — 根节点 id
- `currentId: string` — 当前指针
- `generateId: () => string` — id 生成函数

内部节点类型（不导出）：

```ts
interface HistoryNode<T> {
  id: string
  data: T
  parentId: string | null
  childrenIds: string[]
}
```

实现要点：

- **默认 id 生成**：闭包内自增计数器 `let counter = 0`，返回 `String(counter++)`
- **初始化**：创建根节点（调用 `generateId` 获取 id），存入 Map，`rootId = currentId = id`
- **`commit(data)`**：调用 `generateId` → 检查重复 → 创建子节点 → 添加到父节点 `childrenIds` → 更新 `currentId` → 返回新 id
- **`checkout(nodeId)`**：检查节点存在 → 更新 `currentId`
- **`getPathData()`**：从 `currentId` 沿 `parentId` 回溯到根，收集每个节点的 `data` 到数组
- **`getCurrentNode()` / `getNode(nodeId)` / `getRoot()`**：从 Map 取节点，转为 `HistoryNodeInfo`（`childrenIds` 转为 `readonly` 副本）
- **`currentId`**：直接返回内部 `currentId`
- **`currentData` getter**：取 `nodes.get(currentId).data`
- **`parentData` getter**：取当前节点的 `parentId`，为 `null` 返回 `null`，否则取父节点 `data`
- **`size` getter**：返回 `nodes.size`
- **错误处理**：使用 `throwError('history-tree', ...)` — 来自 `shared/throw-error`

### 3. index.ts — 入口

- re-export `createHistoryTree` from `./core`
- re-export 类型 `HistoryTreeOptions`、`HistoryTree`、`HistoryNodeInfo` from `./types`

### 4. __test__/history-tree.test.ts — 测试用例

| # | 场景 | 验证点 |
| --- | --- | --- |
| 1 | 基础提交 | 创建树 → 连续 commit → 验证节点 parent/children 关系和 data |
| 2 | 分支创建 | checkout 到中间节点 → commit → 父节点 childrenIds 包含多个子节点 |
| 3 | 复杂分支 | 还原 RFC 中的 v0~v9 拓扑 → 验证所有节点关系 |
| 4 | 路径回溯 | 在不同节点调用 getPathData()，验证有序列表 |
| 5 | 节点查询 | getCurrentNode / getNode / getRoot 返回正确信息 |
| 6 | 错误处理 | checkout / getNode 不存在的节点 → 抛错并匹配错误信息 |
| 7 | size 计数 | commit 后 size 正确递增 |
| 8 | currentData | getter 在 commit / checkout 后正确更新 |
| 9 | parentData | getter 返回父节点数据，根节点返回 null |
| 10 | 自定义 id | 传入 generateId，验证节点使用自定义 id |
| 11 | 重复 id | generateId 返回重复 id 时抛错 |
| 12 | 边界情况 | 只有根节点时的 getPathData（只含一个元素）、checkout 到当前节点（无异常） |

## 依赖

- `shared/throw-error`：`throwError` 函数

## 执行顺序

1. types.ts
2. core.ts
3. index.ts
4. __test__/history-tree.test.ts
5. 运行 `pnpm run check` + `pnpm run test:ci` 验证
