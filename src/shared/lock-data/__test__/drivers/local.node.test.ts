/**
 * drivers/local.ts 单元测试（node 环境，无外部依赖）
 *
 * 覆盖契约：
 * 1. 快路径 acquire → release round-trip
 * 2. FIFO 排队：多个 waiter 按入队顺序授予
 * 3. acquireTimeout：排队 waiter 到期抛 LockTimeoutError
 * 4. signal.abort：acquiring 中的 waiter 抛 LockAbortedError
 * 5. signal.aborted 进入 acquire 抛 LockAbortedError（同步快路径）
 * 6. force acquire：覆盖当前 holder，触发 onRevokedByDriver('force')；旧 release 幂等
 * 7. handle.release 幂等
 * 8. destroy：pending waiters 全部 abort，当前 holder revoke('force')
 * 9. destroy 后 acquire 抛 LockAbortedError
 * 10. destroy 幂等
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import { createLocalLockDriver } from '@/shared/lock-data/drivers/local';
import type { LockDriver, LockDriverDeps } from '@/shared/lock-data/drivers/types';
import { LockAbortedError, LockTimeoutError } from '@/shared/lock-data/errors';
import type { LockDriverContext, LoggerAdapter } from '@/shared/lock-data/types';

function createSilentLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function buildDeps(): LockDriverDeps {
  return {
    name: `${LOCK_PREFIX}:__local__`,
    id: undefined,
    logger: resolveLoggerAdapter(createSilentLogger()),
  };
}

function buildContext(overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const defaultController = new AbortController();
  const token = overrides.token || `tok_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: overrides.name || `${LOCK_PREFIX}:__local__`,
    token,
    signal: overrides.signal || defaultController.signal,
    acquireTimeout: overrides.acquireTimeout === undefined ? NEVER_TIMEOUT : overrides.acquireTimeout,
    holdTimeout: overrides.holdTimeout === undefined ? NEVER_TIMEOUT : overrides.holdTimeout,
    force: overrides.force === true,
  };
}

describe('drivers/local (node)', () => {
  let driver: LockDriver | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    driver?.destroy();
    driver = null;
  });

  test('快路径 acquire → release round-trip', async () => {
    driver = createLocalLockDriver(buildDeps());
    const handle = await driver.acquire(buildContext());

    expect(handle).toBeDefined();
    expect(typeof handle.release).toBe('function');
    handle.release();
  });

  test('多个 waiter 严格 FIFO 授予', async () => {
    driver = createLocalLockDriver(buildDeps());
    const firstHandle = await driver.acquire(buildContext({ token: 't1' }));
    const grantedOrder: string[] = [];

    const p2 = driver.acquire(buildContext({ token: 't2' })).then((h) => {
      grantedOrder.push('t2');
      return h;
    });
    const p3 = driver.acquire(buildContext({ token: 't3' })).then((h) => {
      grantedOrder.push('t3');
      return h;
    });
    const p4 = driver.acquire(buildContext({ token: 't4' })).then((h) => {
      grantedOrder.push('t4');
      return h;
    });

    firstHandle.release();
    (await p2).release();
    (await p3).release();
    (await p4).release();

    expect(grantedOrder).toEqual(['t2', 't3', 't4']);
  });

  test('acquireTimeout：排队 waiter 到期抛 LockTimeoutError', async () => {
    driver = createLocalLockDriver(buildDeps());
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const pendingAcquire = driver.acquire(buildContext({ token: 'second', acquireTimeout: 30 }));
    // 先注册 rejection handler 防止 unhandled rejection，再推进 fake timer
    const assertion = expect(pendingAcquire).rejects.toBeInstanceOf(LockTimeoutError);
    await vi.advanceTimersByTimeAsync(30);
    await assertion;

    firstHandle.release();
  });

  test('signal.abort：acquiring 中的 waiter 抛 LockAbortedError', async () => {
    driver = createLocalLockDriver(buildDeps());
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const controller = new AbortController();
    const p = driver.acquire(buildContext({ token: 'second', signal: controller.signal }));
    // 刷微任务：waiter 入队是同步的，仅需让 Promise executor 执行完成
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(p).rejects.toBeInstanceOf(LockAbortedError);
    firstHandle.release();
  });

  test('已 aborted 的 signal：acquire 立即抛 LockAbortedError', async () => {
    driver = createLocalLockDriver(buildDeps());

    const controller = new AbortController();
    controller.abort();

    await expect(driver.acquire(buildContext({ signal: controller.signal }))).rejects.toBeInstanceOf(LockAbortedError);
  });

  test('force acquire：覆盖当前 holder + 触发 onRevokedByDriver("force")', async () => {
    driver = createLocalLockDriver(buildDeps());
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const revokeReasons: string[] = [];
    firstHandle.onRevokedByDriver((reason) => {
      revokeReasons.push(reason);
    });

    const secondHandle = await driver.acquire(buildContext({ token: 'second', force: true }));

    expect(revokeReasons).toEqual(['force']);

    // 旧 handle.release 幂等 no-op —— 不应影响 secondHandle 的持有
    firstHandle.release();

    // 再起第三个 waiter，此时应被 second 阻塞
    let thirdSettled = false;
    const thirdPromise = driver.acquire(buildContext({ token: 'third' })).then((h) => {
      thirdSettled = true;
      return h;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(thirdSettled).toBe(false);

    secondHandle.release();
    (await thirdPromise).release();
  });

  test('handle.release 幂等', async () => {
    driver = createLocalLockDriver(buildDeps());
    const handle = await driver.acquire(buildContext());

    handle.release();
    handle.release();
    handle.release();

    const next = await driver.acquire(buildContext());
    expect(next).toBeDefined();
    next.release();
  });

  test('destroy：pending waiters 全部 abort + 当前 holder revoke(force)', async () => {
    driver = createLocalLockDriver(buildDeps());
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const revokeReasons: string[] = [];
    firstHandle.onRevokedByDriver((reason) => {
      revokeReasons.push(reason);
    });

    const p2 = driver.acquire(buildContext({ token: 'second' }));
    const p3 = driver.acquire(buildContext({ token: 'third' }));
    await vi.advanceTimersByTimeAsync(0);

    driver.destroy();

    expect(revokeReasons).toEqual(['force']);
    await expect(p2).rejects.toBeInstanceOf(LockAbortedError);
    await expect(p3).rejects.toBeInstanceOf(LockAbortedError);

    // 旧 handle.release 幂等 no-op（destroy 已清 holder）
    firstHandle.release();
  });

  test('destroy 后 acquire 抛 LockAbortedError', async () => {
    driver = createLocalLockDriver(buildDeps());
    driver.destroy();

    await expect(driver.acquire(buildContext())).rejects.toBeInstanceOf(LockAbortedError);
  });

  test('destroy 幂等', () => {
    driver = createLocalLockDriver(buildDeps());
    expect(() => {
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
    }).not.toThrow();
  });

  test('revoke 回调抛错时降级 logger.error 不影响 driver 流转（force 抢锁触发 revoke）', async () => {
    const errorMock = vi.fn();
    const logger: LoggerAdapter = { warn: vi.fn(), error: errorMock, debug: vi.fn() };
    // @ts-expect-error test
    driver = createLocalLockDriver({ name: `${LOCK_PREFIX}:__revoke-throw__`, id: undefined, logger });

    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));
    firstHandle.onRevokedByDriver(() => {
      throw new Error('revoke-callback-throws');
    });

    // force 抢占触发原 holder 的 onRevokedByDriver；其内部抛错应被 catch 并 logger.error
    const secondHandle = await driver.acquire(buildContext({ token: 'second', force: true }));

    expect(errorMock).toHaveBeenCalled();
    expect(errorMock.mock.calls.some((call) => /revoke callback threw/u.test(String(call[0])))).toBe(true);

    // driver 自身仍然正常工作：第三个 waiter 应当能阻塞在 second 后面
    let thirdSettled = false;
    const thirdPromise = driver.acquire(buildContext({ token: 'third' })).then((h) => {
      thirdSettled = true;
      return h;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(thirdSettled).toBe(false);

    secondHandle.release();
    (await thirdPromise).release();
  });

  /**
   * 残余分支补测（覆盖 local.ts 未触达点）
   *
   * 1. notifyRevoke 中 revokeCallback 未注册的早退分支（line 108：isFunction(revokeCallback)=false）
   * 2. seizeLock 在无 holder 时的快路径（line 165：state.holder=null 跳过 prev.notifyRevoke）
   * 3. waiter abort 后再触发 signal/timeout 的 settled=true 重入分支（line 200/208/216）
   * 4. release 后再 release 的幂等分支（已被「handle.release 幂等」覆盖；这里不重复）
   */
  describe('残余分支：notifyRevoke / seizeLock / waiter settled 重入', () => {
    test('force 抢锁但原 holder 没有注册 onRevokedByDriver → 命中 isFunction(revokeCallback)=false 早退', async () => {
      driver = createLocalLockDriver(buildDeps());
      // 故意不调用 onRevokedByDriver，让 revokeCallback 保持 null
      const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

      // force 抢占应当走 isFunction(revokeCallback)=false 早退分支，不抛错
      const secondHandle = await driver.acquire(buildContext({ token: 'second', force: true }));
      expect(secondHandle).toBeDefined();

      firstHandle.release(); // 幂等 no-op
      secondHandle.release();
    });

    test('force 抢锁但当前没有 holder（队列空闲）→ 命中 seizeLock state.holder=null 早退分支', async () => {
      driver = createLocalLockDriver(buildDeps());

      // 锁空闲时 force acquire 也应走 seizeLock，但跳过驱逐分支（line 165 if state.holder false）
      const handle = await driver.acquire(buildContext({ token: 'lonely', force: true }));
      expect(handle).toBeDefined();
      handle.release();
    });

    test('waiter signal abort 后再触发 timeout → 命中 abort 内部 settled=true 早退（line 216-217）', async () => {
      driver = createLocalLockDriver(buildDeps());
      const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

      const controller = new AbortController();
      const p = driver.acquire(
        buildContext({
          token: 'second',
          signal: controller.signal,
          acquireTimeout: 30,
        }),
      );

      // 刷微任务：waiter 入队是同步的，仅需让 Promise executor 执行完成
      await vi.advanceTimersByTimeAsync(0);
      // 先 abort（settled=true），再让 timeout 到期 —— timeout cb 内 waiter.abort 会再次进入 abort
      // 此时 waiter 已被 removeWaiter 出队 → removeWaiter 内 for 循环找不到 target（命中 line 148 false 分支）
      controller.abort();
      await expect(p).rejects.toBeInstanceOf(LockAbortedError);

      // 推进 fake timer 使 acquireTimeout:30 的定时器触发，验证不抛错（settled=true 直接 return）
      await vi.advanceTimersByTimeAsync(30);

      firstHandle.release();
    });

    test('waiter resolve 后再触发 abort/signal → 命中 resolve / abort settled=true 早退分支', async () => {
      driver = createLocalLockDriver(buildDeps());
      const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

      const controller = new AbortController();
      const p = driver.acquire(buildContext({ token: 'second', signal: controller.signal }));

      await vi.advanceTimersByTimeAsync(0);
      // 释放第一个 → 第二个 waiter resolve（settled=true）
      firstHandle.release();
      const secondHandle = await p;
      expect(secondHandle).toBeDefined();

      // 此时 secondHandle 已被 grant，再 abort 不应影响（waiter 已 cleanup signal listener）
      controller.abort();
      // 验证 second 仍然可以 release，driver 流转正常
      expect(() => secondHandle.release()).not.toThrow();
    });

    test('revoke 回放：force 抢占发生在 onRevokedByDriver 注册前 → 注册时立即补发', async () => {
      driver = createLocalLockDriver(buildDeps());
      const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

      // 排队第二个 waiter
      const p2 = driver.acquire(buildContext({ token: 'second' }));

      // 释放 first → second 被 grant（通过 pumpNextWaiter → next.resolve(handle)）
      firstHandle.release();
      const secondHandle = await p2;

      // 此时 secondHandle 已拿到，但还没注册 onRevokedByDriver
      // 立即 force 抢占 → notifyRevoke('force') 触发时 revokeCallback 为 null
      const thirdHandle = await driver.acquire(buildContext({ token: 'third', force: true }));

      // 现在才注册回调 → 应当立即回放缓存的 'force'
      const revokeReasons: string[] = [];
      secondHandle.onRevokedByDriver((reason) => {
        revokeReasons.push(reason);
      });

      expect(revokeReasons).toEqual(['force']);

      thirdHandle.release();
    });

    test('revoke 回放：destroy 发生在 onRevokedByDriver 注册前 → 注册时立即补发', async () => {
      driver = createLocalLockDriver(buildDeps());
      const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

      // 排队第二个 waiter
      const p2 = driver.acquire(buildContext({ token: 'second' }));
      firstHandle.release();
      const secondHandle = await p2;

      // destroy 触发 notifyRevoke('force')，但此时回调未注册
      driver.destroy();
      driver = null;

      // 后注册回调 → 回放
      const revokeReasons: string[] = [];
      secondHandle.onRevokedByDriver((reason) => {
        revokeReasons.push(reason);
      });

      expect(revokeReasons).toEqual(['force']);
    });

    test('revoke 回放：回调抛错时降级 logger.error', async () => {
      const errorMock = vi.fn();
      const logger: LoggerAdapter = { warn: vi.fn(), error: errorMock, debug: vi.fn() };
      // @ts-expect-error test
      driver = createLocalLockDriver({ name: `${LOCK_PREFIX}:__replay-throw__`, id: undefined, logger });

      const firstHandle = await driver.acquire(buildContext({ token: 'first' }));
      const p2 = driver.acquire(buildContext({ token: 'second' }));
      firstHandle.release();
      const secondHandle = await p2;

      // force 抢占，此时回调未注册
      const thirdHandle = await driver.acquire(buildContext({ token: 'third', force: true }));

      // 注册一个会抛错的回调 → 回放时应 catch 并 logger.error
      secondHandle.onRevokedByDriver(() => {
        throw new Error('replay-callback-throws');
      });

      expect(errorMock).toHaveBeenCalled();
      expect(errorMock.mock.calls.some((call) => /revoke callback threw/u.test(String(call[0])))).toBe(true);

      thirdHandle.release();
    });

    test('多个 waiter 等待 + 释放：pumpNextWaiter 出队列空时早退（line 132-133 + line 200 settled）', async () => {
      driver = createLocalLockDriver(buildDeps());
      const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

      // 队列只有 1 个 waiter，释放后队列变空，pumpNextWaiter 第二次调用命中 waiters.length=0 早退
      const p2 = driver.acquire(buildContext({ token: 'second' }));
      firstHandle.release();
      const secondHandle = await p2;

      // 此时再 release，pumpNextWaiter 触发但队列已空 → 命中 line 132 next=undefined 早退
      secondHandle.release();

      // driver 仍然正常
      const handle = await driver.acquire(buildContext({ token: 'third' }));
      expect(handle).toBeDefined();
      handle.release();
    });
  });
});
