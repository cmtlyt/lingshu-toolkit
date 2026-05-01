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

import { afterEach, describe, expect, test, vi } from 'vitest';
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

  afterEach(() => {
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

    await expect(driver.acquire(buildContext({ token: 'second', acquireTimeout: 30 }))).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    firstHandle.release();
  });

  test('signal.abort：acquiring 中的 waiter 抛 LockAbortedError', async () => {
    driver = createLocalLockDriver(buildDeps());
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const controller = new AbortController();
    const p = driver.acquire(buildContext({ token: 'second', signal: controller.signal }));
    // 等待 p 进入队列
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    await new Promise((resolve) => setTimeout(resolve, 10));

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
});
