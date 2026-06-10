# 实施清单：自身属性守卫（Own-Property Guard）

> 关联 RFC：[RFC.md](./RFC.md)（v0.1.0, accepted）
> 源码：[proxy-engine.ts](../../../proxy-engine.ts)、[helpers.ts](../../../helpers.ts)、[types.ts](../../../types.ts)、[index.ts](../../../index.ts)
> 测试：[index.node.test.ts](../../../index.node.test.ts)
> 状态：✅ 全部完成（2026/06/10）

## Phase 1：helpers 新增 hasOwn

- [x] 1.1 在 `helpers.ts` 新增 `hasOwn(target, prop)` 函数（使用 `Object.hasOwn`）
- [x] 1.2 导出供 `proxy-engine.ts` 使用

## Phase 2：proxy-engine 加守卫

- [x] 2.1 `get` handler：在 `isProxyable` 判定前增加 `hasOwn(rawTarget, prop)` 守卫，仅对自身属性创建子 Proxy
- [x] 2.2 `deleteProperty` handler：用 `hasOwn(rawTarget, prop)` 守卫 emit 和 proxyCache 清理逻辑

## Phase 3：导出 PatchOp

- [x] 3.1 `types.ts`：将 `PatchOp` 改为 `export type`
- [x] 3.2 `index.ts`：re-export `PatchOp` 类型

## Phase 4：补充测试

- [x] 4.1 测试 `get` 不代理原型链上的对象属性（访问原型属性返回原始值，不产生 patch）
- [x] 4.2 测试 `set` 对原型链上已有同名属性仍能正确 emit patch 并在自身创建属性
- [x] 4.3 测试 `deleteProperty` 对原型链上的属性不产生 patch
- [x] 4.4 全量回归：66 tests 全部通过

## Phase 5：验证

- [x] 5.1 `pnpm run test:ci src/shared/change-tracker` — 66 tests passed
- [x] 5.2 `pnpm run check` — No fixes applied
- [x] 5.3 覆盖率验证 — Files dirty: 0
