---
name: lingshu-rfc
description: "RFC and documentation directory structure conventions for lingshu-toolkit. Guides placement of RFC documents, implementation checklists, user-facing docs (.mdx), and __docs__ directory organization. Use when user asks to create RFC, write implementation plan, organize module documentation, set up __docs__ directory, add sub-RFC for a feature, or structure documentation for complex modules. Triggers: 'create RFC', 'write RFC', 'RFC structure', 'documentation directory', '__docs__', 'IMPLEMENTATION.md', 'module docs', 'doc structure', 'rfc directory', 'sub-RFC', 'documentation organization', '文档目录', '文档结构', 'RFC 规范', '实施清单'."
---

# Lingshu RFC & Documentation Directory Conventions

IRON LAW: **RFC 和文档必须就近存放于模块目录内，禁止放到 `tools/fixed` 或其他外部目录。** 文档组织方式取决于模块复杂度——简单模块直接放模块根目录，复杂模块使用 `__docs__/` 子目录。

## 判断标准：何时使用 `__docs__/` 目录

| 场景 | 文档存放方式 |
|------|-------------|
| 简单模块（单篇 RFC + 单篇实施清单） | 直接放模块根目录：`src/{ns}/{tool}/RFC.md`、`IMPLEMENTATION.md` |
| 复杂模块（多个子系统、多篇 RFC、拆分文档页） | 使用 `__docs__/` 目录集中管理 |

## 目录结构规范

### 简单模块（参考 `lock-data`、`rtc-controller`）

```
src/shared/{tool-name}/
├── index.ts
├── index.mdx            # 用户文档主入口（由 gen-file 生成）
├── RFC.md               # 设计方案
├── IMPLEMENTATION.md    # 实施清单
└── __test__/            # 测试目录
```

### 复杂模块（参考 `rtc-room`）

```
src/shared/{tool-name}/
├── index.ts
├── __docs__/
│   ├── index.mdx                    # 用户文档主入口
│   ├── rfc/
│   │   ├── base/                    # 核心功能 RFC
│   │   │   ├── RFC.md
│   │   │   └── IMPLEMENTATION.md
│   │   └── {subsystem}/             # 子系统 RFC（按功能域命名）
│   │       ├── RFC.md               # 子系统主 RFC
│   │       ├── RFC-{feature}.md     # 子系统内的专项 RFC
│   │       └── IMPLEMENTATION.md    # （可选）子系统实施清单
│   └── ...                          # 其他拆分文档页（.mdx）
└── __test__/
```

### 拆分子文档页（参考 `api-controller`）

当模块有多个独立使用场景需要分页展示时：

```
src/shared/{tool-name}/
├── __docs__/
│   ├── best-practices.mdx
│   ├── create-api.mdx
│   ├── data-transform.mdx
│   └── url-params.mdx
└── ...
```

## RFC 文档格式规范

### 头部元信息（必须）

**主 RFC（`RFC.md`）** 包含完整元信息：

```markdown
# RFC: {模块名} {简短标题}

> status: draft | accepted | implemented | deprecated
>
> author: {作者}
>
> create time: {YYYY/MM/DD HH:mm:ss}
>
> rfc version: {语义化版本}
>
> scope: `src/{namespace}/{tool-name}`
```

### 子 RFC 头部（精简）

**子 RFC（`RFC-{feature}.md`）不独立维护 status / author / create time / rfc version / 版本历史**，这些信息全部由主 RFC 统一管理。子 RFC 头部仅保留：

```markdown
# RFC: {模块名} {简短标题}

> scope: `src/{namespace}/{tool-name}/{sub-scope}`
>
> parent: [RFC.md](./RFC.md)（版本与状态由主文档统一管理）
```

如有跨文档依赖，追加依赖声明：

```markdown
> 依赖: [RFC-xxx.md](./RFC-xxx.md)（说明关系）
```

### 主 RFC 的模块索引表（集中管理子文档状态）

当主 RFC 拆分为多个子文档时，**模块索引表必须包含 status 列**，作为各子文档状态的唯一管理点：

```markdown
## 模块索引

| 子文档 | status | 内容 |
|--------|--------|------|
| [RFC-core.md](./RFC-core.md) | draft | **核心架构** — ... |
| [RFC-roles.md](./RFC-roles.md) | draft | **角色管理** — ... |
```

子文档状态变更时，仅需修改主 RFC 的索引表，无需逐个打开子文件修改头部。

### 版本历史表（推荐，仅在主 RFC 中维护）

版本历史表**仅存在于主 RFC（`RFC.md`）中**，子 RFC 不独立维护版本历史。所有子文档的变更均记录在主 RFC 的版本历史表中。

```markdown
## 版本历史

| 版本 | 日期 | 变更摘要 |
|------|------|----------|
| 0.1.0 | 2026/05/12 | 初稿：... |
```

### 标准章节结构

1. **背景与动机** — 为什么需要这个设计
2. **目标与非目标** — 明确边界
3. **设计概述 / 详细设计** — 核心方案
4. **API 设计** — 公开接口
5. **决策记录** — 关键技术决策及理由
6. **测试策略** — 如何验证
7. **目录规划** — 文件组织

## IMPLEMENTATION.md 格式规范

```markdown
# {模块名} 实施清单

> 基于 RFC.md ({版本}, {状态}) 的逐步落地计划

## 开发守则（全程生效）

{项目级约束，如测试运行约定、错误处理、代码风格等}

## Phase N — {阶段名}

- [ ] {具体任务} → RFC#{章节引用}
- [ ] {具体任务}
```

每个任务条目末尾用 `→ RFC#xxx` 标注对应 RFC 章节，方便回溯。

## 子系统目录命名规则

- 使用全小写英文，多词用连字符：`permissions/`、`media-sync/`
- 子 RFC 文件名格式：`RFC-{feature}.md`（如 `RFC-election.md`、`RFC-mute-refactor.md`）
- 主 RFC 固定命名 `RFC.md`

## Workflow

- [ ] Step 1: 判断模块复杂度
  - [ ] 单 RFC + 单实施清单 → 简单模式（根目录）
  - [ ] 多子系统 / 多 RFC / 需拆分文档页 → `__docs__/` 模式
- [ ] Step 2: 创建目录结构
- [ ] Step 3: 编写 RFC 头部元信息
- [ ] Step 4: 填充 RFC 内容（按标准章节）
- [ ] Step 5: 编写 IMPLEMENTATION.md（Phase 拆分 + 任务条目）

## Anti-Patterns

❌ RFC 放到 `tools/fixed` 或项目根目录
❌ 简单模块过度使用 `__docs__/` 增加层级
❌ RFC 文件名不规范（如 `design.md`、`plan.md`）
❌ 子 RFC 缺少 `parent` 或 `依赖` 字段标注关联关系
❌ IMPLEMENTATION.md 任务条目不引用 RFC 章节
❌ `index.mdx` 放到模块根目录同时又在 `__docs__/` 里放了一份
