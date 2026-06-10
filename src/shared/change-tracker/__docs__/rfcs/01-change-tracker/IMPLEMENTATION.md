# 实施清单：changeTracker

> 关联 RFC：[RFC.md](./RFC.md)（v0.1.0, accepted）
> 源码：[index.ts](../../../index.ts)
> 状态：✅ 已完成（2026/06/10）

## Phase 1: 基础设施

- [x] 注册工具到 `meta/toolkit.meta.json`（name: `changeTracker`）
- [x] 运行 `pnpm script:gen-file` 生成文件骨架
- [x] 定义类型：`Patch`、`PatchOp`、`CustomTypeConfig`、`TrackerOptions`、`ReplayOptions`、`RecorderInstance`

## Phase 2: 核心 Proxy 引擎

- [x] 实现深度代理工厂（懒代理：首次访问嵌套对象时才创建子 Proxy）
- [x] 实现路径追踪（每个子 Proxy 通过闭包持有路径前缀）
- [x] 实现 `set` trap — 记录 `{ op: 'set', path, value }` Patch
- [x] 实现 `deleteProperty` trap — 记录 `{ op: 'delete', path }` Patch
- [x] 实现数组变异方法拦截（`push`/`pop`/`shift`/`unshift`/`splice`），合并为单一 `splice` Patch
- [x] 实现自定义类型序列化：记录时遍历 `types[]`，匹配则序列化 `value` 和 `splice.items` 中每项，并写入 `Patch.type`

## Phase 3: API 实现

- [x] 实现 `recordTransaction(baseObject, changeFn, options?)` — 事务模式
  - 创建深度代理 draft
  - 执行 changeFn(draft)
  - 收集 patches 并返回
  - 确保 baseObject 不被修改
- [x] 实现 `createRecorder(baseObject, options?)` — 持续监听模式
  - 返回 `{ proxy, flush(), dispose() }`
  - flush 清空缓冲区并返回 patches（通过 PatchEmitter 回调解决引用替换问题）
  - dispose 后操作 proxy 使用 `throwError` 报错
- [x] 实现 `replay(baseObject, patchList, options?)` — 重放
  - 初始化时将 `types[]` 转为 `Map<string, CustomTypeConfig>` 优化查找
  - `mutate: false` 时深拷贝后应用
  - `mutate: true` 时原地修改
  - Patch 按 timestamp 升序应用
  - 支持 `set`/`delete`/`splice` 三种 op

## Phase 4: 导出 & 集成

- [x] 在工具 `index.ts` 中导出 `recordTransaction`、`createRecorder`、`replay` 三个函数（末尾集中 `export { xxx }`）
- [x] 仅导出用户必须使用的类型：`Patch`、`CustomTypeConfig`、`TrackerOptions`、`ReplayOptions`、`RecorderInstance`
- [x] 内部类型（如 `PatchOp`）不导出
- [x] 确认 `src/shared/index.ts` 正确 re-export

## Phase 5: 测试

- [x] 测试 recordTransaction：基础 set、嵌套对象、数组 push/splice、自定义类型序列化、baseObject 不被修改
- [x] 测试 createRecorder：proxy 操作记录、flush 清空、dispose 后报错
- [x] 测试 replay：基础重放、mutate 模式、自定义类型反序列化、timestamp 排序
- [x] 测试 recorder + replay 联动：record → 传输 → replay 后状态一致

## Phase 6: 验证

- [x] `pnpm run check` 无 lint 错误
- [x] `pnpm run test:ci` 全部通过（44 tests, node 环境）
- [x] `pnpm run build` 构建成功
- [x] `tsc --noEmit` 零类型错误
