# 修复：actions 实例对未 await 的并发写操作不安全

## 问题原文

> `src/shared/lock-data/core/actions.ts`
>
> 同一个 actions 实例的并发写操作需要串行化或显式拒绝。
>
> 当前只有 `phase === 'holding'` 才会复用已有锁。若一个 `update()` 还停在 `acquiring`/`committing`，第二个 `update()` / `replace()` / `getLock()` 会再次进入 `performAcquire()`，覆盖 `currentToken` / `currentHandle`，并让前一个事务在提交时误判为 revoked，甚至泄漏前一个 handle。这个状态机现在对“未 await 的重入调用”不安全。

## 缺陷根因

`createActions` 的 `ensureHolding` 只在 `phase === 'holding' && aliveToken !== ''` 时复用既有锁，
其他分支（包括 `acquiring` / `committing`）一律调用 `performAcquire()`。当用户**未 await
第一次写操作就发起第二次写操作**时（例如 `update#1` 还在 `await driver.acquire`，调用方紧
接着发出 `update#2`），第二次会直接覆盖 `currentToken` / `aliveToken` / `currentHandle`，
触发以下两类深层错乱：

### 错乱 1：`acquiring` 期间重入 → 伪 `LockRevokedError`

时间线（`update#1` 还停在 `await driver.acquire`）：

| t | 事件 | 关键状态 |
|---|------|---------|
| t0 | `update#1` → `performAcquire` 发 `token=A`，`currentToken=A`、`aliveToken=A`、`phase=acquiring` | A |
| t1 | `update#2`（未 await #1）→ `ensureHolding` 见 `phase=acquiring` ≠ `holding` → 进入 `performAcquire` | — |
| t2 | `performAcquire` 发 `token=B`，覆写 `currentToken=B`、`aliveToken=B`、`phase=acquiring` | B |
| t3 | `driver.acquire`（#1）resolve 拿到 `handle#A` → `aliveToken !== A` → 走 revoke 分支 → `safeReleaseHandle(handle#A)` + 抛 `LockRevokedError` | B |
| t4 | `driver.acquire`（#2）resolve 拿到 `handle#B` → `currentHandle = handle#B`、`phase=holding` | B |

**症状**：`update#1` 拒绝 `LockRevokedError`，但实际并未被任何外部源 revoke —— 调用方误以为
锁被驱动撤销，但其实只是被自己的下一次重入调用「篡位」。

### 错乱 2：`committing` 期间重入 → driver handle 泄漏

时间线（`update#1` 在 `await recipe(draft)` 阶段）：

| t | 事件 | 关键状态 |
|---|------|---------|
| t0 | `update#1` 进入 `runTransaction` → `phase=committing`、`token=A`、`currentHandle=handle#A` | A + handle#A |
| t1 | `update#1` 还在 `await recipe(draft)`（用户 async recipe） | A + handle#A |
| t2 | `update#2`（未 await #1）→ `ensureHolding` 见 `phase=committing` ≠ `holding` → 进入 `performAcquire` | — |
| t3 | `performAcquire` 发 `token=B`，`currentHandle` **仍是 `handle#A`**，但 `phase=acquiring`、`aliveToken=B` | B + handle#A 还挂着 |
| t4 | `driver.acquire(#2)` resolve 拿到 `handle#B` → `state.currentHandle = handle#B` **直接覆写 handle#A** | B + **handle#A 引用丢失** |
| t5 | `update#1` recipe 完成 → `aliveToken !== A` → 抛 `LockRevokedError` → rollback session → **`handle#A` 永远不会被 release** | 泄漏 |

**症状**：driver handle 真泄漏。WebLocks driver 意味着锁永久持有直到页面关闭；自定义
driver（跨标签 / 远程锁）可能造成跨进程锁死。

### 错乱 3：`update` + `getLock` 交叉

`update#1` 还在 acquiring，`getLock#1` 重入 → `getLock#1` 走 performAcquire 发新 token →
`update#1` 拿到的 handle 已被覆盖，`acquiredByGetLock` 标志位的归属也错乱（`getLock` 的语义
意图是「保留锁不释放」，但 `update#1` 完成时若读到错位的 `acquiredByGetLock=false` 会误把锁
立即 release，违反 `getLock` 契约）。

## 修复方案：写操作串行化（"queue-on-pending"）

在 `ActionsInternalState` 引入 `writeChain: Promise<void>` 串行链，所有需要进入
`ensureHolding + runTransaction + maybeAutoRelease` 的写操作通过 Promise 链严格 FIFO 排队，
保证同一时刻只有一个写操作处于关键区。

### 候选方向权衡

| 方向 | 优点 | 缺点 | 决议 |
|------|------|------|------|
| **A. queue（pending Promise 排队）** | 兼容现有调用方契约，符合「锁应该排队」直觉，update 串行执行符合事务语义 | 需要小心异常传播 + dispose 中断 | ✅ **采纳** |
| B. 重入直接抛 `LockBusyError` | 实现简单、最显式 | 破坏现有调用方契约（用户合理预期 `update()` 串行排队），引入新错误类型成本高 | ❌ |
| C. committing 期复用 pending 结果 | — | 会丢失第二次调用的 recipe 语义（不可能复用 update#1 的结果当作 update#2 的结果） | ❌ |

### 修复要点

1. **`ActionsInternalState` 新增 `writeChain: Promise<void>`**：初始为 `Promise.resolve()`，
   所有写操作通过 `.then(task, task)` 排队（成功失败都继续，下一个排队者不会被前一个失败污染）

2. **新增 `enqueueWrite<R>(state, task): Promise<R>` helper**：
   ```ts
   function enqueueWrite<R>(state: ActionsInternalState, task: () => Promise<R>): Promise<R> {
     // 关键 1：用 .then(task, task)（成功失败都继续）保证 FIFO 严格串行
     // 关键 2：链尾用 .then(noop, noop) 吞 reject，下一个排队者不会被前一个失败污染
     // 关键 3：调用方拿到的是 next（task 的真实结果），不是被吞错版的 chain
     const next = state.writeChain.then(task, task);
     state.writeChain = next.then(noop, noop);
     return next;
   }
   ```

3. **改造 `update` / `replace` / `getLock` 三个入口**：把
   「`ensureHolding` + `runTransaction` + `maybeAutoRelease`」整体包到 `enqueueWrite` 中。
   `ensureAlive()` 和参数校验仍在排队前同步执行（保持 fail-fast 语义不变）。

4. **dispose 协同无需额外改动**：`doDispose` 已通过 `disposedController.abort()` 中断
   in-flight `driver.acquire`；排队中的任务轮到自己执行时会先调 `ensureAlive()` 命中
   `state.disposed` 抛 `LockDisposedError`，自然短路（与 dispose-race 修复的终态契约对齐）。

### 不需要的改动

- ❌ 不引入新错误类型（如 `LockBusyError`）—— 排队语义不需要新错误
- ❌ 不修改 `performAcquire` / `runTransaction` —— 它们的并发不安全是「上层不该让多个调用同
  时进入」，串行化后天然消失
- ❌ 不改 `release()` —— 它是同步无 await 切点
- ❌ 不改 `read()` —— 它是同步纯读

### 边界场景

| 场景 | 行为 |
|------|------|
| `getLock` 持锁 + `update` 重入 | `update` 排队，等 `getLock` 的 task 完成（task 在 `ensureHolding` 后立刻 resolve，不会一直占链）→ 然后 `update` 拿到 alreadyHeld=true 复用锁 ✅ |
| 排队期间 `dispose` | 排队任务轮到时 `ensureAlive` 抛 `LockDisposedError`，调用方按 disposed 终态契约拿到错误 ✅ |
| 第一个 `update` recipe 抛业务错误 | 第二个排队 `update` 不受影响（`.then(task, task)` + 链尾 `.then(noop, noop)`），继续执行 ✅ |
| `release()` 在 `update` 中途被同步调 | `release` 同步操作不入队，与 `update` 互交错的语义不变（与现状一致，不引入新行为） |

## 测试设计

新增 `__test__/core/actions-concurrent-write.node.test.ts`，覆盖 5 组用例：

1. **`acquiring` 期间重入 `update`**：暂停 driver.acquire → 同时发 update#1 + update#2（不
   await #1）→ 断言：① 两次都成功 commit、② commit 顺序严格是 #1 → #2、③ 不出现伪
   `onRevoked` 事件、④ driver.acquire 仅被调用一次（复用锁）
2. **`committing` 期间重入 `update`**：让第一个 update 的 recipe 是 async 阻塞 → 重入第二个
   update → 断言：① 两次都成功、② 不泄漏 driver handle（driver.release 调用次数正确）、
   ③ `entry.rev` 自增两次
3. **`update` + `replace` 交叉**：update#1 acquiring → replace#1 重入 → 断言两者顺序串行，
   data 最终值是 replace 的值
4. **`update` + `getLock` 交叉**：update#1 acquiring → getLock#1 重入 → 断言 getLock 让
   actions 持锁不释放，driver.acquire 只调一次
5. **排队期间 `dispose`**：update#1 acquiring → update#2 排队 → dispose() → 断言 update#2
   被 reject `LockDisposedError`（不是 abort/timeout，符合终态契约）

## 关联文件

- `src/shared/lock-data/core/actions.ts`（核心修复：新增 `writeChain` + `enqueueWrite` +
  改造 3 个入口）
- `src/shared/lock-data/__test__/core/actions-concurrent-write.node.test.ts`（新增）
- `src/shared/lock-data/IMPLEMENTATION.md` 7.5 节（追加缺陷条目）
