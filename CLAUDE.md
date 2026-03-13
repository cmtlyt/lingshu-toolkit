# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

lingshu-toolkit 是一个多框架 Hook/工具库，同时支持 npm 包和 shadcn registry 安装方式。当前支持 React 和 Vue 框架，以及框架无关的 shared 工具函数。

## 常用命令

```bash
pnpm run build              # 构建库（Rslib）
pnpm run check              # Biome 代码检查 + 格式化（自动修复）
pnpm run format             # 仅格式化
pnpm run test:lib           # 库代码测试（带 UI，速度快）
pnpm run test:lib:ci        # 库代码 CI 测试
pnpm test                   # 全量测试（带 UI + 覆盖率）
pnpm test:ci                # 全量 CI 测试
pnpm run dev:docs           # 文档开发服务器（Rspress）
pnpm run script:gen-file    # 根据 meta 自动生成文件结构和导出
```

首次运行浏览器测试前需要：`pnpm exec playwright install`

## 架构

### 源码组织

```
src/
├── react/          # React Hooks（useBoolean, useToggle, useCounter 等）
├── vue/            # Vue Hooks（useTitle）
├── shared/         # 框架无关工具（animation, dataHandler, throwError 等）
└── test/           # 测试工具（ErrorBoundary, sleep 等）
```

每个工具/hook 是独立目录，包含 `index.ts`（实现）、`index.test.ts`（测试）、`index.mdx`（文档）。

### 元数据驱动生成

`meta/toolkit.meta.json` 是所有工具/hook 的注册中心。新增工具时：
1. 在 meta 文件中添加条目
2. 运行 `pnpm run script:gen-file` 自动生成目录结构、导出文件、文档索引、shadcn 配置、package.json exports

### 构建产物

Rslib 生成两种产物：无打包产物（按模块分离）和打包产物（npm/shadcn 用）。shadcn registry 通过 `@cmtlyt/unplugin-shadcn-registry-generate` 插件自动生成。

## 测试

- 框架：Vitest + Playwright 浏览器测试
- **覆盖率要求 100%**（lines/functions/branches/statements）
- 测试文件命名：
  - `index.test.ts` — 通用环境
  - `index.browser.test.ts` — 需要浏览器 API 的测试（localStorage 等）
  - `index.test-d.ts` — 类型检查测试
- React hook 测试用 `vitest-browser-react` 的 `renderHook`
- Vue hook 测试用 `vitest-browser-vue` 的 `renderHook`

## 代码规范

- Biome 检查（行宽 120，单引号，2 空格缩进）
- 导入使用 `@/` 别名（如 `@/shared/data-handler`）
- 文件名 kebab-case，Hook 用 `use` 前缀
- Conventional Commits：`feat(react): 新增 useExample hook`

## Git Hooks

- **pre-commit**：lint-staged（暂存的 `.ts` 文件执行 check）+ 运行测试
- **commit-msg**：commitlint 验证格式
