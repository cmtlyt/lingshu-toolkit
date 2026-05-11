# local driver：缓存并回放"先撤销、后订阅"的 revoke 事件

## 问题

`buildLocalHandle` 中，`notifyRevoke()` 在 `onRevokedByDriver()` 注册回调之前调用时，revoke 原因被静默丢弃。

### 时序

```
pumpNextWaiter()
  → buildLocalHandle()          // revokeCallback = null
  → next.resolve(handle)        // handle 交给 Promise .then（微任务，尚未执行）
  → 同一 tick 内 seizeLock()    // prev.notifyRevoke('force') 触发
    → revokeCallback 仍为 null  // revoke 被丢弃
                                 // .then 回调在下一轮微任务执行
                                 // 调用方注册 onRevokedByDriver —— 但 revoke 已丢失
```

调用方拿到的 handle 已失效，但永远收不到撤销通知，互斥语义被静默破坏。

## 方案

在 `buildLocalHandle` 内部增加一个 `revokeReason` 缓存槽：

- `notifyRevoke(reason)` 触发时，**始终**将 `reason` 写入 `revokeReason`（无论 callback 是否已注册）
- `onRevokedByDriver(callback)` 注册时，若 `revokeReason` 已有值，立即同步回放该 reason 给 callback

### 改动（仅 `buildLocalHandle`）

```ts
// 改动前
function buildLocalHandle(
  state: LocalDriverState,
  token: string,
  onReleased: () => void,
): { handle: LockDriverHandle; notifyRevoke: LocalHolder['notifyRevoke'] } {
  const { name, logger } = state;
  let revokeCallback: ((reason: 'force' | 'timeout') => void) | null = null;

  const handle: LockDriverHandle = {
    release: () => { /* ... */ },
    onRevokedByDriver: (callback) => {
      revokeCallback = callback;
    },
  };

  return {
    handle,
    notifyRevoke: (reason) => {
      if (isFunction(revokeCallback)) {
        try {
          revokeCallback(reason);
        } catch (error) {
          logger.error(`[${name}] local driver: revoke callback threw`, error);
        }
      }
    },
  };
}

// 改动后
function buildLocalHandle(
  state: LocalDriverState,
  token: string,
  onReleased: () => void,
): { handle: LockDriverHandle; notifyRevoke: LocalHolder['notifyRevoke'] } {
  const { name, logger } = state;
  let revokeCallback: ((reason: 'force' | 'timeout') => void) | null = null;
  let revokeReason: 'force' | 'timeout' | null = null;

  const handle: LockDriverHandle = {
    release: () => { /* ... 不变 */ },
    onRevokedByDriver: (callback) => {
      revokeCallback = callback;
      // 回放：注册时若已被 revoke 过，立即补发
      if (revokeReason !== null) {
        try {
          revokeCallback(revokeReason);
        } catch (error) {
          logger.error(`[${name}] local driver: revoke callback threw`, error);
        }
      }
    },
  };

  return {
    handle,
    notifyRevoke: (reason) => {
      revokeReason = reason;
      if (isFunction(revokeCallback)) {
        try {
          revokeCallback(reason);
        } catch (error) {
          logger.error(`[${name}] local driver: revoke callback threw`, error);
        }
      }
    },
  };
}
```

### 要点

1. **零 API 变更**：`buildLocalHandle` 返回值和 `LockDriverHandle` 接口均不变，改动完全封闭在闭包内部
2. **始终缓存 reason**：`notifyRevoke` 无论 callback 是否已注册都写 `revokeReason`，正常路径下只是一次无害的冗余赋值，但让 `revokeReason` 天然具备"handle 是否已被 revoke"的判断能力，调试时断点可直接看到驱逐原因
3. **回放的错误处理**：与原 `notifyRevoke` 一致，`try-catch` + `logger.error` 兜底，不影响 driver 流转
4. **不影响正常路径**：若调用方先注册 `onRevokedByDriver` 再被 revoke，走的仍是原来的 `notifyRevoke` → `revokeCallback` 直调路径
5. **覆盖 force 与 destroy 两条路径**：`seizeLock` 和 `drainOnDestroy` 都通过 `holder.notifyRevoke('force')` 触发，统一受益于缓存机制
