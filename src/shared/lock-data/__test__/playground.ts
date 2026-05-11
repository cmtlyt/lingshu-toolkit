import { LockDisposedError, lockData, NEVER_TIMEOUT, ReadonlyMutationError } from '../index';

// ---------------------------------------------------------------------------
// 日志工具
// ---------------------------------------------------------------------------

type LogLevel = 'info' | 'success' | 'error' | 'warn' | 'event';

function log(message: string, level: LogLevel = 'info') {
  const logEl = document.getElementById('log')!;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-${level}">${message}</span>`;
  logEl.prepend(entry);
}

function setError(message: string) {
  document.getElementById('last-error')!.textContent = message;
}

// ---------------------------------------------------------------------------
// 1. 基础实例：同步初始化
// ---------------------------------------------------------------------------

const [view, actions] = lockData({
  getValue: () => {
    return { count: 0, label: 'init' };
  },
  listeners: {
    onCommit: (event) => {
      log(
        `onCommit <span class="tag tag-rev">rev ${event.rev}</span> source=${event.source} snapshot=${JSON.stringify(event.snapshot)}`,
        'event',
      );
      refreshBasicDisplay();
    },
    onLockStateChange: (event) => {
      log(`onLockStateChange <span class="tag tag-phase">${event.phase}</span>`, 'event');
      refreshHoldingDisplay();
    },
    onRevoked: (event) => {
      log(`onRevoked reason=${event.reason}`, 'event');
    },
  },
});

function refreshBasicDisplay() {
  document.getElementById('view-count')!.textContent = String(view.count);
  document.getElementById('view-label')!.textContent = view.label;
}

function refreshHoldingDisplay() {
  document.getElementById('is-holding')!.textContent = String(actions.isHolding);
}

refreshBasicDisplay();
log('基础实例已创建（同步初始化）', 'success');

// ---------------------------------------------------------------------------
// 基础读写
// ---------------------------------------------------------------------------

async function doIncrement() {
  await actions.update((draft) => {
    draft.count += 1;
  });
  refreshBasicDisplay();
  log(`count +1 → ${view.count}`, 'success');
}

async function doDecrement() {
  await actions.update((draft) => {
    draft.count -= 1;
  });
  refreshBasicDisplay();
  log(`count -1 → ${view.count}`, 'success');
}

async function doReplace() {
  await actions.replace({ count: 100, label: 'replaced' });
  refreshBasicDisplay();
  log(`replace → count=${view.count}, label=${view.label}`, 'success');
}

function doSnapshot() {
  const snap = actions.snapshot();
  log(`snapshot → ${JSON.stringify(snap)}`, 'info');
}

// ---------------------------------------------------------------------------
// 只读保护 & 错误
// ---------------------------------------------------------------------------

function doWriteView() {
  try {
    (view as { count: number }).count = 999;
    log('未抛错（不应该到这里）', 'error');
  } catch (error) {
    const isExpected = error instanceof ReadonlyMutationError;
    const message = error instanceof Error ? error.message : String(error);
    log(`捕获 ReadonlyMutationError: ${message} (instanceof=${isExpected})`, isExpected ? 'success' : 'error');
    setError(`ReadonlyMutationError: ${message}`);
  }
}

function doDeleteView() {
  try {
    // @ts-expect-error 测试运行时只读保护
    // biome-ignore lint/performance/noDelete: test
    delete view.count;
    log('未抛错（不应该到这里）', 'error');
  } catch (error) {
    const isExpected = error instanceof ReadonlyMutationError;
    const message = error instanceof Error ? error.message : String(error);
    log(`捕获 ReadonlyMutationError (delete): ${message}`, isExpected ? 'success' : 'error');
    setError(`ReadonlyMutationError: ${message}`);
  }
}

async function doUseAfterDispose() {
  const [, tempActions] = lockData({
    getValue: () => {
      return { x: 1 };
    },
  });
  await tempActions.dispose();
  try {
    await tempActions.update((draft) => {
      draft.x = 2;
    });
    log('未抛错（不应该到这里）', 'error');
  } catch (error) {
    const isExpected = error instanceof LockDisposedError;
    const message = error instanceof Error ? error.message : String(error);
    log(`捕获 LockDisposedError: ${message} (instanceof=${isExpected})`, isExpected ? 'success' : 'error');
    setError(`LockDisposedError: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 手动持锁
// ---------------------------------------------------------------------------

async function doGetLock() {
  await actions.getLock({ holdTimeout: NEVER_TIMEOUT });
  refreshHoldingDisplay();
  log(`getLock (holdTimeout=NEVER_TIMEOUT) → isHolding=${actions.isHolding}`, 'success');
}

async function doUpdateWhileHolding() {
  await actions.update((draft) => {
    draft.count += 10;
  });
  refreshBasicDisplay();
  log(`持锁 update → count=${view.count}`, 'success');
}

function doRelease() {
  actions.release();
  refreshHoldingDisplay();
  log(`release → isHolding=${actions.isHolding}`, 'success');
}

// ---------------------------------------------------------------------------
// 跨模块共享（同 id）
// ---------------------------------------------------------------------------

let sharedActions: Awaited<ReturnType<typeof createSharedInstance>>['actions'] | null = null;
let sharedView: Awaited<ReturnType<typeof createSharedInstance>>['view'] | null = null;

async function createSharedInstance() {
  const [v, a] = lockData({
    id: 'playground-shared',
    getValue: () => {
      return { counter: 0 };
    },
  });
  return { view: v, actions: a };
}

async function doCreateShared() {
  const instance = await createSharedInstance();
  sharedView = instance.view;
  sharedActions = instance.actions;
  document.getElementById('shared-counter')!.textContent = String(sharedView.counter);
  log(`shared 实例已创建 id=playground-shared counter=${sharedView.counter}`, 'success');
}

async function doSharedUpdate() {
  if (!(sharedActions && sharedView)) {
    log('请先创建 shared 实例', 'warn');
    return;
  }
  await sharedActions.update((draft) => {
    draft.counter += 5;
  });
  document.getElementById('shared-counter')!.textContent = String(sharedView.counter);
  log(`shared update → counter=${sharedView.counter}`, 'success');
}

function doSharedRead() {
  if (!sharedView) {
    log('请先创建 shared 实例', 'warn');
    return;
  }
  document.getElementById('shared-counter')!.textContent = String(sharedView.counter);
  log(`shared read → counter=${sharedView.counter}`, 'info');
}

async function doSharedDispose() {
  if (!sharedActions) {
    log('请先创建 shared 实例', 'warn');
    return;
  }
  await sharedActions.dispose();
  log('shared 实例已 dispose', 'success');
  sharedActions = null;
  sharedView = null;
  document.getElementById('shared-counter')!.textContent = '-';
}

// ---------------------------------------------------------------------------
// 跨 Tab 同步（storage-authority）
// ---------------------------------------------------------------------------

let crossTabView: { value: number } | null = null;
let crossTabActions: any = null;
let crossTabRev = 0;

async function doInitCrossTab() {
  try {
    const [v, a] = await lockData({
      id: 'playground-cross-tab',
      syncMode: 'storage-authority',
      getValue: () => {
        return { value: 0 };
      },
      listeners: {
        onSync: (event) => {
          crossTabRev = event.rev;
          log(
            `[跨Tab] onSync rev=${event.rev} source=${event.source} snapshot=${JSON.stringify(event.snapshot)}`,
            'event',
          );
          refreshCrossTabDisplay();
        },
        onCommit: (event) => {
          crossTabRev = event.rev;
          log(`[跨Tab] onCommit rev=${event.rev}`, 'event');
          refreshCrossTabDisplay();
        },
      },
    });
    crossTabView = v;
    crossTabActions = a;
    refreshCrossTabDisplay();
    log('跨 Tab 实例已初始化（打开多个 Tab 试试！）', 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`跨 Tab 初始化失败: ${message}`, 'error');
  }
}

function refreshCrossTabDisplay() {
  if (crossTabView) {
    document.getElementById('cross-tab-value')!.textContent = String(crossTabView.value);
    document.getElementById('cross-tab-rev')!.textContent = String(crossTabRev);
  }
  document.getElementById('cross-tab-holding')!.textContent = crossTabActions ? String(crossTabActions.isHolding) : '-';
}

async function doCrossTabUpdate() {
  if (!(crossTabActions && crossTabView)) {
    log('请先初始化跨 Tab 实例', 'warn');
    return;
  }
  await crossTabActions.update((draft: { value: number }) => {
    draft.value += 1;
  });
  refreshCrossTabDisplay();
  log(`跨 Tab update → value=${crossTabView.value}`, 'success');
}

function doCrossTabRead() {
  if (!crossTabView) {
    log('请先初始化跨 Tab 实例', 'warn');
    return;
  }
  refreshCrossTabDisplay();
  log(`跨 Tab read → value=${crossTabView.value}`, 'info');
}

async function doCrossTabGetLock() {
  if (!crossTabActions) {
    log('[跨Tab] 请先初始化跨 Tab 实例', 'warn');
    return;
  }
  try {
    await crossTabActions.getLock({ holdTimeout: NEVER_TIMEOUT });
    refreshCrossTabDisplay();
    log(`[跨Tab] getLock → isHolding=${crossTabActions.isHolding}（其他 Tab 的 update 会排队等待）`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[跨Tab] getLock 失败: ${message}`, 'error');
  }
}

async function doCrossTabUpdateWhileHolding() {
  if (!crossTabActions) {
    log('[跨Tab] 请先初始化跨 Tab 实例', 'warn');
    return;
  }
  try {
    await crossTabActions.update((draft: { value: number }) => {
      draft.value += 10;
    });
    refreshCrossTabDisplay();
    log(`[跨Tab] 持锁 update → value=${crossTabView?.value}`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[跨Tab] 持锁 update 失败: ${message}`, 'error');
  }
}

function doCrossTabRelease() {
  if (!crossTabActions) {
    log('[跨Tab] 请先初始化跨 Tab 实例', 'warn');
    return;
  }
  crossTabActions.release();
  refreshCrossTabDisplay();
  log(`[跨Tab] release → isHolding=${crossTabActions.isHolding}`, 'success');
}

async function doCrossTabDispose() {
  if (!crossTabActions) {
    log('请先初始化跨 Tab 实例', 'warn');
    return;
  }
  await crossTabActions.dispose();
  log('跨 Tab 实例已 dispose', 'success');
  crossTabView = null;
  crossTabActions = null;
  document.getElementById('cross-tab-value')!.textContent = '-';
  document.getElementById('cross-tab-rev')!.textContent = '-';
  document.getElementById('cross-tab-holding')!.textContent = '-';
}

// ---------------------------------------------------------------------------
// AbortSignal 控制
// ---------------------------------------------------------------------------

let abortController: AbortController | null = null;
let abortableView: { count: number } | null = null;
let abortableActions: any = null;

function doCreateAbortable() {
  abortController = new AbortController();
  const [v, a] = lockData({
    getValue: () => {
      return { count: 0 };
    },
    signal: abortController.signal,
  });
  abortableView = v;
  abortableActions = a;
  document.getElementById('abortable-count')!.textContent = String(abortableView.count);
  log('可取消实例已创建', 'success');
}

async function doAbortableUpdate() {
  if (!(abortableActions && abortableView)) {
    log('请先创建可取消实例', 'warn');
    return;
  }
  try {
    await abortableActions.update((draft: { count: number }) => {
      draft.count += 1;
    });
    document.getElementById('abortable-count')!.textContent = String(abortableView.count);
    log(`abortable update → count=${abortableView.count}`, 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`abortable update 失败: ${message}`, 'error');
  }
}

function doAbort() {
  if (!abortController) {
    log('请先创建可取消实例', 'warn');
    return;
  }
  abortController.abort();
  log('已调用 abort()，实例等价 dispose', 'success');
}

async function doAbortableUpdateAfterAbort() {
  if (!abortableActions) {
    log('请先创建可取消实例', 'warn');
    return;
  }
  try {
    await abortableActions.update((draft: { count: number }) => {
      draft.count += 1;
    });
    log('未抛错（不应该到这里）', 'error');
  } catch (error) {
    const isExpected = error instanceof LockDisposedError;
    const message = error instanceof Error ? error.message : String(error);
    log(
      `abort 后 update 捕获 LockDisposedError: ${message} (instanceof=${isExpected})`,
      isExpected ? 'success' : 'error',
    );
    setError(`LockDisposedError: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 清空日志
// ---------------------------------------------------------------------------

function clearLog() {
  document.getElementById('log')!.innerHTML = '';
}

// ---------------------------------------------------------------------------
// 挂载到 window（供 HTML onclick 调用）
// ---------------------------------------------------------------------------

Object.assign(globalThis, {
  doIncrement,
  doDecrement,
  doReplace,
  doSnapshot,
  doWriteView,
  doDeleteView,
  doUseAfterDispose,
  doGetLock,
  doUpdateWhileHolding,
  doRelease,
  doCreateShared,
  doSharedUpdate,
  doSharedRead,
  doSharedDispose,
  doInitCrossTab,
  doCrossTabUpdate,
  doCrossTabRead,
  doCrossTabGetLock,
  doCrossTabUpdateWhileHolding,
  doCrossTabRelease,
  doCrossTabDispose,
  doCreateAbortable,
  doAbortableUpdate,
  doAbort,
  doAbortableUpdateAfterAbort,
  clearLog,
});
