---
name: lingshu-doc-writer
description: "Write lingshu-toolkit documentation in MDX format following project standards. Creates comprehensive docs with proper structure: title, version info, features, installation, usage, examples, API reference, and notes. Supports --quick (basic structure), --full (complete doc), --update (existing doc). Use when user wants to write documentation, create docs, generate MDX, write tool documentation, write hook docs, add documentation to lingshu-toolkit. Triggers: 'write documentation', 'create docs', 'generate MDX', 'write tool docs', 'write hook docs', 'add documentation', 'document the code', 'create documentation file', 'write API docs', 'write usage docs'."
---

# Doc Writer

IRON LAW: Every documentation must be type-safe, executable, and follow lingshu-toolkit's MDX structure. Never generate code that cannot run or lacks proper TypeScript types. **ABSOLUTELY FORBIDDEN: Never expose implementation details in documentation.**

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
  - [ ] 4.1 Write title and metadata (version, shadcn, author, update time in fixed format: YYYY/MM/DD HH:mm:ss)
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
  - [ ] 6.3 Run pnpm run check to check formatting
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
- Find and read the corresponding test file following lingshu-toolkit naming conventions:
  - Primary pattern: `src/shared/<utils-name>/index.{,node,browser}.test.{ts,tsx}`
  - Alternative pattern: `src/shared/<utils-name>/__test__/*.{,node,browser}?.test.{ts,tsx}`
  - Example: `src/shared/api-controller/index.node.test.ts`
- Analyze test assertions to understand expected behavior
- Extract usage patterns from test cases
- **Code examples in documentation must match test assertions**
- Use test cases as the source of truth for expected behavior

**Example:**
```
User: "Write docs for allx tool"
→ Read src/shared/allx/index.ts
→ Read src/shared/allx/*.test.ts (or similar)
→ Read src/shared/allx/__tests__/*.test.ts (or similar)
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

## Step 3: Load References ⚠️ REQUIRED

Always load references before generating content:

→ Load references/mdx-format.md for:
- **Complete MDX structure and format** (THIS IS THE SOURCE OF TRUTH)
- Required sections order and exact headings
- All section formats with complete examples
- Heading levels (##, ###, ####)
- Code block syntax and language specifiers
- Metadata format and rules
- Installation command format
- API reference table structure
- Notes/注意事项 format
- Language consistency (中文 for lingshu-toolkit)
- Quality checklist

→ Load references/terminology.md (optional, for specific needs):
- Shadcn URL format patterns
- Namespace conventions
- Section heading translations
- Terminology consistency

## Step 4: Generate Content

⚠️ **CRITICAL**: Follow references/mdx-format.md EXACTLY. This is the source of truth for all format requirements.

**DO NOT duplicate format examples in this SKILL.md.** All format specifications are maintained in references/mdx-format.md to ensure single source of truth.

### 4.1-4.6 Section Formats

For all section formats (Title/Metadata, Features, Installation, Usage Examples, API Reference, Notes/注意事项):

→ Load references/mdx-format.md and follow the exact format for each section:
- Section 1: Title and Metadata (includes package version, shadcn version, author, **update time in fixed format: YYYY/MM/DD HH:mm:ss**)
- Section 2: Features/特性
- Section 3: Installation (## 安装 + ## 用法)
- Section 4: Usage Examples (## 基础用法 + ## 高级用法)
- Section 5: API Reference (with tables and subsections)
- Section 6: Notes/注意事项 (## 注意事项 with ⚠️ and 🔧)

### Content Generation Guidelines

**For --quick:**
- Generate basic structure only
- Follow mdx-format.md section formats exactly

**For --full:**
- Generate complete documentation
- Include all sections from mdx-format.md
- Follow all formatting rules exactly

**⚠️ CRITICAL: Generate examples from test files**
- Read the corresponding test file for the tool/hook
- Extract usage patterns from test cases
- Ensure examples match test assertions exactly
- Use test assertions as the source of truth for expected behavior
- If test shows `expect(func(arg)).toBe(42)`, the example must show `func(arg) // 42`
- Document edge cases that are tested
- Include error handling examples if tests cover error scenarios
- **⚠️ ABSOLUTELY FORBIDDEN: Never reference test implementation details in documentation**
- **⚠️ Only use test assertions to verify expected behavior, never to explain how it works internally**

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

### 5.3 Format Compliance

⚠️ **CRITICAL**: Follow references/mdx-format.md Quality Checklist exactly

→ Load references/mdx-format.md and verify all items in the Quality Checklist section:
- All required sections present
- Correct heading levels (##, ###, ####)
- Proper code block language specified (tsx, ts, bash, mdx)
- TypeScript types in all examples
- Chinese for descriptive text
- Consistent formatting
- No placeholder text (TODO, FIXME)
- Code examples are executable
- Tables properly formatted with headers
- No trailing whitespace
- Blank lines between sections

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
pnpm run check
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
- **⚠️ ABSOLUTELY FORBIDDEN: Expose implementation details in documentation**
- **⚠️ NEVER include internal variable names, helper functions, or algorithm specifics**
- **⚠️ NEVER copy-paste source code implementation into documentation**
- **⚠️ NEVER describe how the code is implemented internally**
- **⚠️ Focus ONLY on usage, behavior, and API — never on implementation**

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
- **Focus on WHAT the tool does and HOW to use it**
- **Describe behavior, outcomes, and usage patterns**
- **Keep implementation details completely hidden from users**

## Writing Principles

- **Concise**: Explain clearly, avoid verbosity
- **Type-safe**: All code must have proper types
- **Executable**: Examples should run without modification
- **Consistent**: Match existing documentation style
- **Complete**: Cover all important aspects (for --full)
- **Practical**: Focus on real-world usage scenarios
- **⚠️ ABSOLUTELY FORBIDDEN: Never expose implementation details**
- **User-facing**: Document behavior and usage, never internal implementation
- **Black-box approach**: Treat tools as black boxes — describe inputs and outputs only

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
- [ ] **⚠️ CRITICAL: No implementation details exposed in documentation**
- [ ] **⚠️ CRITICAL: No internal variable names or helper functions mentioned**
- [ ] **⚠️ CRITICAL: No source code implementation copied into docs**
- [ ] **⚠️ CRITICAL: Only usage, behavior, and API are documented**
