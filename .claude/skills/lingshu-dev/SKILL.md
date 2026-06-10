---
name: lingshu-dev
description: "Development workflow for lingshu-toolkit project. Handles adding new tools to shared/react/vue namespaces, generating files via pnpm script:gen-file, implementing tool code, and coverage attack (补全测试覆盖率). Use when user wants to add new tool, create new hook, add utility function, develop lingshu-toolkit feature, extend toolkit, implement new functionality, improve test coverage, hit defense branch, fix coverage gaps. Triggers: 'add tool', 'new hook', 'create utility', 'add feature', 'develop toolkit', 'implement function', 'lingshu-toolkit development', 'add shared tool', 'add react hook', 'add vue hook', 'coverage', '覆盖率', '补测试', 'test coverage', 'defense branch', '防御分支', 'rfc'."
---

# Lingshu Toolkit Development

## Iron Law

**NEVER manually create tool files or modify exports.** Always use `pnpm script:gen-file` to generate files and update exports. Manual file creation breaks the automated build system.

**🚨 Export Style Rules:** Entry file 用末尾集中 `export { xxx }`，helper file 用行内 `export function/const/type`。→ 详细规则加载 `references/export-style-rules.md`

**🚨 ABSOLUTELY FORBIDDEN: Never modify engineering configuration files**（`rslib.config.ts`, `vitest.config.ts`, `tsconfig.json`, `package.json`, `biome.json`, `.github/workflows/*` 等）。遇到配置问题 → 告知用户，等待指导。

**🚨 If any step is skipped, alert the user with a clear warning explaining what was skipped and why it matters.**

**🚨 Coverage Attack 三条硬约束：**
1. 🚫 永不修改 `scripts/analyze-coverage.ts`
2. 🚫 永不重写源码让防御分支变可达
3. 🚫 永不加 `/* v8 ignore */` 注释绕过

✅ 唯一合法手段：导出内部函数 + 构造伪输入 + fake timers → 加载 `references/coverage-attack-playbook.md`

**🚨 RFC/实施清单目录规范：** RFC 和实施清单放在 `src/{namespace}/{tool-name}/__docs__/rfcs/{功能}/` 下，每个功能独立目录，不要混放。→ 详细规则加载 `references/rfc-docs-rules.md`

## Workflow Checklist

**🔀 工作流分支：先判断用户任务类型**

- 「新增工具 / 新增 hook」→ 走 Step 1-7（新工具开发流程）
- 「补全测试覆盖率 / 命中防御分支 / 改造真实计时器」→ 直接加载 `references/coverage-attack-playbook.md` 走攻坚流程
- 「调整测试改 fake timers」→ 加载 `references/testing-guidelines.md` 的「Fake Timers 精细化拦截」章节

### 新工具开发流程

- [ ] Step 1: Identify Tool Requirements ⚠️ REQUIRED
  - [ ] 1.1 Determine tool name (camelCase, no consecutive uppercase)
  - [ ] 1.2 Identify namespace (shared/react/vue)
  - [ ] 1.3 Clarify functionality and API
  - [ ] 1.4 Check for similar existing tools
- [ ] Step 2: Update meta/toolkit.meta.json ⛔ BLOCKING
  - [ ] 2.1 Add tool entry to appropriate namespace array
  - [ ] 2.2 Verify JSON syntax
- [ ] Step 3: Generate Files ⛔ BLOCKING
  - [ ] 3.1 Run `pnpm script:gen-file`
  - [ ] 3.2 Verify files created and export added
- [ ] Step 4: Implement Tool Code
  - [ ] 4.1 Read generated index.ts template
  - [ ] 4.2 Implement core functionality with TypeScript types
  - [ ] 4.3 Handle edge cases
- [ ] Step 5: Add Tests
  - [ ] 5.1 Write unit tests covering edge cases
  - [ ] 5.2 Use `.browser.test.{ts,tsx,js,jsx}` for browser APIs (no mocks)
  - [ ] 5.3 Use `vi.useFakeTimers()` for any timer-related logic（铁律，详见 testing-guidelines.md）
  - [ ] 5.4 Run `pnpm run test:ci`
- [ ] Step 6: Update Documentation
  - [ ] 6.1 Append docs to END of index.mdx (don't modify generated content)
  - [ ] 6.2 Add usage examples and API documentation
- [ ] Step 7: Verify Build ⚠️ REQUIRED
  - [ ] 7.1 Check Node.js version (>= 22)
  - [ ] 7.2 Run quality checks: `pnpm run check`, `pnpm run build`

### 覆盖率攻坚流程（独立分支）

⚠️ **本流程的详细执行步骤（包含 6 种命中模式 / Tier 分级 / 内部函数导出规范 / fake timers 配合）全部在 `references/coverage-attack-playbook.md`。下方仅是入口概览，遇到攻坚任务时必须先加载该 reference 再开干，禁止仅凭概览实施。**

- [ ] Step A: 跑 `pnpm test:ci <module> --coverage.enabled` 生成最新 `coverage/coverage-final.json`
- [ ] Step B: 用 `pnpm exec esno scripts/analyze-coverage.ts <module>` 扫描未覆盖项
- [ ] Step C: 按 Tier 分级（易→难）逐文件补测，对防御分支采用「导出内部函数 + 构造伪 state / spy 守卫 / 运行时非法数据 / fake timers 推进定时器」六种命中模式之一
- [ ] Step D: 全量回归（`pnpm run check` + `pnpm run test:ci <module>`）
- [ ] Step E: 重跑 coverage + analyze 验证 `Files dirty: 0`，并直接读 `coverage-final.json` 验证 stmt/branch/fn 三项均 100%

→ 完整方法论与可复制代码模板：`references/coverage-attack-playbook.md`

## Step 1: Identify Tool Requirements ⚠️ REQUIRED

Ask clarifying questions:
- What is the tool name? (camelCase, no consecutive uppercase like `useXmlParser` not `useXMLParser`)
- Which namespace? (shared for utilities, react for React hooks, vue for Vue hooks)
- What does the tool do?
- What is the expected API? (function signature, parameters, return value)
- Are there similar tools already in the toolkit?

Search existing tools:
```bash
grep -r "toolName" src/
```

**Confirmation Gate:** ⚠️ **MUST WAIT FOR USER CONFIRMATION**

Ask: "Tool Name: `{toolName}`, Namespace: `{namespace}`, Functionality: {brief}. Add `{ \"name\": \"{toolName}\" }` to `{namespace}` in `meta/toolkit.meta.json`. Proceed? (yes/no)"

**STOP and wait for user confirmation.**

## Step 2: Update meta/toolkit.meta.json ⛔ BLOCKING

Add tool entry to the appropriate namespace array in `meta/toolkit.meta.json`.

**Rules:**
- Tool names use camelCase (no consecutive uppercase)
- Maintain alphabetical order within namespace array
- Do NOT add or modify `$schema` field

## Step 3: Generate Files ⛔ BLOCKING

Run the file generation script:

```bash
pnpm script:gen-file
```

This script creates: `src/{namespace}/{tool-name}/` with `index.ts`, `index.test.ts`, `index.mdx`, updates exports and docs.

**Retry and Fallback:**

1. Run `pnpm script:gen-file` (retry once if fails)
2. If still fails:
   - Identify which files/updates failed
   - For non-critical files (docs, shadcn registry): confirm with user
   - For core files (`index.ts`, `index.test.ts`, exports): ask before auto-fill
3. **Auto-fill confirmation:** ⚠️ **MUST WAIT FOR USER CONFIRMATION**

Ask: "⚠️ Generation failed. Auto-create missing files: src/{namespace}/{tool-name}/index.ts, export in index.ts, index.test.ts. Proceed? (yes/no)"

**STOP and wait for user confirmation.**

## Step 4: Implement Tool Code

Read the generated template:
```bash
cat src/{namespace}/{tool-name}/index.ts
```

→ Load `references/implementation-guidelines.md` for implementation patterns (shared tools, React/Vue hooks, TypeScript guidelines)

**Questions to answer:**
- Does the implementation handle all edge cases?
- Are TypeScript types properly defined?
- Is the code following existing patterns in the codebase?

## Step 5: Add Tests

→ Load `references/testing-guidelines.md` for testing patterns and coverage requirements.

**Browser Environment Tests:**

If tests require browser environment (DOM APIs, window, document, localStorage, etc.):
- **RENAME** to `.browser.test.{ts,tsx,js,jsx}`
- Do NOT use hacky mocks for browser APIs
- Browser tests run in the environment configured in `vitest.project.config.ts`
- Keep standard unit tests in `index.test.ts` for Node.js environment

Basic test template:

```typescript
import { describe, test, expect } from 'vitest';
import { toolName } from '@/shared/tool-name';

describe('toolName', () => {
  test('should work correctly', () => {
    // Test implementation
  });
});
```

**Run Tests:**

Proceed to run `pnpm run test:ci`

## Step 6: Update Documentation

→ Load `references/documentation-rules.md` for documentation guidelines.

**CRITICAL:** DO NOT modify script-generated content in `index.mdx` (title, version, install, usage sections). Append additional docs to the END of the file.

**Questions to answer:**
- Are usage examples clear and realistic?
- Is the API documentation complete?
- Did you append docs to the END (not modify generated content)?

## Step 7: Verify Build ⚠️ REQUIRED

**Node.js Version Check:**

→ Load `references/node-version-check.md` for version check and management instructions.

⚠️ **REQUIRED: Node.js version must be >= 22**

Check version:
```bash
node --version
```

If version is **< 22**:
- **🚨 BUILD SKIPPED - Node.js version mismatch**
- Load `references/node-version-check.md` and provide the error message template to user
- **REMINDER:** Please confirm and set Node.js default version to avoid this issue
- Wait for user to switch Node.js version

If version is **>= 22**:
- Proceed to run quality checks:
```bash
pnpm run check
pnpm run build
```

## Anti-Patterns

### 新工具开发

❌ Manually create tool files
❌ Manually edit `src/{namespace}/index.ts` to add exports
❌ Skip running `pnpm script:gen-file`
❌ Add tools without tests
❌ Use `any` type without justification
❌ Forget to document the API
❌ Use hacky mocks for browser APIs instead of using `.browser.test.{ts,tsx,js,jsx}` files
❌ Use consecutive uppercase letters in tool names (e.g., `useXMLParser` → use `useXmlParser`)
❌ **Modify any engineering configuration files** (rslib.config.ts, vitest.config.ts, tsconfig.json, package.json, biome.json, .github/workflows/*, etc.)

### 测试与覆盖率

❌ 用真实 `setTimeout(resolve, N)` 等待真实时间（→ `references/testing-guidelines.md`）
❌ 默认 `vi.useFakeTimers()` 与依赖 `Date.now()` 的源码混用（→ 精细化拦截见 `references/testing-guidelines.md`）
❌ Promise 时序用同步版 `vi.advanceTimersByTime`（应用 async 版）
❌ 修改 `scripts/analyze-coverage.ts`
❌ 加 `/* v8 ignore */` 注释绕过
❌ 重写源码让防御分支变可达
❌ 加 testing-only setter / 后门 API
❌ 在主入口 re-export 仅供测试用的内部函数

→ 完整反模式清单：`references/coverage-attack-playbook.md` §5

## Pre-Delivery Checklist

### 新工具开发

- [ ] Tool added to `meta/toolkit.meta.json`
- [ ] `pnpm script:gen-file` executed successfully
- [ ] Files generated in `src/{namespace}/{tool-name}/`
- [ ] Export added to `src/{namespace}/index.ts`
- [ ] Implementation complete in `index.ts`
- [ ] Tests written in `index.test.ts`（涉及定时器必须用 `vi.useFakeTimers()`）
- [ ] Documentation updated in `index.mdx`
- [ ] `pnpm run check` passes with no errors
- [ ] `pnpm run test:ci` passes all tests
- [ ] `pnpm run build` completes successfully
- [ ] No TODO comments remaining
- [ ] Code follows Biome formatting

### 覆盖率攻坚

→ 完整 checklist 见 `references/coverage-attack-playbook.md` Step F（终验清单）。核心验证项：
- [ ] `Files dirty: 0` 且 stmt/branch/fn 三项均 100%
- [ ] 三条硬约束未被违反（无新增 `/* v8 ignore */`、裁判脚本零修改、源码防御分支未被重写）
- [ ] 涉及定时器的测试均使用 `vi.useFakeTimers()`

## Common Commands

```bash
# Generate files after updating meta
pnpm script:gen-file

# Lint and format
pnpm run check

# Run tests
pnpm run test:ci

# Build project
pnpm run build

# Run specific test file
pnpm run test:ci src/{namespace}/{tool-name}/index.test.ts

# Run tests with coverage (coverage attack)
pnpm test:ci src/{namespace}/{tool-name} --coverage.enabled

# Analyze uncovered items
pnpm exec esno scripts/analyze-coverage.ts src/{namespace}/{tool-name}

# Analyze with source context
pnpm exec esno scripts/analyze-coverage.ts src/{namespace}/{tool-name} --with-source
```

## Project Structure

```
src/
├── shared/          # General utilities
│   ├── index.ts
│   ├── _meta.json
│   ├── data-handler/
│   │   ├── index.ts
│   │   ├── index.test.ts
│   │   └── index.mdx
│   └── ...
├── react/           # React hooks
│   ├── index.ts
│   ├── _meta.json
│   ├── tsconfig.json
│   ├── use-boolean/
│   │   ├── index.ts
│   │   ├── index.test.ts
│   │   └── index.mdx
│   └── ...
└── vue/             # Vue hooks
    ├── index.ts
    ├── _meta.json
    └── use-title/
        ├── index.ts
        ├── index.test.ts
        └── index.mdx
```

## Troubleshooting

**Issue:** `pnpm script:gen-file` fails
- Check `meta/toolkit.meta.json` JSON syntax
- Verify tool name is camelCase
- Ensure namespace is valid (shared/react/vue)

**Issue:** Export not added to index.ts
- Re-run `pnpm script:gen-file`
- Check for existing tool with same name

**Issue:** Build fails
- Run `pnpm run check` to fix linting issues
- Check TypeScript errors in implementation
- Ensure all dependencies are imported correctly
