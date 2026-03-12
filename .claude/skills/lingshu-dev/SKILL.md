---
name: lingshu-dev
description: "Development workflow for lingshu-toolkit project. Handles adding new tools to shared/react/vue namespaces, generating files via pnpm script:gen-file, and implementing tool code. Use when user wants to add new tool, create new hook, add utility function, develop lingshu-toolkit feature, extend toolkit, implement new functionality. Triggers: 'add tool', 'new hook', 'create utility', 'add feature', 'develop toolkit', 'implement function', 'lingshu-toolkit development', 'add shared tool', 'add react hook', 'add vue hook'."
---

# Lingshu Toolkit Development

## Iron Law

**NEVER manually create tool files or modify exports.** Always use `pnpm script:gen-file` to generate files and update exports. Manual file creation breaks the automated build system.

**🚨 ABSOLUTELY FORBIDDEN: Never modify engineering configuration files.** This includes but is not limited to:
- `rslib.config.ts`, `rspress.config.ts`, `vitest.config.ts`
- `tsconfig.json`, `package.json`, `.nvmrc`
- `biome.json`, `.eslintrc`, `.prettierrc`
- `.github/workflows/*`, `.husky/*`
- Any build tool, test tool, or CI/CD configuration

If you encounter a build or configuration issue, **DO NOT attempt to fix it by modifying configuration files**. Instead:
1. Alert the user with a clear explanation of the issue
2. Suggest they review the configuration manually
3. Wait for user guidance before proceeding

**🚨 If any step is skipped, alert the user with a clear warning explaining what was skipped and why it matters.**

## Workflow Checklist

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
  - [ ] 5.2 Use `.browser.test.ts` for browser APIs (no mocks)
  - [ ] 5.3 Run `pnpm run test:ci`
- [ ] Step 6: Update Documentation
  - [ ] 6.1 Append docs to END of index.mdx (don't modify generated content)
  - [ ] 6.2 Add usage examples and API documentation
- [ ] Step 7: Verify Build ⚠️ REQUIRED
  - [ ] 7.1 Check Node.js version (>= 22)
  - [ ] 7.2 Run quality checks: `pnpm run check`, `pnpm run build`

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

Ask: "Tool Name: `{toolName}`, Namespace: `{namespace}`, Functionality: {brief}. Is this correct? (yes/no)"

**STOP and wait for user confirmation.**

## Step 2: Update meta/toolkit.meta.json ⛔ BLOCKING

The meta file defines all tools in the toolkit:

```json
{
  "$schema": "../plugins/auto-patch-file/schema.json",
  "shared": [
    { "name": "dataHandler" },
    { "name": "throwError" }
  ],
  "react": [
    { "name": "useBoolean" },
    { "name": "useToggle" }
  ],
  "vue": [
    { "name": "useTitle" }
  ]
}
```

**Rules:**
- Tool names use camelCase (no consecutive uppercase)
- Add to the appropriate namespace array
- Maintain alphabetical order
- Do NOT add `$schema` field (already present)

**Confirmation Gate:** ⚠️ **MUST WAIT FOR USER CONFIRMATION**

Ask: "Add `{ "name": "toolName" }` to `{namespace}` namespace. Proceed? (yes/no)"

**STOP and wait for user confirmation.**

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
- **RENAME** to `index.browser.test.ts` or `index.browser.test.tsx`
- Do NOT use hacky mocks for browser APIs
- Browser tests run in the environment configured in `vitest.project.config.ts`
- Keep standard unit tests in `index.test.ts` for Node.js environment

Basic test template:

```typescript
import { describe, it, expect } from 'vitest';
import { toolName } from '@/shared/tool-name';

describe('toolName', () => {
  it('should work correctly', () => {
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

❌ Manually create tool files
❌ Manually edit `src/{namespace}/index.ts` to add exports
❌ Skip running `pnpm script:gen-file`
❌ Add tools without tests
❌ Use `any` type without justification
❌ Forget to document the API
❌ Use hacky mocks for browser APIs instead of using `.browser.test.{ts,tsx}` files
❌ Use consecutive uppercase letters in tool names (e.g., `useXMLParser` → use `useXmlParser`)
❌ **Modify any engineering configuration files** (rslib.config.ts, vitest.config.ts, tsconfig.json, package.json, biome.json, .github/workflows/*, etc.)

## Pre-Delivery Checklist

- [ ] Tool added to `meta/toolkit.meta.json`
- [ ] `pnpm script:gen-file` executed successfully
- [ ] Files generated in `src/{namespace}/{tool-name}/`
- [ ] Export added to `src/{namespace}/index.ts`
- [ ] Implementation complete in `index.ts`
- [ ] Tests written in `index.test.ts`
- [ ] Documentation updated in `index.mdx`
- [ ] `pnpm run check` passes with no errors
- [ ] `pnpm run test:ci` passes all tests
- [ ] `pnpm run build` completes successfully
- [ ] No TODO comments remaining
- [ ] Code follows Biome formatting

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
