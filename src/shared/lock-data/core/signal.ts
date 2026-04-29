/**
 * AbortSignal 合并工具
 *
 * 为什么不直接用 `AbortSignal.any`：
 * - 较老 Safari / Node 18 不支持，而 lock-data 目标环境包括 SSR / Node 多进程
 * - 需要在 polyfill 路径里正确处理"构造时已有 signal 处于 aborted 态"的边界
 *
 * 语义与 `AbortSignal.any` 一致：任一输入 signal abort 即派生 signal abort；
 * 若构造时已有任何输入为 aborted，则派生 signal 立即 aborted
 */

type SignalLike = AbortSignal | null | undefined;

/**
 * 合并任意数量的 AbortSignal；null / undefined 会被过滤
 *
 * 返回值：
 * - `signal`：合并后的派生 signal
 * - `dispose`：手动解绑所有监听（避免长生命周期 signal 泄漏）
 */
function anySignal(signals: readonly SignalLike[]): { signal: AbortSignal; dispose: () => void } {
  const validSignals = signals.filter((signal): signal is AbortSignal => signal instanceof AbortSignal);

  // 优先走原生 AbortSignal.any，避免 polyfill 在 Chrome / Node 20+ 下引入多余监听
  if (typeof AbortSignal.any === 'function') {
    const signal = AbortSignal.any(validSignals);
    return { signal, dispose: noop };
  }

  const controller = new AbortController();
  const alreadyAborted = validSignals.find((signal) => signal.aborted);
  if (alreadyAborted !== undefined) {
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, dispose: noop };
  }

  const listeners: Array<() => void> = [];
  // 数组遍历优先使用索引 for 循环（见 IMPLEMENTATION.md 开发守则「代码风格 - 循环形式」）
  for (let i = 0; i < validSignals.length; i++) {
    const source = validSignals[i];
    const onAbort = (): void => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => source.removeEventListener('abort', onAbort));
  }

  const dispose = (): void => {
    for (let i = 0; i < listeners.length; i++) {
      listeners[i]();
    }
    listeners.length = 0;
  };

  return { signal: controller.signal, dispose };
}

function noop(): void {
  /* no-op */
}

/**
 * 把已有 signal（若未完成）+ 超时合成一个新 signal
 *
 * 返回值包含 `dispose`，用于提前清理 setTimeout（如 action 正常完成时）
 */
function signalWithTimeout(baseSignal: SignalLike, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const merged = anySignal([baseSignal, controller.signal]);

  const dispose = (): void => {
    clearTimeout(timer);
    merged.dispose();
  };
  return { signal: merged.signal, dispose };
}

export type { SignalLike };
export { anySignal, signalWithTimeout };
