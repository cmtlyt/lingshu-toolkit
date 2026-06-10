# 实施清单：changeTracker — 按模块拆分重构

> 关联 RFC：[RFC.md](./RFC.md)（v0.1.0, accepted）
> 源码：[index.ts](../../../index.ts)
> 状态：✅ 已完成（2026/06/10）

## Phase 1: 创建模块文件

- [x] 创建 `types.ts`：搬入所有类型定义（Patch, PatchOp, CustomTypeConfig, TrackerOptions, ReplayOptions, RecorderInstance, PatchEmitter）
- [x] 创建 `helpers.ts`：搬入 serializeValue, serializeItems, isProxyable, deepClone
- [x] 创建 `proxy-engine.ts`：搬入 createDeepProxy, ARRAY_MUTATORS, emitSplicePatch, SplicePatchInfo, arrayMutatorHandlers, createArrayMutatorTrap
- [x] 创建 `record.ts`：搬入 recordTransaction, createRecorder
- [x] 创建 `replay.ts`：搬入 replay, resolvePathParent, deserializeValue, applyPatch

## Phase 2: 重写入口文件

- [x] 将 `index.ts` 改为纯 re-export（末尾集中 `export { xxx }` 规范）
- [x] 仅导出公开 API：recordTransaction, createRecorder, replay
- [x] 仅导出公开类型：Patch, CustomTypeConfig, TrackerOptions, ReplayOptions, RecorderInstance

## Phase 3: 验证

- [x] `pnpm run check` 无 lint 错误
- [x] `pnpm run test:ci` 全部通过（44 tests，测试文件零修改）
- [x] `pnpm run build` 构建成功
