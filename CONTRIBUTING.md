# 贡献指南

## 环境要求

- Node.js >= 18.0.0
- pnpm（必须使用 pnpm，不支持 npm/yarn）

## 快速开始

```bash
# 1. Fork 并克隆仓库
git clone https://github.com/<your-username>/lingshu-toolkit.git
cd lingshu-toolkit

# 2. 安装依赖
pnpm install

# 3. 运行测试
pnpm test

```

## 通用规范

### 测试覆盖率要求

所有代码（包括 Hook 和 Shared 工具）的测试覆盖率必须达到 100%。

## 项目结构

```text
src/
├── react/          # React hooks
├── vue/            # Vue hooks
└── shared/         # 共享工具函数（框架无关）
```

### 当前支持的框架

React、Vue

### 新增工具或 Hook

项目使用 `meta/toolkit.meta.json` 文件管理所有工具和 hook。新增时：

1. 在 `meta/toolkit.meta.json` 中添加配置：

```json
{
  "shared": [{ "name": "yourUtil" }],
  "react": [{ "name": "useYourHook" }],
  "vue": [{ "name": "useYourHook" }]
}
```

2. 运行 `pnpm run script:gen-file` 自动生成目录结构和文件模板：
   - `index.ts` - 实现代码
   - `index.test.ts` - 测试文件
   - `index.mdx` - 文档文件

### 新增框架支持

如需新增其他框架（如 Svelte、Solid 等），需遵循以下步骤：

1. **在 meta 文件中添加新框架**

在 `meta/toolkit.meta.json` 中添加新的框架 namespace：

```json
{
  "shared": [...],
  "react": [...],
  "vue": [...],
  "svelte": [{ "name": "useExample" }]
}
```

2. **运行生成命令**

```bash
pnpm run script:gen-file
```

这会自动创建框架目录结构和文件模板。

**注意**：namespace 文档需要手动创建并在 `src/_meta.json` 中注册。

3. **构建配置**
- 在 `rslib.config.ts` 中添加对应的构建入口
- 在 `package.json` 的 `exports` 字段中添加导出路径
- 在 `peerDependencies` 中添加框架依赖

4. **测试配置**
- 安装对应的 vitest-browser 插件（如 `vitest-browser-svelte`）
- 在测试文件中使用对应的测试工具（如 `renderHook` from `vitest-browser-svelte`）

## 编写 Hook

### 代码规范

- 使用 TypeScript
- 使用 `@/` 别名导入（如 `@/react/use-toggle`）
- 确保类型推导正确

### 代码示例

```typescript
// src/react/use-example/index.ts
import { useState, useMemo } from 'react';

export function useExample(defaultValue: string) {
  const [state, setState] = useState(defaultValue);

  const actions = useMemo(() => ({
    update: (value: string) => setState(value),
    reset: () => setState(defaultValue),
  }), [defaultValue]);

  return [state, actions] as const;
}
```

### 测试规范

#### 测试内容

使用 Vitest + Playwright + vitest-browser-react/vue，必须包含：
- 导出测试
- 功能测试
- 边界测试
- 所有分支和边界情况

```typescript
// src/react/use-example/index.test.ts
import { describe, expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useExample } from './index';

describe('useExample', () => {
  test('导出测试', () => {
    expect(useExample).toBeTypeOf('function');
  });

  test('功能测试', async () => {
    const { result, act } = await renderHook(() => useExample('initial'));
    expect(result.current[0]).toBe('initial');

    act(() => {
      result.current[1].update('updated');
    });
    expect(result.current[0]).toBe('updated');
  });
});
```

### 文档规范

创建 `index.mdx` 文件，包含：
- 功能说明
- API 文档
- 使用示例

## 编写 Shared 工具

### 适用场景

Shared 包用于框架无关的工具函数，满足以下条件：
- 不依赖任何框架（React、Vue 等）
- 可在 Node.js 和浏览器环境运行
- 纯函数或通用工具类

### 代码规范

```typescript
// src/shared/example-util/index.ts
export function exampleUtil(input: string): string {
  return input.toUpperCase();
}
```

### 测试规范

#### 测试文件命名

Shared 工具需要根据运行环境选择测试文件后缀：

- 通用环境（Node.js + 浏览器）：`index.test.ts`
- 仅浏览器环境：`index.browser.test.ts` 或 `index.browser.test.tsx`

**注意**：如果工具函数依赖浏览器 API（如 `window`、`document`、`localStorage` 等），必须使用 `.browser.ts` 后缀，这样测试会在浏览器环境中运行。

#### 测试示例

**通用环境测试**

Shared 包使用 Vitest（非浏览器模式）测试：

```typescript
// src/shared/example-util/index.test.ts
import { describe, expect, test } from 'vitest';
import { exampleUtil } from './index';

describe('exampleUtil', () => {
  test('导出测试', () => {
    expect(exampleUtil).toBeTypeOf('function');
  });

  test('功能测试', () => {
    expect(exampleUtil('hello')).toBe('HELLO');
  });

  test('边界测试', () => {
    expect(exampleUtil('')).toBe('');
  });
});
```

**浏览器环境测试**

如果工具依赖浏览器 API，使用 `.browser.ts` 后缀：

```typescript
// src/shared/browser-util/index.test.browser.ts
import { describe, expect, test } from 'vitest';
import { getLocalStorage } from './index';

describe('getLocalStorage', () => {
  test('导出测试', () => {
    expect(getLocalStorage).toBeTypeOf('function');
  });

  test('功能测试', () => {
    localStorage.setItem('test', 'value');
    expect(getLocalStorage('test')).toBe('value');
  });
});
```

#### 运行测试

```bash
pnpm run test:lib      # 开发模式
pnpm run test:lib:ci   # CI 模式
```

## Shadcn 支持

项目同时支持 npm 包和 shadcn 安装方式，提供更好的定制化能力。

### 配置 Shadcn Registry

在 `meta/toolkit.meta.json` 中注册 hook 后，运行 `pnpm run script:gen-file` 会自动更新 `shadcn-exports.json`。

**自动生成的命名规范**：
- React hooks: `reactUseExample`（对应 meta 中的 `react.useExample`）
- Vue hooks: `vueUseExample`（对应 meta 中的 `vue.useExample`）
- Shared 工具: `sharedExampleUtil`（对应 meta 中的 `shared.exampleUtil`）

无需手动编辑 `shadcn-exports.json`，命名会根据 meta 配置自动生成。

### 测试 Shadcn Registry

1. 构建文档
```bash
pnpm build:docs
```

2. 启动预览服务器
```bash
pnpm preview:docs
```

3. 访问 registry URL 验证

```text
http://localhost:4173/lingshu-toolkit/r/<hookName>.json
```

示例：
- `http://localhost:4173/lingshu-toolkit/r/vueUseTitle.json`
- `http://localhost:4173/lingshu-toolkit/r/reactUseBoolean.json`

如果能正常访问并返回 JSON 配置，说明 shadcn registry 配置成功。

## Git 工作流

### Commit 规范

使用 Conventional Commits 格式：

- `feat:` 新功能
- `fix:` 修复 bug
- `docs:` 文档更新
- `test:` 测试相关
- `refactor:` 重构
- `chore:` 构建/工具相关

示例：
```bash
feat(react): 新增 useLocalStorage hook
fix(react): 修复 useBoolean 类型推断问题
docs: 更新 useToggle 文档
chore(ci): 优化测试流程
```

### Git Hooks

项目配置了以下 hooks（通过 husky）：

#### pre-commit

- 运行 lint-staged（检查 .ts 文件）
- 运行测试（`pnpm test:ci`）

#### commit-msg

- 使用 commitlint 检查 commit 信息格式

### 代码检查

提交前会自动运行：
```bash
pnpm run check  # Biome 格式化和 lint
```

手动运行：
```bash
pnpm run format  # 仅格式化
pnpm run check   # 格式化 + lint
```

## 开发流程

1. 创建新分支
```bash
git checkout -b feat/your-feature
```

2. 开发并测试
```bash
pnpm test  # 运行测试
pnpm run dev:docs  # 启动文档开发服务器（支持热更新）
```

3. 提交代码
```bash
git add .
git commit -m "feat: your feature description"
```

4. 推送并创建 PR
```bash
git push origin feat/your-feature
```

## 发布流程

仅维护者可执行：

```bash
# 1. 更新版本号
npm version patch|minor|major

# 2. 构建
pnpm run build

# 3. 发布
npm publish
```

## 常见问题

### 测试失败

确保所有测试通过：
```bash
pnpm test:ci
```

### Commit 被拒绝

检查 commit 信息格式是否符合 Conventional Commits 规范。

### Lint 错误

运行自动修复：
```bash
pnpm run check
```

## 获取帮助

- 查看[文档](https://cmtlyt.github.io/lingshu-toolkit/)
- 提交 [Issue](https://github.com/cmtlyt/lingshu-toolkit/issues)
