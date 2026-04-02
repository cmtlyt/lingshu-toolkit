# Terminology Reference

This document defines the terminology and naming conventions used in lingshu-toolkit documentation.

## Namespace Conventions

### shared
- **Description**: Utility functions and tools that work across all frameworks
- **Import pattern**: `@cmtlyt/lingshu-toolkit/shared` or `@cmtlyt/lingshu-toolkit/shared/tool-name`
- **File structure**: `src/shared/tool-name/index.ts`
- **Examples**: `allx`, `throw-error`

### react
- **Description**: React hooks for React applications
- **Import pattern**: `@cmtlyt/lingshu-toolkit/react` or `@cmtlyt/lingshu-toolkit/react/use-hook-name`
- **File structure**: `src/react/use-hook-name/index.ts`
- **Examples**: `useForceUpdate`, `useMount`, `useTitle`

### vue
- **Description**: Vue composables for Vue applications
- **Import pattern**: `@cmtlyt/lingshu-toolkit/vue` or `@cmtlyt/lingshu-toolkit/vue/use-composable-name`
- **File structure**: `src/vue/use-composable-name/index.ts`
- **Examples**: (to be added)

## Naming Conventions

### Tool Names
- **Format**: camelCase for shared tools
- **Examples**: `allx`, `throwError`

### Hook Names
- **Format**: `use` prefix + PascalCase
- **Examples**: `useForceUpdate`, `useMount`, `useTitle`

### Composable Names
- **Format**: `use` prefix + PascalCase
- **Examples**: (to be added)

### File Names
- **Format**: kebab-case for directories
- **Examples**: `use-force-update`, `use-mount`, `use-title`

## Section Headings

### Main Sections (##)
- `## 特性` - Features
- `## 安装` - Installation
- `## 用法` - Usage
- `## install` - Installation (shared tools)
- `## usage` - Usage (shared tools)
- `## 基础用法` - Basic Usage
- `## 高级用法` - Advanced Usage
- `## API` - API Reference
- `## API Reference` - API Reference
- `## 使用场景` - Use Cases
- `## 最佳实践` - Best Practices
- `## 注意事项` - Notes/Warnings
- `## 对比` - Comparison
- `## 常见问题` - FAQ

### Subsections (###)
- `### 简单使用` - Simple Usage
- `### 动态示例` - Dynamic Example
- `### 场景一` - Scenario 1
- `### ⚠️ Warning Title` - Warning
- `### 🔧 Implementation Detail` - Implementation Detail

## Terminology Translation

### General Terms

| English | Chinese | Usage |
|---------|---------|-------|
| Feature | 特性 | Section heading, feature names |
| Install | 安装 | Section heading |
| Installation | 安装 | In text |
| Usage | 用法 | Section heading |
| Basic | 基础 | Section heading |
| Advanced | 高级 | Section heading |
| API | API | Section heading |
| Reference | 参考 | Section heading |
| Use Case | 使用场景 | Section heading |
| Best Practice | 最佳实践 | Section heading |
| Note | 注意事项 | Section heading |
| Warning | 警告 | Subsection heading |
| Example | 示例 | In text |
| Parameter | 参数 | Table header |
| Argument | 参数 | In text |
| Return Value | 返回值 | Table header |
| Type | 类型 | Table header |
| Required | 必填 | Table header |
| Default | 默认值 | Table header |
| Description | 描述 | Table header |
| Property | 属性 | Table header |
| Option | 选项 | In text |
| Options | 选项 | Table header |

### React Specific Terms

| English | Chinese | Usage |
|---------|---------|-------|
| Hook | Hook | In text |
| Component | 组件 | In text |
| State | 状态 | In text |
| Props | 属性 | In text |
| Effect | 副作用 | In text |
| Render | 渲染 | In text |
| Mount | 挂载 | In text |
| Unmount | 卸载 | In text |
| Re-render | 重新渲染 | In text |
| Callback | 回调 | In text |

### Vue Specific Terms

| English | Chinese | Usage |
|---------|---------|-------|
| Composable | 组合式函数 | In text |
| Ref | 引用 | In text |
| Reactive | 响应式 | In text |
| Template | 模板 | In text |

### Development Terms

| English | Chinese | Usage |
|---------|---------|-------|
| Implementation | 实现 | In text |
| Function | 函数 | In text |
| Method | 方法 | In text |
| Utility | 工具 | In text |
| Helper | 辅助函数 | In text |
| Package | 包 | In text |
| Library | 库 | In text |
| Framework | 框架 | In text |
| Dependency | 依赖 | In text |

### Error Handling Terms

| English | Chinese | Usage |
|---------|---------|-------|
| Error | 错误 | In text |
| Exception | 异常 | In text |
| Throw | 抛出 | In text |
| Catch | 捕获 | In text |
| Handle | 处理 | In text |

### Performance Terms

| English | Chinese | Usage |
|---------|---------|-------|
| Performance | 性能 | In text |
| Optimization | 优化 | In text |
| Efficient | 高效 | In text |
| Fast | 快速 | In text |
| Slow | 慢 | In text |

### Code Quality Terms

| English | Chinese | Usage |
|---------|---------|-------|
| Type Safety | 类型安全 | In text |
| Type Inference | 类型推断 | In text |
| Type Definition | 类型定义 | In text |
| TypeScript | TypeScript | In text (keep as is) |

## Code Block Language Specifiers

| Specifier | When to Use | Example |
|-----------|-------------|---------|
| `tsx` | React components with JSX | ```tsx |
| `ts` | TypeScript code without JSX | ```ts |
| `bash` | Shell commands | ```bash |
| `mdx` | MDX examples | ```mdx |

## Shadcn URL Format

Pattern: `https://cmtlyt.github.io/lingshu-toolkit/r/{namespace}{toolName}.json`

Examples:
- shared tool: `https://cmtlyt.github.io/lingshu-toolkit/r/sharedAllx.json`
- React hook: `https://cmtlyt.github.io/lingshu-toolkit/r/reactUseForceUpdate.json`
- Vue composable: `https://cmtlyt.github.io/lingshu-toolkit/r/vueUseExample.json`

Rules:
- Namespace: `shared`, `react`, or `vue`
- ToolName: PascalCase (e.g., `Allx`, `UseForceUpdate`)
- No spaces or special characters

## Version Format

Format: `>X.X.X`

Examples:
- `>0.1.0`
- `>0.2.0`
- `>0.3.0`

Rules:
- Always start with `>`
- Three parts: major.minor.patch
- No spaces

## Author Information

Standard format:
```mdx
> author: cmtlyt
```

Always use `cmtlyt` as the author name.

## Common Phrases

### Introduction Phrases
- "是一个" (is a)
- "用于" (used for)
- "支持" (supports)
- "提供" (provides)
- "能够" (able to)

### Feature Descriptions
- "基于...实现" (implemented based on...)
- "使用...机制" (uses... mechanism)
- "支持...功能" (supports... functionality)
- "提供...支持" (provides... support)

### Usage Instructions
- "基础用法" (basic usage)
- "高级用法" (advanced usage)
- "简单示例" (simple example)
- "复杂场景" (complex scenario)

### Warnings
- "注意" (note)
- "警告" (warning)
- "不要" (do not)
- "避免" (avoid)

## Formatting Guidelines

### Bold Text
- Use `**text**` for emphasis
- Feature names in feature lists
- Key terms in warnings

### Inline Code
- Use `` `code` `` for:
  - Function names
  - Variable names
  - Type names
  - File paths
  - URLs
  - Command names

### Code Blocks
- Always specify language
- Include comments for complex logic
- Use proper indentation (2 spaces)
- Keep examples focused

### Lists
- Use `-` for bullet points
- Use `1.` for numbered lists
- Indent nested lists with 2 spaces

## Consistency Rules

1. **Language**: Use Chinese for all descriptive text, English for code
2. **Headings**: Use ## for main sections, ### for subsections
3. **Code**: Always specify language in code blocks
4. **Tables**: Use consistent column ordering
5. **Formatting**: Use consistent spacing and punctuation
6. **Terminology**: Use the same Chinese translation consistently

## Quality Checklist

- [ ] Correct terminology used throughout
- [ ] Consistent language (Chinese for text, English for code)
- [ ] Proper heading levels (##, ###)
- [ ] Correct code block language specifiers
- [ ] Consistent formatting
- [ ] No mixed terminology
- [ ] Accurate translations
- [ ] Proper shadcn URL format
- [ ] Correct version format
- [ ] Standard author information
