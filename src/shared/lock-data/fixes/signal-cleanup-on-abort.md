# anySignal polyfill 路径：首次 abort 后主动解绑剩余 source 监听

## 问题

在 `anySignal` 的 polyfill 路径中（`AbortSignal.any` 不可用时），为每个 source signal 注册了 `{ once: true }` 的 `abort` 监听。当某个 source abort 触发 `onAbort` 后：

- 派生 controller 已经 `abort()`，任务完成
- **但其余 source 上的 `{ once: true }` 监听仍然挂着**，直到各自 abort 或外部手动调 `dispose()`
- 对长生命周期 signal（如全局 disposed signal），controller + onAbort 闭包会被常驻，造成内存泄漏

## 方案

**在 `onAbort` 回调内部，完成 `controller.abort()` 后立即调用 `dispose()` 清理所有剩余监听。**

### 改动点（仅 `signal.ts` polyfill 分支）

将 `dispose` 声明提到 `for` 循环之前。`dispose` 闭包引用的是 `listeners` 数组，循环中 push 进去的解绑函数天然可见，无需额外的变量提升技巧。

```ts
// 改动前：dispose 在循环之后声明，onAbort 无法调用它
const onAbort = (): void => controller.abort(source.reason);
// ... 循环结束 ...
const dispose = ...;

// 改动后：dispose 提到循环前，onAbort 内 abort 后立即清理
const dispose = (): void => { ... };
// ... 循环中 ...
const onAbort = (): void => {
  controller.abort(source.reason);
  dispose();
};
```

### 需要注意的边界

1. **重入安全**：`dispose` 内部会遍历 `listeners` 并 `removeEventListener`，而 `onAbort` 本身也在 `listeners` 中。由于 `{ once: true }` 的语义，触发 `onAbort` 的那个 source 的监听已被浏览器自动移除，`removeEventListener` 对其调用是幂等的 no-op，不会出错。
2. **多次调用 `dispose`**：外部仍可能调用返回的 `dispose()`，需要保证幂等——当前实现 `listeners.length = 0` 已经保证了这点。
3. **`signalWithTimeout`**：它内部调 `anySignal` 后包装了一层 `dispose`，不受影响——`anySignal` 内部提前清理只会让外层 `dispose` 变成 no-op。

### 不涉及的路径

- **原生 `AbortSignal.any` 路径**：返回 `noop` dispose，浏览器引擎内部管理生命周期，无需改动。
- **构造时已 aborted 的早退路径**：不注册任何监听，无需改动。
