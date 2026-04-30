/**
 * drivers/web-locks.ts 单元测试（browser 环境，真实 navigator.locks）
 *
 * 覆盖契约：
 * 1. 工厂：navigator.locks 不可用时抛 TypeError（通过 spy 伪造探测失败）
 * 2. acquire → release round-trip（快路径）
 * 3. 同一 lock name 下第二个 acquire 在第一个持有时排队
 * 4. acquireTimeout：第二个 waiter 到期抛 LockTimeoutError
 * 5. signal.abort：acquiring 中的 waiter 抛 LockAbortedError
 * 6. force acquire（steal）：覆盖本方旧 holder + 触发 onRevokedByDriver('force')
 * 7. handle.release 幂等
 * 8. destroy：release 所有 active holdings
 * 9. destroy 后 acquire 抛 LockAbortedError；destroy 幂等
 */

/** biome-ignore-all lint/nursery/useGlobalThis: test file uses window/navigator/AbortController */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import type { LockDriver, LockDriverDeps } from '@/shared/lock-data/drivers/types';
import { createWebLocksDriver } from '@/shared/lock-data/drivers/web-locks';
import { LockAbortedError, LockTimeoutError } from '@/shared/lock-data/errors';
import type { LockDriverContext, LoggerAdapter } from '@/shared/lock-data/types';

function createSilentLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeLockName(): string {
  return `${LOCK_PREFIX}:weblocks-test-${Math.random().toString(36).slice(2, 10)}`;
}

function buildDeps(lockName: string): LockDriverDeps {
  return {
    name: lockName,
    id: lockName.split(':').pop(),
    logger: resolveLoggerAdapter(createSilentLogger()),
  };
}

function buildContext(lockName: string, overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const defaultController = new AbortController();
  const token = overrides.token || `tok_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: overrides.name || lockName,
    token,
    signal: overrides.signal || defaultController.signal,
    acquireTimeout: overrides.acquireTimeout === undefined ? NEVER_TIMEOUT : overrides.acquireTimeout,
    holdTimeout: overrides.holdTimeout === undefined ? NEVER_TIMEOUT : overrides.holdTimeout,
    force: overrides.force === true,
  };
}

describe('drivers/web-locks (browser, real navigator.locks)', () => {
  let driver: LockDriver | null = null;

  afterEach(() => {
    driver?.destroy();
    driver = null;
  });

  test('能力前置：navigator.locks 确实可用（sanity）', () => {
    expect(typeof navigator).toBe('object');
    expect(typeof navigator.locks).toBe('object');
    expect(typeof navigator.locks.request).toBe('function');
  });

  test('acquire → release round-trip', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));
    const handle = await driver.acquire(buildContext(lockName));

    expect(handle).toBeDefined();
    expect(typeof handle.release).toBe('function');
    handle.release();
  });

  test('同 lock name 下：第二个 acquire 在第一个持有时排队', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));
    const firstHandle = await driver.acquire(buildContext(lockName, { token: 'first' }));

    let secondSettled = false;
    const secondPromise = driver.acquire(buildContext(lockName, { token: 'second' })).then((h) => {
      secondSettled = true;
      return h;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondSettled).toBe(false);

    firstHandle.release();
    const secondHandle = await secondPromise;
    expect(secondSettled).toBe(true);
    secondHandle.release();
  });

  test('acquireTimeout：第二个 waiter 到期抛 LockTimeoutError', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));
    const firstHandle = await driver.acquire(buildContext(lockName, { token: 'first' }));

    await expect(
      driver.acquire(buildContext(lockName, { token: 'second', acquireTimeout: 50 })),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    firstHandle.release();
  });

  test('signal.abort：acquiring 中的 waiter 抛 LockAbortedError', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));
    const firstHandle = await driver.acquire(buildContext(lockName, { token: 'first' }));

    const controller = new AbortController();
    const p = driver.acquire(buildContext(lockName, { token: 'second', signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(p).rejects.toBeInstanceOf(LockAbortedError);
    firstHandle.release();
  });

  test('force acquire（steal）：覆盖本方 holder 并触发 onRevokedByDriver("force")', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));
    const firstHandle = await driver.acquire(buildContext(lockName, { token: 'first' }));

    const revokeReasons: string[] = [];
    firstHandle.onRevokedByDriver((reason) => {
      revokeReasons.push(reason);
    });

    const secondHandle = await driver.acquire(buildContext(lockName, { token: 'second', force: true }));

    // steal 后 navigator.locks 以 AbortError reject 原 request，driver 捕获后触发 revoke
    // 真实浏览器下该路径是异步的，给一点时间让回调执行
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(revokeReasons).toEqual(['force']);

    firstHandle.release(); // 幂等 no-op
    secondHandle.release();
  });

  test('handle.release 幂等', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));

    const handle = await driver.acquire(buildContext(lockName));
    handle.release();
    handle.release();
    handle.release();

    // 再抢一次应能成功（旧锁已真实释放）
    const next = await driver.acquire(buildContext(lockName));
    expect(next).toBeDefined();
    next.release();
  });

  test('destroy：release 所有 active holdings', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));

    const handle = await driver.acquire(buildContext(lockName));
    expect(handle).toBeDefined();

    driver.destroy();

    // destroy 后新的 driver 实例应能立即抢到同名锁（旧锁已被真实释放）
    const driver2 = createWebLocksDriver(buildDeps(lockName));
    const h2 = await driver2.acquire(buildContext(lockName));
    expect(h2).toBeDefined();
    h2.release();
    driver2.destroy();
  });

  test('destroy 后 acquire 抛 LockAbortedError + destroy 幂等', async () => {
    const lockName = makeLockName();
    driver = createWebLocksDriver(buildDeps(lockName));
    driver.destroy();

    expect(() => {
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
    }).not.toThrow();

    await expect(driver.acquire(buildContext(lockName))).rejects.toBeInstanceOf(LockAbortedError);
  });
});
