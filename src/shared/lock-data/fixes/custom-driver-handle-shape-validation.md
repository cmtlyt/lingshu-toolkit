# custom driver：获取用户 handle 后立即做运行时形状校验

## 问题

`createCustomLockDriver` 的 `acquire` 函数中，`getLock` 返回的 `handle` 直接传给 `wrapUserHandle`，未做任何运行时形状校验：

```ts
// src/shared/lock-data/drivers/custom.ts L173-177
const result = getLock(userCtx);
const handle = await Promise.resolve(result);
cleanup();
logger.debug(`[${name}] custom driver: grant token=${ctx.token}`);
return wrapUserHandle(handle, deps, ctx.token);
```

`wrapUserHandle` 内部直接取 `handle.release` 赋值给 `userRelease`，并在 `wrapped.release` 中以 `userRelease.call(handle)` 调用。若用户 `getLock` 返回了一个缺少 `release` 字段或 `release` 不是函数的对象，错误会延迟到**锁释放阶段**才以不直观的 `TypeError: userRelease.call is not a function` 暴露，定位成本很高——因为错误发生在 `wrapUserHandle` 的闭包内部，而非用户工厂返回的位置。

## 方案

在 `wrapUserHandle` 调用前，对 `handle` 做最小形状校验，确保 `release` 是函数。校验失败时使用 `throwError` 抛出明确的 `TypeError`，指出是用户 `getLock` 返回了不合规的 handle。

### 改动

在 `acquire` 函数中，`await` 解析 handle 后、`cleanup()` 之前，插入校验逻辑：

```ts
// 改动前
const result = getLock(userCtx);
const handle = await Promise.resolve(result);
cleanup();
logger.debug(`[${name}] custom driver: grant token=${ctx.token}`);
return wrapUserHandle(handle, deps, ctx.token);

// 改动后
const result = getLock(userCtx);
const handle = await Promise.resolve(result);

// 运行时形状校验：release 是 LockDriverHandle 的必要契约
if (!handle || !isFunction(handle.release)) {
  throwError(
    ERROR_FN_NAME,
    `adapters.getLock must return an object with a "release" function, `
      + `got ${handle == null ? String(handle) : typeof handle.release} `
      + `(token=${ctx.token})`,
    TypeError,
  );
}

cleanup();
logger.debug(`[${name}] custom driver: grant token=${ctx.token}`);
return wrapUserHandle(handle, deps, ctx.token);
```

### 校验位置：`cleanup()` 之前

校验放在 `cleanup()` **之前**，遵循"先验货，再收工"原则：

1. **fail-fast**：拿到 handle 的第一时间校验，不让任何后续逻辑基于非法 handle 运行
2. **资源不泄漏**：校验抛出的 TypeError 会进入 `catch` 块，`catch` 开头就调了 `cleanup()`，合并 signal / 超时定时器会被正常清理
3. **错误不会被误分类**：`catch` 块的 `getTimeoutFired()` 和 `ctx.signal.aborted` 检查的是 signal 状态，与 handle 形状无关；只要没触发 timeout/abort，TypeError 会走 `catch` 最后的 `throw error` 原样透传

### 要点

1. **错误归因到用户工厂**：错误消息直接指向 `adapters.getLock` 的返回值问题，而非隐晦的 `userRelease.call is not a function`
2. **最小校验范围**：只校验 `release` 是否为函数。`onRevokedByDriver` 是可选的（`wrapUserHandle` 内部已有 `isFunction` 守卫），不纳入强制校验
3. **错误信息包含诊断上下文**：输出实际拿到的类型（`null` / `undefined` / 实际 `typeof`）和 `token`，方便定位是哪次 acquire 出了问题
4. **复用现有工具函数**：使用已导入的 `isFunction` 做类型判断，使用 `throwError` + `TypeError` 遵循项目错误规范
5. **不改 `wrapUserHandle` 签名**：校验职责放在调用侧（`acquire`），`wrapUserHandle` 保持"信任入参"的纯包装角色，职责边界清晰
