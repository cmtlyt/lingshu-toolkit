---
name: lingshu-doc-writer
description: "Write lingshu-toolkit documentation in MDX format following project standards. Creates comprehensive docs with proper structure: title, version info, features, installation, usage, examples, API reference, and notes. Supports --quick (basic structure), --full (complete doc), --update (existing doc). Use when user wants to write documentation, create docs, generate MDX, write tool documentation, write hook docs, add documentation to lingshu-toolkit. Triggers: 'write documentation', 'create docs', 'generate MDX', 'write tool docs', 'write hook docs', 'add documentation', 'document the code', 'create documentation file', 'write API docs', 'write usage docs'."
---

# Doc Writer

IRON LAW: Every documentation must be type-safe, executable, and follow lingshu-toolkit's MDX structure. Never generate code that cannot run or lacks proper TypeScript types.

## Workflow

Copy this checklist and check off items as you complete them:

```
Doc Writer Progress:

- [ ] Step 1: Understand the Target ⚠️ REQUIRED
  - [ ] 1.1 Identify the tool/hook/function being documented
  - [ ] 1.2 Read the source code to understand implementation
  - [ ] 1.3 Determine the namespace (shared/react/vue)
- [ ] Step 2: Determine Document Type
  - [ ] 2.1 Check if --quick flag (basic structure only)
  - [ ] 2.2 Check if --full flag (complete documentation)
  - [ ] 2.3 Check if --update flag (update existing doc)
- [ ] Step 3: Load MDX Format Reference ⚠️ REQUIRED
  - [ ] Load references/mdx-format.md
  - [ ] Understand required sections and structure
- [ ] Step 4: Generate Content
  - [ ] 4.1 Write title and metadata (version, shadcn, author)
  - [ ] 4.2 Write features/特性 section
  - [ ] 4.3 Write installation commands
  - [ ] 4.4 Write usage examples
  - [ ] 4.5 Write API reference
  - [ ] 4.6 Write notes/注意事项
- [ ] Step 5: Verify Quality ⚠️ REQUIRED
  - [ ] 5.1 Check TypeScript types in all code examples
  - [ ] 5.2 Verify code is executable
  - [ ] 5.3 Ensure all required sections present
  - [ ] 5.4 Check formatting consistency
- [ ] Step 6: Create/Update File
  - [ ] 6.1 Determine correct file path
  - [ ] 6.2 Create or update the .mdx file
  - [ ] 6.3 Run pnpm run lint to check formatting
```

## Step 1: Understand the Target ⚠️ REQUIRED

Before writing any documentation:

**Ask these questions:**
- What is the tool/hook/function name?
- Which namespace does it belong to? (shared/react/vue)
- What is the file path in src/?

**Read the source code:**
- Use `read_file` to read the implementation
- Understand the function signature and parameters
- Identify key features and use cases
- Note any TypeScript types

**Read the test file ⚠️ CRITICAL:**
- Find and read the corresponding test file (usually `src/**/__tests__/*.test.ts` or `src/**/*.test.ts`)
- Analyze test assertions to understand expected behavior
- Extract usage patterns from test cases
- **Code examples in documentation must match test assertions**
- Use test cases as the source of truth for expected behavior

**Example:**
```
User: "Write docs for allx tool"
→ Read src/shared/allx/index.ts
→ Read src/shared/allx/__tests__/allx.test.ts (or similar)
→ Identify namespace: shared
→ Understand: Promise.all enhancement with dependency resolution
→ Extract usage patterns from test assertions
→ Ensure examples match test expectations
```

## Step 2: Determine Document Type

Check flags to determine output scope:

### --quick
Generate basic structure only:
- Title and metadata
- Features list
- Installation commands
- Basic usage example
- Simple API reference

### --full
Generate complete documentation:
- All --quick sections
- Advanced usage examples
- Multiple use case scenarios
- Detailed API reference with tables
- Comparison sections
- FAQ
- Best practices
- Comprehensive notes/warnings

### --update
Update existing documentation:
- Read existing .mdx file
- Identify what needs updating
- Add new sections or examples
- Fix outdated information
- Maintain existing structure

## Step 3: Load MDX Format Reference ⚠️ REQUIRED

Always load the format reference before generating content:

→ Load references/mdx-format.md for:
- Required sections order
- Heading levels (##, ###)
- Code block syntax
- Metadata format
- Installation command format
- Language consistency (中文 for lingshu-toolkit)

## Step 4: Generate Content

### 4.1 Title and Metadata

Format:
```mdx
# tool-name

> package version >X.X.X
>
> shadcn any version
>
> author: cmtlyt

Brief description of what this tool does.
```

### 4.2 Features/特性 Section

Use bullet points with **bold** for emphasis:
- **Feature 1**: Description
- **Feature 2**: Description

### 4.3 Installation Commands

Always include both npm and shadcn:
```bash title="npm"
npm i @cmtlyt/lingshu-toolkit
```

```bash title="shadcn"
npx shadcn@latest add https://cmtlyt.github.io/lingshu-toolkit/r/namespaceToolName.json
```

### 4.4 Usage Examples

**For --quick:**
- 1 basic usage example
- Simple, straightforward code

**For --full:**
- Basic usage section
- Advanced examples section
- Multiple real-world scenarios
- Each example with clear title

**⚠️ CRITICAL: Generate examples from test files**
- Read the corresponding test file for the tool/hook
- Extract usage patterns from test cases
- Ensure examples match test assertions exactly
- Use test assertions as the source of truth for expected behavior
- If test shows `expect(func(arg)).toBe(42)`, the example must show `func(arg) // 42`
- Document edge cases that are tested
- Include error handling examples if tests cover error scenarios

**Code example format:**
```tsx/ts
// Brief comment explaining what this does
function Example() {
  // Code here
}
```

### 4.5 API Reference

**For --quick:**
- Function signature
- Parameter list
- Return value

**For --full:**
- Function signature
- Parameter table (| Parameter | Type | Required | Default | Description |)
- Options table (if applicable)
- Return value details
- Type definitions (if complex)

### 4.6 Notes/注意事项

Use ⚠️ for warnings and 🔧 for implementation details:
```mdx
### ⚠️ Warning Title

Warning content.

### 🔧 Implementation Detail

Implementation explanation.
```

## Step 5: Verify Quality ⚠️ REQUIRED

Before creating the file, verify:

### 5.1 TypeScript Types
- All code examples must have proper types
- Function signatures match the implementation
- No `any` types unless absolutely necessary

### 5.2 Executable Code
- Code examples should be runnable
- No placeholder comments (TODO, FIXME)
- Imports are correct
- **Examples must match test assertions**
- **Expected outputs must align with test expectations**

### 5.3 Required Sections
- [ ] Title and metadata
- [ ] Features/特性
- [ ] Installation
- [ ] Usage
- [ ] API Reference
- [ ] Notes/注意事项 (for --full)

### 5.4 Formatting Consistency
- Headings: ## for main sections, ### for subsections
- Code blocks: Proper language specification (tsx, ts, bash)
- Tables: Proper markdown table syntax
- Lists: Use - for bullet points

## Step 6: Create/Update File

### 6.1 Determine File Path

Pattern:
- Shared tools: `src/shared/tool-name/index.mdx`
- React hooks: `src/react/use-hook-name/index.mdx`
- Vue composables: `src/vue/use-composable-name/index.mdx`

### 6.2 Create or Update

**For new docs:**
- Use `create_file` to create the .mdx file
- Ensure directory exists

**For updates:**
- Use `read_file` to read existing content
- Use `file_replace` or `edit_file` to update specific sections
- Preserve existing structure

### 6.3 Verify Formatting

Run lint check:
```bash
pnpm run lint
```

Fix any formatting issues before completing.

## Anti-Patterns

### ❌ DO NOT:

- Generate code without TypeScript types
- Use placeholder text (TODO, FIXME, xxx)
- Create examples that cannot run
- Skip required sections
- Use inconsistent heading levels
- Mix Chinese and English in the same document
- Forget to check lint errors
- Write vague descriptions like "A tool for X"
- **Generate examples without reading the test file**
- **Create examples that contradict test assertions**
- **Guess expected behavior — use tests as source of truth**

### ✅ DO:

- Always include proper TypeScript types
- Write complete, executable examples
- Follow the exact structure from existing docs
- Use consistent formatting
- Check for lint errors
- Be specific in descriptions
- Include real-world use cases
- **Read the test file before generating examples**
- **Match examples to test assertions exactly**
- **Use test cases as source of truth for behavior**

## Writing Principles

- **Concise**: Explain clearly, avoid verbosity
- **Type-safe**: All code must have proper types
- **Executable**: Examples should run without modification
- **Consistent**: Match existing documentation style
- **Complete**: Cover all important aspects (for --full)
- **Practical**: Focus on real-world usage scenarios

## Pre-Delivery Checklist

Before marking the task complete:

- [ ] Source code has been read and understood
- [ ] Test file has been read and analyzed ⚠️ REQUIRED
- [ ] Examples match test assertions ⚠️ REQUIRED
- [ ] Expected outputs align with test expectations ⚠️ REQUIRED
- [ ] Correct file path determined
- [ ] All required sections present
- [ ] TypeScript types are correct
- [ ] Code examples are executable
- [ ] Formatting matches existing docs
- [ ] No lint errors
- [ ] File created/updated successfully
