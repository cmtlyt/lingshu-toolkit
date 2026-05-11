# web-locks driver：destroy() 后排队中的 acquire 仍可能成功拿锁

## 问题

`destroy()` 只释放 `holdings` 集合中已持有的锁，不取消"已发起但尚未 grant"的 `navigator.locks.request`。当 destroy 释放当前持有者后，浏览器锁管理器将锁授予排队中的 waiter，其 callback 执行、`granted.resolve(holding)` 触发，`acquire` 的 `await granted.promise` 正常返回——此时 `destroyed` 已为 `true`，但没有二次检查，handle 被直接返回给调用方。

### 时序

```
acquire(A) → grant → holding A ∈ holdings
acquire(B) → navigator.locks.request 排队中（holding = null，不在 holdings 里）
destroy()  → destroyed = true
           → drainHoldingsOnDestroy → resolveHold(A) → navigator.locks 释放 A
           → 浏览器将锁授予 B → callback 触发 → holding B 创建 → granted.resolve(B)
           → acquire(B) 的 await 返回 → 直接 buildHandleFor(B) → 调用方拿到活锁
```

调用方在 destroy 之后拿到了一个有效的 handle，破坏了"destroy = 终结"的生命周期契约。

## 方案

引入 driver 级 `AbortController`，在 `destroy` 时 abort；每次 `acquire` 将其 signal 合并到请求 signal 中。同时在 grant 后（`await granted.promise` 返回后）二次检查 `destroyed`，若已销毁则立即回收 holding 并抛 `LockAbortedError`。

### 改动

#### 1. 新增 driver 级 AbortController

在 `createWebLocksDriver` 内部，`holdings` 旁新增：

```ts
const destroyController = new AbortController();
```

#### 2. destroy 时 abort

在 `destroy()` 中，`drainHoldingsOnDestroy` 之前 abort：

```ts
function destroy(): void {
  if (destroyed) {
    return;
  }
  destroyed = true;
  destroyController.abort();
  logger.debug(`[${name}] web-locks driver: destroy (active holdings=${holdings.size})`);
  drainHoldingsOnDestroy(holdings);
}
```

#### 3. acquire 中合并 destroy signal

在 `mergeSignalWithTimeout` 之后，将 `destroyController.signal` 合并到请求 signal 中。由于 `mergeSignalWithTimeout` 已返回一个合并后的 `AbortController`，最简单的方式是在外部再监听 `destroyController.signal`：

```ts
// 在 acquire 内，mergeSignalWithTimeout 之后、构造 requestOptions 之前
function onDriverDestroy(): void {
  // 借用已有的合并 controller 的 abort —— mergeSignalWithTimeout 返回的 signal
  // 来自内部 controller，这里无法直接 abort 它；改为在 grant 后二次检查兜底
}
```

实际上，`mergeSignalWithTimeout` 内部创建了自己的 `AbortController`，外部拿不到引用来额外 abort。**但无需修改 `mergeSignalWithTimeout`**——因为 `force: true` 走 `steal` 路径（不传 signal），此时 destroy 的 abort 无法通过 signal 取消 steal 请求。因此 **signal 合并只能覆盖非 force 路径**，**二次检查是必须的兜底**。

最终方案只做二次检查即可覆盖所有路径（force 和非 force），且改动最小：

```ts
// 改动前（acquire 的 try 块）
const settled = await granted.promise;
cleanup();
return buildHandleFor(settled);

// 改动后
const settled = await granted.promise;
cleanup();

// 二次检查：grant 期间 driver 可能已被 destroy
if (destroyed) {
  // 回收刚拿到的锁：释放 navigator.locks + 移出 holdings
  settled.released = true;
  holdings.delete(settled);
  settled.resolveHold();
  throwError(
    ERROR_FN_NAME,
    `web-locks driver destroyed during acquire (token=${ctx.token})`,
    LockAbortedError as unknown as ErrorConstructor,
  );
}

return buildHandleFor(settled);
```

### 要点

1. **最小改动**：只在 `acquire` 的 `await granted.promise` 之后加一段二次检查，不改 `mergeSignalWithTimeout`、不改 `destroy`、不改 `buildHandleFor`
2. **回收语义完整**：二次检查命中时，主动 `resolveHold()` 释放 navigator.locks 占用的锁资源、从 `holdings` 移除、标记 `released`，不留泄漏
3. **覆盖 force 和非 force**：`steal: true` 路径不传 signal，无法通过 abort 取消；二次检查作为统一兜底，两条路径都安全
4. **与现有 destroy 语义一致**：抛出 `LockAbortedError`，与 destroy 后直接调 `acquire` 的错误类型相同
5. **不影响正常路径**：`destroyed` 为 `false` 时（绝大多数情况），二次检查只是一次 `if (false)` 跳过
