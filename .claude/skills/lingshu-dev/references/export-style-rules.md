# Export Style Rules

## Tool Entry Files (`src/{namespace}/{tool-name}/index.ts`)

All exports MUST be at the END of the file using `export { xxx }` format.

```typescript
// ... implementation code ...

export { dataHandler };
export { $dt, $t, defineTransform } from './tools';
```

## Helper Files (`utils`, `types`, etc.)

All methods and types MUST use `export function`, `export const`, `export interface`, or `export type`.

Do NOT use `export *` in helper files.

```typescript
export function isEmptyArray(value: any): boolean { ... }
export type ValueType = string | number;
```

## Quick Reference

| File Type | Export Style | Example |
|---|---|---|
| Tool entry (`index.ts`) | `export { name }` at file END | `export { myTool };` |
| Helper (`utils.ts`) | Inline `export` on declaration | `export function helper() {}` |
| Types (`types.ts`) | Inline `export` on declaration | `export type MyType = ...` |
| Re-export from sub-module | `export { name } from './path'` at file END | `export { util } from './utils';` |

## Anti-Patterns

- ❌ `export default` — 项目不使用默认导出
- ❌ `export *` — 不允许通配符导出
- ❌ 在 entry file 中间穿插 export — 必须集中在末尾
- ❌ 在 helper file 用末尾集中 export — helper 应使用行内 export
