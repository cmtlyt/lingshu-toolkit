# 贡献指南

## 环境要求

- Node.js >= 18.0.0
- pnpm（必须使用 pnpm，不支持 npm/yarn）

## 快速开始

```bash
# 1. Fork 并克隆仓库
git clone https://github.com/your-username/lingshu-toolkit.git
cd lingshu-toolkit

# 2. 安装依赖
pnpm install

# 3. 运行测试
pnpm test

# 4. 启动文档
pnpm run dev:docs
```

## 项目结构

```
src/
├── react/          # React hooks
├── vue/            # Vue hooks
└── shared/         # 共享工具函数（框架无关）
```

**当前支持的框架**：React、Vue

每个 hook/工具目录包含：
- `index.ts` - 实现代码
- `index.test.ts` - 测试文件
- `index.mdx` - 文档文件

### 新增框架支持

如需新增其他框架（如 Svelte、Solid 等），需遵循以下规范：

1. **目录结构**
```
src/
└── <framework-name>/     # 框架名小写，如 svelte、solid
    ├── index.ts          # 导出所有 hooks
    ├── use-example/
    │   ├── index.ts
    │   ├── index.test.ts
    │   └── index.mdx
    └── ...
```

2. **构建配置**
- 在 `rslib.config.ts` 中添加对应的构建入口
- 在 `package.json` 的 `exports` 字段中添加导出路径
- 在 `peerDependencies` 中添加框架依赖

3. **测试配置**
- 安装对应的 vitest-browser 插件（如 `vitest-browser-svelte`）
- 在测试文件中使用对应的测试工具（如 `renderHook` from `vitest-browser-svelte`）

## 编写 Hook

### 代码规范

- 使用 TypeScript
- 使用 `@/` 别名导入（如 `@/react/use-toggle`）
- 返回值使用 `as const` 确保类型推断
- 使用 `biome-ignore` 注释忽略特定规则

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

**测试覆盖率要求：100%**

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

**覆盖率要求：100%**

运行 shared 包测试：
```bash
pnpm run test:lib      # 开发模式
pnpm run test:lib:ci   # CI 模式
```

## Shadcn 支持

项目同时支持 npm 包和 shadcn 安装方式，提供更好的定制化能力。

### 配置 Shadcn Registry

新增 hook 后，需要在 `shadcn-exports.json` 中注册：

```json
{
  "exports": [
    {
      "name": "frameworkHookName",
      "path": "src/framework/hook-name/index.ts"
    }
  ]
}
```

命名规范：
- React hooks: `reactUseExample`
- Vue hooks: `vueUseExample`
- Shared 工具: `sharedExampleUtil`

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
```
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
feat: 新增 useLocalStorage hook
fix: 修复 useBoolean 类型推断问题
docs: 更新 useToggle 文档
```

### Git Hooks

项目配置了以下 hooks（通过 husky）：

**pre-commit**：
- 运行 lint-staged（检查 .ts 文件）
- 运行测试（`pnpm test:ci`）

**commit-msg**：
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
pnpm run dev:docs  # 预览文档
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
