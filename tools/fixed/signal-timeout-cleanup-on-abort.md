# signalWithTimeout：基 signal 提前 abort 时自动清掉 timeout

## 问题

`signalWithTimeout` 中，只有外部显式调 `dispose()` 才会 `clearTimeout`。当 `baseSignal` 很快 abort 时，`merged.signal` 已经 aborted，但定时器仍挂着直到 `timeoutMs` 到期（`controller.abort()` 此时是 no-op，但定时器闭包 + controller 常驻）。大量取消请求场景下会把事件循环和内存拖高。

## 方案

在 `merged.signal` 上注册 `abort` 监听，触发时自动调 `dispose()` 完成 `clearTimeout` + `merged.dispose()` + 解绑自身监听。同时处理构造时 `merged.signal` 已 aborted 的边界。

### 改动（仅 `signalWithTimeout`）

```ts
// 改动前
const dispose = (): void => {
  clearTimeout(timer);
  merged.dispose();
};
return { signal: merged.signal, dispose };

// 改动后
function onAbort(): void {
  dispose();
}

const dispose = (): void => {
  clearTimeout(timer);
  merged.dispose();
  merged.signal.removeEventListener('abort', onAbort);
};
if (merged.signal.aborted) {
  dispose();
} else {
  merged.signal.addEventListener('abort', onAbort, { once: true });
}
return { signal: merged.signal, dispose };
```

### 要点

1. **构造时已 aborted**：`if (merged.signal.aborted)` 立即 `dispose()`，避免定时器泄漏
2. **外部 dispose 后清理自身监听**：`dispose` 内 `removeEventListener(onAbort)` 确保外部 dispose 后不残留无用监听
3. **幂等安全**：`clearTimeout` 对已清的 timer 是 no-op，`merged.dispose()` 内部 `listeners.length = 0` 保证多次调用安全
