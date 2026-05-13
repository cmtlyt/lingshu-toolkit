# Fix: `handleRevoke` 未清空 `acquiredByGetLock` 导致下一次 update 误留锁

> 归档目录：`src/shared/lock-data/fixes/`
> 涉及代码：`src/shared/lock-data/core/actions.ts::handleRevoke`

## 1. 问题描述

`acquiredByGetLock` 是 `ActionsInternalState` 上的标志位，
含义是「上一次锁是通过 `getLock()` 主动留下的」。`maybeAutoRelease`
基于此标志决定 recipe 结束后是否自动释放：

```ts
const maybeAutoRelease = (alreadyHeld: boolean): void => {
  if (alreadyHeld || state.acquiredByGetLock) {
    return;  // ← getLock 留的锁不在 recipe 边界自动释放
  }
  if (state.phase !== 'holding') {
    return;
  }
  performRelease(deps, state);
};
```

`handleRevoke` 是所有 revoke 路径（driver `onRevokedByDriver('force')`、
hold-timeout 触发、用户主动 `revoke()` API）的统一收口，但当前实现
只清理了三项：

```ts
function handleRevoke(deps, state, reason) {
  if (state.aliveToken === '') return;
  const token = state.aliveToken;
  state.aliveToken = '';
  clearHoldTimer(state);
  releaseDriverHandle(deps, state);   // → state.currentHandle = null
  transitionTo(deps, state, 'revoked', token);
  fanoutRevoked(...);
}
```

**漏清** `state.acquiredByGetLock`。

### 缺陷复现路径

```ts
await actions.getLock();        // ← state.acquiredByGetLock = true
// driver 通过 onRevokedByDriver 触发 revoke（其他 Tab force / hold-timeout）
// → handleRevoke：aliveToken='', currentHandle=null, phase='revoked'
// ❌ state.acquiredByGetLock 仍然是 true

await actions.update(recipe);
// → ensureHolding(callOpts, 'update')：phase 不是 holding → 走 performAcquire
//   注意 acquireTag !== 'getLock'，此分支不回写 acquiredByGetLock
// → recipe 执行完，进入 finally 的 maybeAutoRelease(false)
// → state.acquiredByGetLock 残留 true
// → maybeAutoRelease 第一行 return，普通 update 抢的锁不被释放
// → 这把锁会一直留到下次显式 release()/getLock()/dispose()
```

后果：
- 同 Entry 后续 update 看似返回了，但锁仍占着，其他 Tab/同 id 实例不
  能进入临界区，行为像「死锁但无报错」
- 与 `update` 的语义文档不符（recipe 边界自动释放）
- 与 `release()` / `doDispose()` 的归零行为不对称（这两处都正确清了
  `acquiredByGetLock`）

## 2. 修复策略

**最小侵入修复**：在 `handleRevoke` 内部追加 `state.acquiredByGetLock = false;`，
位置与现有的状态归零（`aliveToken` / `handle` / `holdTimer`）放在一起。

```ts
function handleRevoke(deps, state, reason) {
  if (state.aliveToken === '') return;
  const token = state.aliveToken;
  state.aliveToken = '';
  state.acquiredByGetLock = false;          // ← 新增
  clearHoldTimer(state);
  releaseDriverHandle(deps, state);
  transitionTo(deps, state, 'revoked', token);
  fanoutRevoked(...);
}
```

### 设计要点

1. **修复点选在 handleRevoke 而非 ensureHolding 入口**
   - `handleRevoke` 是 revoke 的**唯一收口**：driver `onRevokedByDriver`
     回调、`holdTimeout` 触发、`Actions.revoke` 用户 API 全部走这里
   - `performRelease`（L548-553）已经在出口处清了 `acquiredByGetLock`
   - `doDispose`（L588-595）也已经走了类似清理（虽然 dispose 后整体不再
     读这个 flag，但语义对称性已建立）
   - 因此**修复方向是补齐"持锁周期出口必清 flag"的对称性**，而不是在新
     入口 `ensureHolding` 上做粗暴防御

2. **不在 `ensureHolding` 入口主动重置**
   - 若 `alreadyHeld === true`（已经在同一周期内持锁），用户可能在前一
     次 `getLock()` 之后接着调 `update()`：此时 `acquiredByGetLock` 应
     保留前一次置位语义；入口处粗暴清零会破坏 getLock + update 串联场景

3. **revoke 之后的 phase 是 `'revoked'` 不是 `'holding'`**
   - 修复后即便 flag 仍残留也不会被 `maybeAutoRelease` 误伤——后者会
     被 `state.phase !== 'holding'` 拦下；但 flag 残留本身仍是状态污染，
     会在下一轮 acquire → holding 后再次发作（如缺陷复现路径所示）

4. **不影响 `revoked` 事件语义**
   - 修复仅改 flag，不影响 `transitionTo('revoked')` / `fanoutRevoked`
     的事件广播；订阅 `onRevoked` / `onLockStateChange` 的监听器无感知

## 3. 测试设计

新增节点测试文件：
`src/shared/lock-data/__test__/core/actions-revoke-getlock.node.test.ts`

**覆盖场景**：

| # | 路径 | 期望 |
|---|------|------|
| 1 | `getLock()` → driver `force` revoke → `update(recipe)` | recipe 后**自动 release**（phase 回 idle） |
| 2 | `getLock()` → holdTimeout revoke → `update(recipe)` | recipe 后**自动 release** |
| 3 | `getLock()` → 用户主动 `revoke()` → `update(recipe)` | recipe 后**自动 release** |
| 4 | （反向校验）`getLock()` → `update(recipe)`（无 revoke） | recipe 后**仍持锁**（getLock 语义不被误伤） |

**实施依赖**：
- 全内存 driver / adapters：复用 `__test__/_helpers/memory-adapters.ts`
  + `createInMemoryLockFactory`（Phase 7.2 已就位）的同等模式
- 用 `vi.useFakeTimers()` 推 holdTimeout
- 用 driver handle 的 `onRevokedByDriver` 直接调用模拟 force 抢占

**断言核心**：
- 修复前：`maybeAutoRelease` 会被 `acquiredByGetLock=true` 提前 return，
  `update` 后 `actions.isHolding === true`
- 修复后：`actions.isHolding === false`（已自动 release）

## 4. 影响范围

- 仅修改 `actions.ts::handleRevoke` 内部 1 行（+ 一行行内注释）
- 不改变现有 revoke / release / dispose 的对外语义
- 不影响 listeners、driver 协议、adapter 协议
- 文档：本文 + IMPLEMENTATION.md 7.5 节追加条目
