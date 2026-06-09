# RFC 与实施清单文档规范

## 目录结构

RFC 和实施清单放在对应工具的 `__docs__/rfcs/<编号-功能>/` 目录下，每个功能/特性一个独立目录，按递归编号排序：

```
src/{namespace}/{tool-name}/
├── __docs__/
│   └── rfcs/
│       ├── 01-{feature-a}/     # 功能 A 的 RFC
│       │   ├── RFC.md
│       │   └── IMPLEMENTATION.md
│       └── 02-{feature-b}/     # 功能 B 的 RFC
│           ├── RFC.md
│           └── IMPLEMENTATION.md
├── index.ts
├── index.node.test.ts
└── index.mdx
```

## 命名规则

- **功能目录名**：`{编号}-{kebab-case功能名}`，编号从 `01` 起递增，描述该 RFC 的功能/特性（如 `01-state-machine`、`02-refactor-modules`、`03-hsm-support`）
- **编号递增规则**：新建 RFC 时，取当前同级 rfcs 目录下最大编号 +1，保持两位数零填充（01、02、…、99）
- **RFC 文件**：固定命名 `RFC.md`
- **实施清单**：固定命名 `IMPLEMENTATION.md`
- **每个功能独立目录**：不同功能的 RFC 不要混放在同一目录

## RFC.md 格式

```markdown
# RFC：{功能标题}

> 状态：draft | accepted | implemented | rejected
> 作者：{author}
> 日期：YYYY/MM/DD
> 关联：[RFC.md](../other-feature/RFC.md)（如有）

## 背景
## 目标
## 方案设计
## 约束
```

## IMPLEMENTATION.md 格式

```markdown
# 实施清单：{功能标题}

> 关联 RFC：[RFC.md](./RFC.md)（版本, 状态）
> 源码：[index.ts](../../../index.ts)
> 状态：⬜ 未开始 | 🔄 进行中 | ✅ 全部完成（日期）

## Phase N：{阶段名}

- [ ] N.1 具体任务项
- [ ] N.2 具体任务项
```

完成后将 `- [ ]` 改为 `- [x]`，并更新顶部状态。

## 大型 RFC 拆分（子 RFC）

当一个 RFC 涉及多个子功能时，可在同一功能目录下创建主 RFC + 多个子 RFC：

```
src/{namespace}/{tool-name}/
├── __docs__/
│   └── rfcs/
│       └── 01-{feature}/
│           ├── RFC.md                  # 主 RFC（索引 + 修订记录 + 子 RFC 状态）
│           ├── IMPLEMENTATION.md       # 主实施清单
│           ├── RFC-{sub-feature-a}.md  # 子 RFC A
│           └── RFC-{sub-feature-b}.md  # 子 RFC B
```

### 主 RFC 职责

主 RFC 必须包含以下额外章节：

```markdown
## 子 RFC 索引

| 子 RFC | 状态 | 描述 |
|--------|------|------|
| [RFC-sub-a.md](./RFC-sub-a.md) | accepted | 子功能 A 说明 |
| [RFC-sub-b.md](./RFC-sub-b.md) | draft | 子功能 B 说明 |

## 修订记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| YYYY/MM/DD | v0.2.0 | 拆分子 RFC-sub-a |
| YYYY/MM/DD | v0.1.0 | 初始草稿 |
```

### 子 RFC 命名

- 文件名：`RFC-{sub-feature}.md`（kebab-case）
- 子 RFC 头部必须关联主 RFC：`> 关联主 RFC：[RFC.md](./RFC.md)`

### 拆分时机与策略

**🚨 当单个 RFC 文件超过 800 行时，必须主动拆分。**

拆分原则：
1. **按功能模块拆分**：每个子 RFC 对应一个独立的功能模块或子系统
2. **禁止为拆分而拆分**：拆分后的每个子 RFC 必须是一个完整的、可独立理解的功能单元
3. **⚠️ 如果功能模块本身已不可再拆，且单个子 RFC 仍超过 800 行**：必须主动警告用户 —— "该功能模块过于复杂，建议考虑架构调整，或按功能模块的子实现步骤进一步拆分"

## 关键规则

1. **一个功能一个目录**：初始实现、重构、新特性等不同 RFC 各自独立目录
2. **不要在工具根目录放 RFC**：必须放在 `__docs__/rfcs/{功能}/` 下
3. **实施清单与 RFC 同目录**：`IMPLEMENTATION.md` 和 `RFC.md` 始终在同一功能目录
4. **实施完成后同步更新**：任务完成后及时将 `- [ ]` 标记为 `- [x]`，更新顶部状态
5. **大型 RFC 必须拆分**：超过 800 行时按功能模块拆为子 RFC，主 RFC 维护索引、状态和修订记录
6. **不可拆分时主动警告**：功能模块复杂且无法再拆时，提醒用户考虑架构调整
