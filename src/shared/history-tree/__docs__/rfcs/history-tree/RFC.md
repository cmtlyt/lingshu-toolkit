# RFC: historyTree — 树状历史记录管理器

> status: accepted
>
> author: cmtlyt
>
> create time: 2026/06/08 12:09:00
>
> rfc version: 0.2.0
>
> scope: `src/shared/history-tree`

## 版本历史

| 版本 | 日期 | 变更摘要 |
| --- | --- | --- |
| 0.1.0 | 2026/06/08 | 初稿：树状历史记录数据结构、全量/差异存储、分支切换与创建、路径回溯 API |
| 0.2.0 | 2026/06/08 | 新增 `getSnapshot()` 获取整棵树快照、`onChange(listener)` 变更监听、`HistoryTreeSnapshot<T>` 类型 |

## 背景与动机

在编辑器、画布工具、表单流程等场景中，"撤销/重做"是基础能力。传统的线性 undo/redo 栈在面对**分支操作**时力不从心——用户回退到某个历史节点后做出新修改，旧的 redo 栈会被丢弃，丢失了完整的操作历史。

树状历史记录（History Tree）将每次操作视为树上的一个节点，回退到任意节点后提交新数据会创建新的分支，所有历史路径永不丢失。这在以下场景中非常有价值：

- **编辑器**：文档编辑的多分支探索，保留所有尝试
- **画布/设计工具**：设计方案的分支管理，A/B 对比
- **状态管理**：应用状态的时间旅行调试，分支快照
- **游戏存档**：多条故事线的存档管理

本 RFC 的目标：**提供一个与框架无关的树状历史记录数据结构 `createHistoryTree`**，提供分支创建、节点切换、路径回溯等核心能力。框架只管存取，不区分全量/差异——存什么完全由调用方 `commit` 的内容决定。

## 目标与非目标

### 目标

- 提供 `createHistoryTree<T>(options)` 单入口，通过泛型 `T` 约束每个节点的存储空间类型
- 框架不区分全量/差异存储，每个节点原样保存 `commit` 传入的数据，存什么取什么
- 支持**切换到任意节点**并基于该节点提交新数据创建新分支
- 提供**路径回溯**方法：获取当前节点到根节点路径上的所有存储数据（返回有序列表，不合并）
- 每个节点维护树结构关系（parent / children）
- 提供节点的唯一标识（自动生成）

### 非目标

- **不**实现数据的自动合并（diff/patch/merge），不区分全量/差异存储
- **不**实现持久化（序列化/反序列化留给调用方或后续扩展）
- **不**实现并发安全（单线程使用场景）
- **不**实现复杂事件系统（仅提供 `onChange` 监听变更，不区分 commit/checkout 等具体事件类型）
- **不**限制树的深度或分支数量

## 名词约定

| 名词 | 含义 |
| --- | --- |
| HistoryTree（历史树） | 整棵树的管理器实例，维护所有节点和当前指针 |
| Node（节点） | 树上的一个版本记录点，持有存储数据和树结构关系 |
| Storage / Data（存储空间） | 每个节点关联的用户数据，类型由泛型 `T` 约束 |
| Current（当前节点） | 树的活跃指针，新提交的数据会作为当前节点的子节点 |
| Branch（分支） | 从某个非叶子节点的子节点开始的一条路径；切换到已有节点再提交即创建分支 |
| Path（路径） | 从当前节点沿 parent 链回溯到根节点的有序节点序列 |

## API 设计

### 入口函数

```ts
function createHistoryTree<T>(options: HistoryTreeOptions<T>): HistoryTree<T>
```

### 配置项

```ts
interface HistoryTreeOptions<T> {
  /** 初始数据，将作为根节点（v0）的存储数据 */
  initialData: T

  /**
   * 自定义节点 id 生成函数
   * 每次创建新节点时调用，返回值作为节点 id
   * 调用方需自行保证返回值的唯一性
   *
   * @default 内置自增数字转字符串（"0", "1", "2", ...）
   */
  generateId?: () => string
}
```

### 返回值：HistoryTree

```ts
interface HistoryTree<T> {
  /**
   * 提交新数据，在当前节点下创建子节点，并将指针移到新节点
   * 框架原样存储 data，不做任何处理
   *
   * @returns 新创建的节点 id
   */
  commit(data: T): string

  /**
   * 切换当前指针到指定节点
   * 切换后可继续 commit 创建新分支
   *
   * @throws 节点不存在时抛出错误
   */
  checkout(nodeId: string): void

  /**
   * 获取当前节点到根节点路径上所有节点的存储数据
   * 返回有序列表：[当前节点数据, 父节点数据, ..., 根节点数据]
   */
  getPathData(): T[]

  /**
   * 获取当前节点信息
   */
  getCurrentNode(): HistoryNodeInfo<T>

  /**
   * 获取指定节点信息
   *
   * @throws 节点不存在时抛出错误
   */
  getNode(nodeId: string): HistoryNodeInfo<T>

  /**
   * 获取根节点信息
   */
  getRoot(): HistoryNodeInfo<T>

  /**
   * 获取整棵树的快照，包含所有节点信息、根节点 id 和当前节点 id
   */
  getSnapshot(): HistoryTreeSnapshot<T>

  /**
   * 注册变更监听器，当 commit / checkout 导致树状态变化时触发
   * 回调参数为最新的快照
   *
   * @returns 取消订阅函数
   */
  onChange(listener: (snapshot: HistoryTreeSnapshot<T>) => void): () => void

  /**
   * 获取当前节点的 id
   */
  readonly currentId: string

  /**
   * 获取当前节点的存储数据（getter）
   * 每次访问返回当前指针所指节点的 data
   */
  get currentData(): T

  /**
   * 获取当前节点的父节点存储数据（getter）
   * 根节点无父节点时返回 null
   */
  get parentData(): T | null

  /**
   * 获取树中所有节点的数量（getter，代理内部 nodes Map 的 size）
   */
  get size(): number
}
```

### 节点信息

```ts
interface HistoryNodeInfo<T> {
  /** 节点唯一标识 */
  readonly id: string

  /** 节点存储的数据 */
  readonly data: T

  /** 父节点 id，根节点为 null */
  readonly parentId: string | null

  /** 子节点 id 列表 */
  readonly childrenIds: readonly string[]
}
```

### 树快照

```ts
interface HistoryTreeSnapshot<T> {
  /** 根节点 id */
  readonly rootId: string

  /** 当前节点 id */
  readonly currentId: string

  /** 所有节点信息，key 为节点 id */
  readonly nodes: Readonly<Record<string, HistoryNodeInfo<T>>>
}
```

## 内部数据结构

### 节点

```ts
// 内部使用，不导出
interface HistoryNode<T> {
  id: string
  data: T
  parentId: string | null
  childrenIds: string[]
}
```

### 树

内部使用一个 `Map<string, HistoryNode<T>>` 存储所有节点，配合 `currentId` 和 `rootId` 指针。

```ts
// 内部状态
{
  nodes: Map<string, HistoryNode<T>>
  rootId: string
  currentId: string
  generateId: () => string  // id 生成函数（默认为内置自增策略）
}
```

### ID 生成策略

**默认策略**：自增数字转字符串 `"0"`, `"1"`, `"2"`, ...

- 根节点 id 为 `"0"`（第一个生成的 id）
- 简单可预测，便于调试
- 内部自增计数器保证唯一性

**自定义策略**：通过 `options.generateId` 传入自定义 id 生成函数，每次创建节点时调用。调用方需自行保证唯一性，若生成了重复 id 将抛出错误。

```ts
// 使用 UUID 作为节点 id
const tree = createHistoryTree({
  initialData: { x: 0 },
  generateId: () => crypto.randomUUID(),
})
```

## 分支创建语义

结合用户提供的示例说明分支创建的完整流程：

```text
v0 ──→ v1 ──┬──→ v2 ──→ v6
             │
             └──→ v3 ──┬──→ v4 ──┬──→ v5
                        │         │
                        │         └──→ v8 ──→ v9
                        │
                        └──→ v7
```

- v1 有两个子节点：v2、v3
- v3 有两个子节点：v4、v7
- v4 有两个子节点：v5、v8

对应操作序列：

```ts
const tree = createHistoryTree({ initialData: d0 })
// 树：v0（current）

tree.commit(d1)   // v0 → v1（current）
tree.commit(d2)   // v1 → v2（current）

tree.checkout("1") // 切换到 v1
tree.commit(d3)    // v1 → v3（current），v1 现在有两个子节点 [v2, v3]

tree.commit(d4)    // v3 → v4（current）
tree.commit(d5)    // v4 → v5（current）

tree.checkout("2") // 切换到 v2
tree.commit(d6)    // v2 → v6（current）

tree.checkout("3") // 切换到 v3
tree.commit(d7)    // v3 → v7（current），v3 现在有两个子节点 [v4, v7]

tree.checkout("4") // 切换到 v4
tree.commit(d8)    // v4 → v8（current），v4 现在有两个子节点 [v5, v8]
tree.commit(d9)    // v8 → v9（current）
```

### 路径回溯示例

```ts
// 当前在 v9
tree.getPathData()
// 返回：[d9, d8, d4, d3, d1, d0]
// 即：v9 → v8 → v4 → v3 → v1 → v0 路径上的所有数据

tree.checkout("6")
tree.getPathData()
// 返回：[d6, d2, d1, d0]
// 即：v6 → v2 → v1 → v0
```


## 错误处理

遵循项目规范，所有错误通过 `shared/throw-error` 模块导出的 `throwError` 函数抛出，`fnName` 统一为 `"history-tree"`。

> **基础设施约定**：`throwError(fnName, message, ErrorClass?, options?)` 会自动拼接前缀 `[@cmtlyt/lingshu-toolkit#${fnName}]: ${message}`，调用方只需传入 `fnName` 与裸消息体。

| 错误场景 | 调用方式 | 实际错误信息 |
| --- | --- | --- |
| `checkout` 时节点不存在 | `throwError('history-tree', 'Node "${nodeId}" does not exist')` | `[@cmtlyt/lingshu-toolkit#history-tree]: Node "xxx" does not exist` |
| `getNode` 时节点不存在 | `throwError('history-tree', 'Node "${nodeId}" does not exist')` | `[@cmtlyt/lingshu-toolkit#history-tree]: Node "xxx" does not exist` |
| `generateId` 返回重复 id | `throwError('history-tree', 'Duplicate node id "${id}"')` | `[@cmtlyt/lingshu-toolkit#history-tree]: Duplicate node id "xxx"` |

## 目录与文件规划

```text
src/shared/history-tree/
├── RFC.md              # 本文档
├── index.ts            # 入口：导出 createHistoryTree
├── types.ts            # 类型定义
├── core.ts             # 核心实现
├── index.mdx           # 文档页（Rspress）
└── __test__/
    └── history-tree.test.ts  # 单元测试
```

## 测试策略

### 核心场景覆盖

1. **基础提交**：创建树 → 连续 commit → 验证节点关系和数据
2. **分支创建**：checkout 到中间节点 → commit → 验证分支结构
3. **复杂分支**：还原用户示例中的完整分支拓扑（v0~v9），验证所有节点关系
4. **路径回溯**：在不同节点调用 `getPathData()`，验证返回的有序列表
5. **节点查询**：`getCurrentNode` / `getNode` / `getRoot` 的正确性
6. **错误处理**：checkout / getNode 不存在的节点 → 抛错
7. **size 计数**：commit 后 size 正确递增
8. **currentData**：验证 getter 在 commit / checkout 后正确更新
9. **parentData**：验证 getter 返回父节点数据，根节点返回 null
10. **自定义 id 生成**：传入 `generateId`，验证节点使用自定义 id
11. **重复 id 检测**：`generateId` 返回重复 id 时抛错
12. **边界情况**：只有根节点时的 `getPathData`、checkout 到当前节点（无操作）
13. **getSnapshot**：返回包含所有节点的快照、快照为独立副本不影响原树
14. **onChange - commit 触发**：commit 后监听器收到最新快照
15. **onChange - checkout 触发**：checkout 后监听器收到最新快照
16. **onChange - 多监听器**：注册多个 listener 均被通知
17. **onChange - 取消订阅**：调用 unsubscribe 后不再触发回调

## 使用示例

### 基础用法

```ts
import { createHistoryTree } from '@cmtlyt/lingshu-toolkit/shared'

interface DocState {
  title: string
  content: string
}

const tree = createHistoryTree<DocState>({
  initialData: { title: 'Untitled', content: '' },
})

// 提交修改
tree.commit({ title: 'My Doc', content: 'Hello' })
tree.commit({ title: 'My Doc', content: 'Hello World' })

// 回退到第一个版本，创建新分支
tree.checkout(tree.getRoot().childrenIds[0]) // 切换到 v1
tree.commit({ title: 'My Doc (branch)', content: 'Alternative content' })

// 获取当前路径上的所有数据
const pathData = tree.getPathData()
// [
//   { title: 'My Doc (branch)', content: 'Alternative content' },
//   { title: 'My Doc', content: 'Hello' },
//   { title: 'Untitled', content: '' },
// ]
```

### 差异存储用法

框架不区分全量/差异——调用方自行决定 commit 全量快照还是差量补丁。

```ts
import { createHistoryTree } from '@cmtlyt/lingshu-toolkit/shared'

// 调用方自定义差量类型
interface CanvasDiff {
  x?: number
  y?: number
  width?: number
  height?: number
}

const tree = createHistoryTree<CanvasDiff>({
  initialData: { x: 0, y: 0, width: 100, height: 100 },
})

tree.commit({ x: 50 })             // 仅记录 x 变更
tree.commit({ y: 80, width: 200 }) // 仅记录 y 和 width 变更

// 获取路径上所有数据
const changes = tree.getPathData()
// [
//   { y: 80, width: 200 },                        // v2
//   { x: 50 },                                     // v1
//   { x: 0, y: 0, width: 100, height: 100 },      // v0
// ]
// 调用方自行决定如何合并/还原
```

## 开放问题

- 是否需要提供 `dispose()` 方法释放所有节点数据？（当前倾向不加，GC 自动回收即可）
- 是否需要提供 `toJSON()` / `fromJSON()` 序列化能力？（当前倾向作为后续扩展）
- 是否需要提供遍历树的迭代器或 visitor 模式？（当前倾向不加，保持核心精简）
