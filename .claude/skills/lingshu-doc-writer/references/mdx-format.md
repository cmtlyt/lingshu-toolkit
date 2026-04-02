# MDX Format Reference

This document defines the standard format for lingshu-toolkit documentation.

## Document Structure

### Required Sections (in order)

1. **Title and Metadata**
2. **Features/特性** 
3. **Installation**
4. **Usage**
5. **API Reference**
6. **Notes/注意事项** (for --full docs)

### Optional Sections (for --full docs)

- Advanced Examples
- Use Cases
- Comparison
- FAQ
- Best Practices

## Section Formats

### 1. Title and Metadata

```mdx
# tool-name

> package version >X.X.X
>
> shadcn any version
>
> author: cmtlyt

Brief description (1-2 sentences) of what this tool/hook does.
```

**Rules:**
- Use kebab-case for tool-name
- Version format: >X.X.X (minimum version)
- Author: cmtlyt
- Description must be in Chinese

### 2. Features/特性

```mdx
## 特性

- **Feature 1**: Description
- **Feature 2**: Description
- **Feature 3**: Description
```

**Rules:**
- Use ## heading level
- Feature names in bold
- Each feature on separate line
- 3-7 features typically
- Use Chinese for descriptions

### 3. Installation

```mdx
## 安装

```bash title="npm"
npm i @cmtlyt/lingshu-toolkit
```

```bash title="shadcn"
npx shadcn@latest add https://cmtlyt.github.io/lingshu-toolkit/r/namespaceToolName.json
```

## 用法

```ts
import { toolName } from '@cmtlyt/lingshu-toolkit/namespace'
// or
import { toolName } from '@cmtlyt/lingshu-toolkit/namespace/tool-name'
```
```

**Rules:**
- Use ## heading level for "安装"
- Use ## heading level for "用法"
- Always include both npm and shadcn commands
- Include both import styles
- Namespace: shared, react, or vue
- ToolName in PascalCase for shadcn URL

### 4. Usage Examples

```mdx
## 基础用法

### 简单使用

```tsx
function Example() {
  const result = toolName();
  return <div>{result}</div>;
}
```

### 动态示例

```tsx
function DynamicExample({ value }) {
  const result = toolName(value);
  return <div>{result}</div>;
}
```

## 高级用法

### 场景一

```tsx
function AdvancedExample() {
  // Advanced code
}
```
```

**Rules:**
- Use ## for main sections
- Use ### for subsections
- Each example has a descriptive title
- Comments in code explain what's happening
- Use tsx for React components, ts for functions

### 5. API Reference

```mdx
## API Reference

### toolName

```ts
function toolName(param: Type): ReturnType
```

#### 参数

| 参数 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| param | Type | 是 | undefined | Description |

#### Options

| 属性 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| option | Type | 否 | defaultValue | Description |

#### 返回值

Description of what the function returns.

#### 类型定义

```ts
interface ToolNameOptions {
  option?: Type;
}
```
```

**Rules:**
- Use ## heading level
- Function name in ### heading
- Include TypeScript signature
- Use tables for parameters and options
- Include type definitions for complex types
- All descriptions in Chinese

### 6. Notes/注意事项

```mdx
## 注意事项

### ⚠️ Warning Title

Warning content explaining potential issues or pitfalls.

### 🔧 Implementation Detail

Explanation of how the tool works internally.

### ⚠️ Performance Considerations

Performance-related warnings or tips.
```

**Rules:**
- Use ## heading level
- Use ### for subsections
- Use ⚠️ for warnings
- Use 🔧 for implementation details
- Clear, actionable advice
- All content in Chinese

## Code Block Guidelines

### Language Specification

- `tsx` - React components with JSX
- `ts` - TypeScript code without JSX
- `bash` - Shell commands
- `mdx` - MDX examples

### Code Style

- Use proper indentation (2 spaces)
- Include type annotations
- Add comments for complex logic
- Use meaningful variable names
- Follow project coding standards

### Example Structure

```tsx
// Brief comment explaining purpose
function ExampleName() {
  const [state, setState] = useState(null);

  // Main logic
  const handleClick = () => {
    // Action
  };

  return <div>{/* JSX */}</div>;
}
```

## Language Guidelines

### Primary Language
- Use Chinese for all descriptive text
- Use English for:
  - Code
  - API names
  - Type names
  - Parameter names
  - File paths
  - URLs

### Terminology

| English | Chinese |
|---------|---------|
| Feature | 特性 |
| Install | 安装 |
| Usage | 用法 |
| Basic | 基础 |
| Advanced | 高级 |
| API | API |
| Parameters | 参数 |
| Returns | 返回值 |
| Notes | 注意事项 |
| Warning | 警告 |
| Example | 示例 |

## Formatting Rules

### Headings
- `#` - Document title (only once)
- `##` - Main sections
- `###` - Subsections
- Don't use #### or deeper

### Lists
- Use `-` for bullet points
- Use `1.` for numbered lists
- Indent nested lists with 2 spaces

### Tables
- Use markdown table syntax
- Include headers row
- Align columns consistently

### Emphasis
- Use `**bold**` for emphasis
- Use `` `code` `` for inline code
- Don't use _italic_

### Line Breaks
- Use blank lines between sections
- Use blank lines between code and text
- No trailing whitespace

## Common Patterns

### React Hook Pattern

```mdx
# useHookName

> package version >X.X.X
>
> shadcn any version
>
> author: cmtlyt

Brief description.

## 特性

- **Feature 1**: Description
- **Feature 2**: Description

## 安装

[Installation commands]

## 用法

[Import statements]

## 基础用法

[Basic examples]

## 高级用法

[Advanced examples]

## API

[API reference]

## 使用场景

[Use case sections]

## 注意事项

[Notes and warnings]
```

### Shared Tool Pattern

```mdx
# toolName

> package version >X.X.X
>
> shadcn any version
>
> author: cmtlyt

Brief description.

## 特性

[Features list]

## install

[Installation commands]

## usage

[Import statements]

## 基础用法

[Basic examples]

## 高级用法

[Advanced examples]

## 使用场景

[Use case sections]

## API

[API reference]

## 最佳实践

[Best practices]

## 注意事项

[Notes and warnings]
```

## Quality Checklist

Before finalizing documentation:

- [ ] All required sections present
- [ ] Correct heading levels (##, ###)
- [ ] Proper code block language specified
- [ ] TypeScript types in all examples
- [ ] Chinese for descriptive text
- [ ] Consistent formatting
- [ ] No placeholder text (TODO, FIXME)
- [ ] Code examples are executable
- [ ] Tables properly formatted
- [ ] No trailing whitespace
- [ ] Blank lines between sections
