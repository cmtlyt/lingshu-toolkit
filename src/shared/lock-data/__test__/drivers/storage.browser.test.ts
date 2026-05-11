/**
 * drivers/storage.ts 在真实浏览器下的契约测试
 *
 * 关注点（基于代码实际行为，不做假设）：
 * 1. 非 force acquire → release 的快路径 round-trip
 * 2. 同 driver 实例下连续 acquire：FIFO 排队 + release 后按序授予
 * 3. acquireTimeout：第二个 waiter 等不到时抛 LockTimeoutError
 * 4. signal.abort：acquiring 中的 waiter 抛 LockAbortedError
 * 5. force acquire：覆盖本方旧 holder，触发 onRevokedByDriver('force')
 * 6. handle.release 幂等（重复调用无副作用）
 * 7. driver.destroy：pending waiters 被 abort 抛 LockAbortedError
 * 8. driver.destroy 后再次 acquire 抛 LockAbortedError
 * 9. 已 aborted 的 signal 进入 acquire 立即抛 LockAbortedError
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import { createStorageDriver } from '@/shared/lock-data/drivers/storage';
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

function buildDeps(id: string): LockDriverDeps {
  return {
    name: `${LOCK_PREFIX}:${id}`,
    id,
    logger: resolveLoggerAdapter(createSilentLogger()),
  };
}

/**
 * 构造完整 LockDriverContext —— 所有字段必填（见 types.ts:122）
 * - `acquireTimeout` / `holdTimeout` 默认 NEVER_TIMEOUT（永不超时）
 * - `force` 默认 false
 * - 未传 signal 时用一个未 abort 的 fresh controller
 */
function buildContext(overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const defaultController = new AbortController();
  const token = overrides.token || `tok_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: overrides.name || `${LOCK_PREFIX}:storage-ctx:driver-lock`,
    token,
    signal: overrides.signal || defaultController.signal,
    acquireTimeout: overrides.acquireTimeout === undefined ? NEVER_TIMEOUT : overrides.acquireTimeout,
    holdTimeout: overrides.holdTimeout === undefined ? NEVER_TIMEOUT : overrides.holdTimeout,
    force: overrides.force === true,
  };
}

function makeId(): string {
  return `storage-driver-${Math.random().toString(36).slice(2, 10)}`;
}

describe('drivers/storage (browser, real localStorage)', () => {
  let driver: LockDriver | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    driver?.destroy();
    driver = null;
    localStorage.clear();
  });

  test('工厂：非浏览器环境 / 无 id 抛错', () => {
    expect(() =>
      createStorageDriver({
        name: `${LOCK_PREFIX}:`,
        id: undefined,
        logger: resolveLoggerAdapter(createSilentLogger()),
      }),
    ).toThrow(TypeError);

    expect(() =>
      createStorageDriver({
        name: `${LOCK_PREFIX}:`,
        id: '',
        logger: resolveLoggerAdapter(createSilentLogger()),
      }),
    ).toThrow(TypeError);
  });

  test('快路径 acquire → release round-trip', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    const handle = await driver.acquire(buildContext());

    expect(handle).toBeDefined();
    expect(typeof handle.release).toBe('function');

    handle.release();
  });

  test('handle.release 幂等：多次调用无副作用', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    const handle = await driver.acquire(buildContext());

    handle.release();
    handle.release();
    handle.release();

    // 再抢一次应能立即成功（说明状态已正确回 idle）
    const next = await driver.acquire(buildContext());
    expect(next).toBeDefined();
    next.release();
  });

  test('同 driver 实例下：第二个 acquire 在第一个持有时排队', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    let secondSettled = false;
    const secondPromise = driver.acquire(buildContext({ token: 'second' })).then((handle) => {
      secondSettled = true;
      return handle;
    });

    // 允许 microtask + 短暂真实时间让第二个 waiter 进入队列
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondSettled).toBe(false);

    firstHandle.release();

    const secondHandle = await secondPromise;
    expect(secondSettled).toBe(true);
    secondHandle.release();
  });

  test('acquireTimeout：第二个 waiter 到期抛 LockTimeoutError', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    await expect(driver.acquire(buildContext({ token: 'second', acquireTimeout: 50 }))).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    firstHandle.release();
  });

  test('signal.abort：acquiring 中的 waiter 抛 LockAbortedError', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const controller = new AbortController();
    const secondPromise = driver.acquire(buildContext({ token: 'second', signal: controller.signal }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(secondPromise).rejects.toBeInstanceOf(LockAbortedError);

    firstHandle.release();
  });

  test('已 aborted 的 signal：acquire 立即抛 LockAbortedError', async () => {
    driver = createStorageDriver(buildDeps(makeId()));

    const controller = new AbortController();
    controller.abort();

    await expect(driver.acquire(buildContext({ signal: controller.signal }))).rejects.toBeInstanceOf(LockAbortedError);
  });

  test('force acquire：覆盖本方旧 holder，触发 onRevokedByDriver("force")', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const revokeReasons: string[] = [];
    firstHandle.onRevokedByDriver((reason) => {
      revokeReasons.push(reason);
    });

    const secondHandle = await driver.acquire(buildContext({ token: 'second', force: true }));

    expect(revokeReasons).toEqual(['force']);

    // 旧 handle.release 幂等 no-op（状态已被 force 切换给第二个 handle）
    firstHandle.release();

    secondHandle.release();
  });

  test('destroy：pending waiters 被 abort 抛 LockAbortedError', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const secondPromise = driver.acquire(buildContext({ token: 'second' }));
    // 等待 second 进入队列
    await new Promise((resolve) => setTimeout(resolve, 20));

    driver.destroy();

    await expect(secondPromise).rejects.toBeInstanceOf(LockAbortedError);

    // 防止 afterEach 重复 destroy
    firstHandle.release();
  });

  test('destroy 后再次 acquire 抛 LockAbortedError', async () => {
    driver = createStorageDriver(buildDeps(makeId()));
    driver.destroy();

    await expect(driver.acquire(buildContext())).rejects.toBeInstanceOf(LockAbortedError);
  });

  test('destroy 幂等：多次调用无副作用', () => {
    driver = createStorageDriver(buildDeps(makeId()));
    expect(() => {
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
    }).not.toThrow();
  });

  test('多个 waiter 严格 FIFO 授予', async () => {
    driver = createStorageDriver(buildDeps(makeId()));

    const firstHandle = await driver.acquire(buildContext({ token: 't1' }));
    const grantedOrder: string[] = [];

    const p2 = driver.acquire(buildContext({ token: 't2' })).then((h) => {
      grantedOrder.push('t2');
      return h;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const p3 = driver.acquire(buildContext({ token: 't3' })).then((h) => {
      grantedOrder.push('t3');
      return h;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const p4 = driver.acquire(buildContext({ token: 't4' })).then((h) => {
      grantedOrder.push('t4');
      return h;
    });

    firstHandle.release();
    const h2 = await p2;
    h2.release();
    const h3 = await p3;
    h3.release();
    const h4 = await p4;
    h4.release();

    expect(grantedOrder).toEqual(['t2', 't3', 't4']);
  });
});
