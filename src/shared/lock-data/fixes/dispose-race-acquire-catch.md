# Fix: `performAcquire` catch 路径在 dispose-race 下违反终态契约

> 归档目录：`src/shared/lock-data/fixes/`
> 涉及代码：`src/shared/lock-data/core/actions.ts::performAcquire`

## 1. 问题描述

`performAcquire` 在 `await driver.acquire(...)` 期间，如果外部触发
`dispose()`：

1. `doDispose` 把 `disposedController.abort(...)`
2. driver 监听 `ctx.signal` → 立即 reject（`AbortError` 等）
3. `performAcquire` 进入 catch 分支：

```ts
} catch (error) {
  // ❌ 不区分 dispose 引发的 abort 和正常 acquire 失败
  state.aliveToken = '';
  transitionTo(deps, state, 'idle', token);             // ⚠️ 1
  throw translateAcquireError(error, signalBundle.timeoutController); // ⚠️ 2
} finally {
  signalBundle.dispose();
}
```

**两处违例**：

- ⚠️ **1**：`doDispose` 已经把 phase 流转到 `disposed` 终态；catch 路径
  又广播一次 `idle` 状态变更——`onLockStateChange` 监听器先收到
  `disposed`、再收到 `idle`，**违反「disposed 是终态」契约**
- ⚠️ **2**：`update()` / `getLock()` 调用方拿到的是 `LockAbortedError`
  / `LockTimeoutError`，**与「disposed 后任何方法都 reject
  LockDisposedError」契约不一致**——上层无法区分「外部 signal abort」
  与「实例 disposed」

### 缺陷复现路径

```ts
const promise = actions.update(recipe);
// → ensureHolding → performAcquire → driver.acquire 在 await 中

await actions.dispose();
// → doDispose: disposedController.abort()
// → driver 监听 ctx.signal 立即 reject (AbortError)
// → performAcquire 进入 catch:
//     state.aliveToken = ''  (doDispose 已置为 ''，重复赋值无效但无害)
//     transitionTo(idle, token)  ← ⚠️ 在 disposed 终态后又回退一次
//     throw LockAbortedError    ← ⚠️ 调用方拿到的是 abort 错误

await promise;  // ❌ 拒绝时是 LockAbortedError 而非 LockDisposedError
```

### 与成功路径的对称性缺失

成功路径已经在 acquire 后立即检查 disposed（actions.ts L411-415）：

```ts
if (state.disposed || state.aliveToken !== token) {
  safeReleaseHandle(deps, handle);
  if (state.disposed) {
    throwDisposed();  // ✅ 成功路径正确处理
  }
  throwError(..., 'lock revoked before activation', LockRevokedError, ...);
}
```

**catch 路径漏齐**了同样的检查 —— 这是「成功路径已对齐、失败路径漏齐」的明显疏漏。

## 2. 修复策略

**最小侵入修复**：在 catch 分支起始处优先检查 `state.disposed`，是则
直接走 `throwDisposed(error)` 保留 disposed 终态，不再 `transitionTo(idle)`、
不再翻译错误。

```ts
} catch (error) {
  // dispose 与 in-flight acquire 竞争：disposed 是终态，不能再回退到 idle，
  // 且调用方应拿到 LockDisposedError 而非 abort/timeout 错误（语义对齐
  // 「disposed 后任何方法都 reject LockDisposedError」契约）。
  // 把原始错误作为 cause 透传，便于排障定位是哪条路径触发了 dispose。
  if (state.disposed) {
    throwDisposed(error);
  }
  state.aliveToken = '';
  transitionTo(deps, state, 'idle', token);
  throw translateAcquireError(error, signalBundle.timeoutController);
} finally {
  signalBundle.dispose();
}
```

### 设计要点

1. **修复点选在 catch 分支起始处**
   - 是 dispose-race 唯一可观察的状态机违例点（成功路径已经对齐）
   - 与成功路径的 `if (state.disposed) throwDisposed()` 形成对称

2. **不再做 `state.aliveToken = ''`**
   - `doDispose` 在触发 abort 前已经把 `aliveToken = ''`
   - 修复后 catch 进来时 `state.disposed === true` → 立即 throwDisposed
     退出，原 catch 末尾的清理是为「正常 acquire 失败」设计，dispose 路径
     已由 doDispose 自己接管

3. **`throwDisposed(error)` 把原错误作为 cause**
   - `throwDisposed` 已支持 cause 参数，传入原始 abort/timeout 错误便于排障
   - 与 `ensureDataReady` 中 `if (state.disposed) throwDisposed()` 写法一致

4. **finally 仍然执行 `signalBundle.dispose()`**
   - try/catch/finally 的 finally 块在 catch 路径 throw 后仍会执行 →
     signal 资源不会泄漏

5. **不影响成功路径**
   - 成功路径的 dispose-race 分支（L411-415）已经正确处理：归还 handle +
     throwDisposed
   - 本次修复仅补齐 catch 路径的对称性

## 3. 测试设计

新增节点测试文件：
`src/shared/lock-data/__test__/core/actions-dispose-race.node.test.ts`

**覆盖场景**：

| # | 路径 | 期望 |
|---|------|------|
| 1 | `update()` 启动 → driver acquire pending → `dispose()` → driver 按 signal reject | `update()` 拒绝 `LockDisposedError`（不是 `LockAbortedError`） |
| 2 | 同上场景 | `onLockStateChange` 序列只到 `disposed` 终态，**不出现 disposed 之后再回退到 idle** |
| 3 | 反向校验：单纯 acquire 失败（没 dispose）路径 | 仍然 phase 回 idle 且抛 `LockAbortedError`/`LockTimeoutError`（修复未误伤正常失败路径） |

**实施依赖**：
- 复用 `actions.browser.test.ts` 风格的 stub driver，但增强 driver 监听
  `ctx.signal` 并在 abort 时 reject 的能力（这是缺陷复现的前提）
- 用 `pauseNextAcquire()` 模式控制 acquire pending 时机

## 4. 影响范围

- 仅在 `performAcquire` catch 起始处追加 4 行（含注释）
- 不改变现有正常失败路径（abort / timeout）的语义
- 不改变 listeners、driver 协议、adapter 协议
- 文档：本文 + IMPLEMENTATION.md 7.5 节追加条目
