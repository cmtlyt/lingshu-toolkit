# Fix: `StorageAuthority.init()` 与 `dispose()` 并发悬挂 listener

> 归档目录：`src/shared/lock-data/fixes/`
> 涉及代码：`src/shared/lock-data/authority/index.ts::performInit`

## 1. 问题描述

`performInit` 是 `StorageAuthority.init()` 的实际实现，流程为：

1. `attachSessionProbeResponder`（同步）
2. `await resolveEpoch(...)` ← **唯一的 await 切点**
3. `attachAuthorityPushSubscription`（订阅 storage 推送）
4. `attachActivationPullSubscription`（订阅 pageshow / visibilitychange）
5. 初次 `applyAuthorityIfNewer('pull-on-acquire', ...)`

`await resolveEpoch` 的等待期间（典型场景：`persistence === 'session'` 时
`subscribeSessionProbe` 需等其他 Tab 响应、或等 `sessionProbeTimeout` 超时），
外部完全可能调用 `dispose()`：

```ts
const a = createStorageAuthority(deps);
const initPromise = a.init();
// ⚠️ resolveEpoch 还在 pending
a.dispose();          // → state.disposed = true，unsubscribers 清空
await initPromise;    // ← await 之后没人检查 disposed
```

await 恢复后，步骤 3/4/5 仍会执行：

- `authority.subscribe(...)` 被注册，但返回的 `unsubscribe` 不会再被调用
  （`state.unsubscribers.push` 之后再无人消费 —— dispose 早已清空数组）
- `window.addEventListener('pageshow', ...)` / `document.addEventListener('visibilitychange', ...)`
  同理悬挂
- 初次 pull 触发 `applySnapshot` + `emitSync`，把数据写到一个**已经声明销毁**
  的实例上，监听器被错误唤起

后果：
- 已销毁实例继续响应 storage 事件 → 内存泄漏 + 监听器调用预期之外的回调
- `channel.close()` 已在 `performDispose` 里调过，session-probe 响应链路其实
  已经断开，但 push/pull 订阅链路在销毁后才挂上来 —— 状态错配
- 测试套件里若 dispose 后仍接到 storage 事件，会触发 onSync 重入，导致跨用例
  污染（这正是 flaky 的根源之一）

## 2. 修复策略

**最小侵入修复**：在 `await resolveEpoch` 恢复后立刻检查 `state.disposed`，
若已销毁，**短路返回** `resolved`，跳过所有后续副作用。

```ts
const resolved = await resolveEpoch(epochCtx);

// 关键：await 期间外部可能已 dispose；此时不再回写 host.epoch、
// 不挂 push/pull、不做初次 pull —— 直接交还 resolveEpoch 结果，
// 让 dataReadyPromise 仍然能 resolve，避免 await init() 永久 pending
if (state.disposed) {
  return resolved;
}

host.epoch = resolved.epoch;
attachAuthorityPushSubscription(state, deps);
attachActivationPullSubscription(state, deps);
if (authority && !resolved.authorityCleared) {
  applyAuthorityIfNewer(state, deps, 'pull-on-acquire', authority.read());
}
return resolved;
```

### 设计要点

1. **仍然返回 `resolved`**：`init()` 的契约是返回 `Promise<ResolveEpochResult>`，
   宿主侧 `dataReadyPromise` 在 await 这个值。短路返回后契约不破坏，
   只是不再产生副作用。

2. **不回写 `host.epoch`**：dispose 后 host 已不再服务，写一个无意义的 epoch
   反而可能误导后续 race 调用（如有第三方仍持有 host 引用）。

3. **不动 step 1（`attachSessionProbeResponder`）**：
   - step 1 在 await 之前就已经把 unsubscriber 推进了 `state.unsubscribers`
   - dispose 时已经被消费了
   - 不存在悬挂

4. **不复用 `state.initialized` flag**：
   - `initialized` 防"重复 init"
   - `disposed` 防"销毁后副作用"
   - 两者语义独立，不可合并

5. **不需要事务化撤销**：dispose 已经 close 了 channel、清空了 unsubscribers；
   await 恢复后只要主动跳过 step 3-5，就不会再产生需要清理的资源。

## 3. 测试设计

**目标**：构造一个 `await resolveEpoch` 长时间 pending 的场景，
在 await 期间调用 dispose，断言所有副作用均不发生。

**触发条件**：
- `persistence: 'session'` + `channel` 可用 → `resolveEpoch` 走 session-probe
  分支，等待 `sessionProbeTimeout` 超时（或其他 Tab 响应）
- 在 `subscribeSessionProbe` post 出去之后、超时前调用 `dispose()`

**断言**：
- `authority.subscribe` 调用次数为 0（push 订阅未挂上）
- `window.addEventListener('pageshow', ...)` 没被调用（pull 订阅未挂上）
- 触发一条 storage 事件后，`emitSync` 不会被调用
- `init()` 返回的 Promise 仍然 resolve（不会卡住）

**实现路径**：
- 文件：`src/shared/lock-data/__test__/authority/init-dispose-race.node.test.ts`
- 用 mock authority/channel/sessionStore，全部用闭包记录调用情况
- 用 fake timer 推进 `sessionProbeTimeout`，在 timer 推进前调用 `dispose()`

## 4. 影响范围

- 仅修改 `performInit` 内部 await 之后的 1 个 if 分支（短路）
- 不改变现有 init 返回类型、不改变 dispose 语义
- 不影响除并发场景外的任何已有用例
- 文档：本文 + IMPLEMENTATION.md 的 Phase 7 收口段（视情况追加 7.6）
