---
name: lingshu-dev
description: "Development workflow for lingshu-toolkit project. Handles adding new tools to shared/react/vue namespaces, generating files via pnpm script:gen-file, and implementing tool code. Use when user wants to add new tool, create new hook, add utility function, develop lingshu-toolkit feature, extend toolkit, implement new functionality. Triggers: 'add tool', 'new hook', 'create utility', 'add feature', 'develop toolkit', 'implement function', 'lingshu-toolkit development', 'add shared tool', 'add react hook', 'add vue hook'."
---

# Lingshu Toolkit Development

## Iron Law

**NEVER manually create tool files or modify exports.** Always use `pnpm script:gen-file` to generate files and update exports. Manual file creation will break the automated build system and cause synchronization issues.

## Workflow Checklist

- [ ] Step 1: Identify Tool Requirements ⚠️ REQUIRED
  - [ ] 1.1 Determine tool name (camelCase)
  - [ ] 1.2 Identify namespace (shared/react/vue)
  - [ ] 1.3 Clarify functionality and API
  - [ ] 1.4 Check if similar tool already exists
- [ ] Step 2: Update meta/toolkit.meta.json ⛔ BLOCKING
  - [ ] 2.1 Add tool entry to appropriate namespace array
  - [ ] 2.2 Verify JSON syntax
- [ ] Step 3: Generate Files ⛔ BLOCKING
  - [ ] 3.1 Run `pnpm script:gen-file`
  - [ ] 3.2 Verify files created in src/{namespace}/{tool-name}/
  - [ ] 3.3 Verify export added to src/{namespace}/index.ts
- [ ] Step 4: Implement Tool Code
  - [ ] 4.1 Read generated index.ts template
  - [ ] 4.2 Implement core functionality
  - [ ] 4.3 Add TypeScript types
  - [ ] 4.4 Handle edge cases
- [ ] Step 5: Add Tests
  - [ ] 5.1 Check Node.js version (load references/node-version-check.md)
  - [ ] 5.2 Read generated index.test.ts template
  - [ ] 5.3 Write unit tests
  - [ ] 5.4 Test edge cases
- [ ] Step 6: Update Documentation
  - [ ] 6.1 Edit generated index.mdx
  - [ ] 6.2 Add usage examples
  - [ ] 6.3 Document API
- [ ] Step 7: Verify Build
  - [ ] 7.1 Check Node.js version (load references/node-version-check.md)
  - [ ] 7.2 Run quality checks: `pnpm run check`, `pnpm run test:ci`, `pnpm run build`

## Step 1: Identify Tool Requirements ⚠️ REQUIRED

Ask clarifying questions:
- What is the tool name? (use camelCase, e.g., `useDebounce`, `formatDate`)
- Which namespace? (shared for utilities, react for React hooks, vue for Vue hooks)
- What does the tool do?
- What is the expected API? (function signature, parameters, return value)
- Are there similar tools already in the toolkit?

Search existing tools:
```bash
grep -r "toolName" src/
```

**Confirmation Gate:** Confirm namespace and tool name before proceeding:
- "Tool Name: `{toolName}`, Namespace: `{namespace}`, Functionality: {brief}"
- "Is this correct?"

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
- Tool names use camelCase
- Add to the appropriate namespace array
- Maintain alphabetical order
- Do NOT add `$schema` field (already present)

**Confirmation Gate:** Confirm before modifying `meta/toolkit.meta.json`:
- "Add `{ "name": "toolName" }` to `{namespace}` namespace. Proceed?"

## Step 3: Generate Files ⛔ BLOCKING

Run the file generation script:

```bash
pnpm script:gen-file
```

This script will:
1. Create directory: `src/{namespace}/{tool-name}/`
2. Generate files: `index.ts`, `index.test.ts`, `index.mdx`
3. Update `src/{namespace}/index.ts` with new export
4. Update `src/{namespace}/_meta.json` for documentation
5. Update `shadcn-exports.json` for shadcn registry

**Retry and Fallback:**

1. Run `pnpm script:gen-file` (retry once if fails)
2. If still fails:
   - Identify which files/updates failed
   - For non-critical files (docs, shadcn registry): confirm with user
   - For core files (`index.ts`, `index.test.ts`, exports): ask before auto-fill
3. **Auto-fill confirmation:** "⚠️ Generation failed. Auto-create missing files: src/{namespace}/{tool-name}/index.ts, export in index.ts, index.test.ts. Proceed? (yes/no)"

## Step 4: Implement Tool Code

Read the generated template:
```bash
cat src/{namespace}/{tool-name}/index.ts
```

→ Load `references/implementation-guidelines.md` for implementation patterns (shared tools, React/Vue hooks, TypeScript guidelines)

## Step 5: Add Tests

→ Load `references/testing-guidelines.md` for testing patterns and coverage requirements.

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

**Node.js Version Check:**

→ Load `references/node-version-check.md` for version check and management instructions.

Check version and switch if needed:
```bash
node --version
# If < 22, try: nvm use 22, fnm use 22, volta pin node@22, or n 22
```

If version check fails: skip tests, notify user with error message from node-version-check.md.

If version check passes: run `pnpm run test:ci`

## Step 6: Update Documentation

→ Load `references/documentation-rules.md` for documentation guidelines.

**CRITICAL:** DO NOT modify script-generated content in `index.mdx` (title, version, install, usage sections). Append additional docs to the END of the file.

Read generated docs:
```bash
cat src/{namespace}/{tool-name}/index.mdx
```

## Step 7: Verify Build

**Node.js Version Check:**

→ Load `references/node-version-check.md` for version check and management instructions (same process as Step 5).

If version check fails: skip build, notify user with error message from node-version-check.md.

If version check passes: run quality checks:
```bash
pnpm run check
pnpm run test:ci
pnpm run build
```

## Anti-Patterns

❌ Manually create tool files
❌ Manually edit `src/{namespace}/index.ts` to add exports
❌ Skip running `pnpm script:gen-file`
❌ Add tools without tests
❌ Use `any` type without justification
❌ Forget to document the API

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
