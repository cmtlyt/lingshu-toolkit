# broadcast driver：已 abort 的请求不应参与竞选

## 问题

`acquireBroadcastLock` 中，`buildWaiter` 对 `ctx.signal.aborted` 的处理是 `queueMicrotask(() => onSignalAbort())`，异步排一个 abort。但 `buildWaiter` 返回后，Promise executor **同步地**继续执行：根据条件把 waiter 交给 `startForceCampaign` / `startAnnounceCampaign` 或塞进 `state.waiters`。

microtask 要等同步代码跑完才执行，所以一个本应立即失败的 acquire 会**先参与竞选发出协议消息**，然后才被 abort 清理。这会扰乱其他 tab 的仲裁与退避。

## 方案

在 `acquireBroadcastLock` 的 Promise executor 中，`buildWaiter` 返回后、参与竞选/入队前，检查 `ctx.signal.aborted`。若已 abort，直接 `return`，跳过竞选和入队逻辑。`buildWaiter` 内部已排好的 microtask 会在下一轮 microtask 中调 `waiter.abort()` → `waiter.reject()` → `reject(error)`，Promise 正常 reject。

### 改动（仅 `acquireBroadcastLock`）

```ts
// 改动前
return new Promise<LockDriverHandle>((resolve, reject) => {
  const waiter = buildWaiter(ctx, state, resolve, reject);

  if (ctx.force) {
    startForceCampaign(state, waiter);
    return;
  }
  // ...
});

// 改动后
return new Promise<LockDriverHandle>((resolve, reject) => {
  const waiter = buildWaiter(ctx, state, resolve, reject);

  // 已 abort 的请求不参与竞选，等 microtask 中 waiter.abort() 触发 reject
  if (ctx.signal.aborted) {
    return;
  }

  if (ctx.force) {
    startForceCampaign(state, waiter);
    return;
  }
  // ...
});
```

### 要点

1. **不改 buildWaiter**：`buildWaiter` 的 microtask abort 逻辑保持不变，它负责异步 reject Promise
2. **只在调用侧拦截**：`acquireBroadcastLock` 是唯一把 waiter 交给竞选/入队的地方，在这里拦截最干净
3. **waiter 不入队、不竞选**：不会有多余的 `removeWaiter` 清理，因为根本没进去过

## 方案 B：函数入口 early return（✅ 采用）

在进入 Promise executor 之前，函数入口处直接检查 `ctx.signal.aborted`，显式 `Promise.reject`。

### 改动（仅 `acquireBroadcastLock`）

```ts
function acquireBroadcastLock(state: BroadcastDriverState, ctx: LockDriverContext): Promise<LockDriverHandle> {
  if (ctx.signal.aborted) {
    return Promise.reject(
      new LockAbortedError(
        `[\`@cmtlyt/lingshu-toolkit\`#${ERROR_FN_NAME}]: acquire aborted (token=${ctx.token})`,
      ),
    );
  }

  // driver.acquire 的返回类型是 Promise —— destroyed 必须以 rejection 形式返回，
  // 不能同步 throw（破坏 Promise 契约，调用方 .catch 拿不到）
  if (state.destroyed) {
    // ...
  }
  // ...
}
```

### 要点

1. **最早拦截，零副作用**：在 waiter 创建、监听器注册、BroadcastChannel 消息发出之前就短路
2. **显式 reject，语义清晰**：调用者直接看到 abort → reject，无需追溯 microtask 链
3. **与 `destroyed` 守卫风格一致**：两个前置守卫并列，形成统一的防御模式

## 方案对比

| 维度 | 方案 A（executor 内拦截） | 方案 B（函数入口 early return） |
|------|--------------------------|-------------------------------|
| **拦截时机** | `buildWaiter` 之后 | 函数最顶部 |
| **副作用** | 仍创建 waiter + 监听器 | 零副作用 |
| **reject 方式** | 隐式（microtask） | 显式 `Promise.reject` |
| **可读性** | 需追溯 microtask 链 | 一目了然 |
| **与现有风格一致性** | 一般 | 与 `destroyed` 守卫对称 |
| **改动量** | 略小 | 略大但不多 |

### 结论

采用**方案 B**。遵循 fail-fast + early return 原则，零副作用、语义清晰，且与已有的 `destroyed` 守卫形成统一防御模式。方案 A 的 `buildWaiter` 内部 microtask 兜底逻辑保持不变，作为"进入 executor 后才 abort"场景的兜底。
