/**
 * drivers/broadcast.ts 在真实浏览器下的契约测试（同 Tab 同 driver 实例）
 *
 * ⚠️ 说明：真实浏览器中，同一 Tab 内的两个 BroadcastChannel 实例**不会**互相收到
 * 自己的 postMessage；因此同 Tab 下 broadcast driver 实际行为近似 local driver
 * —— 所有 acquire 的仲裁都走本地 state，不经 channel 回响。
 * 真·跨 Tab 的 BC-1~BC-7 协议行为属于 Phase 4 / 集成测试范畴。
 *
 * 本文件只验证同 driver 实例下的核心契约：
 * 1. 非 force acquire → release round-trip
 * 2. 同实例下 FIFO 排队 + release 后按序授予
 * 3. acquireTimeout
 * 4. signal.abort
 * 5. force acquire：本方 holder 被抢占，触发 onRevokedByDriver('force')
 * 6. handle.release 幂等
 * 7. destroy：pending waiters 被 abort
 * 8. destroy 后 acquire 抛 LockAbortedError
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildChannelName, createDefaultChannelAdapter } from '@/shared/lock-data/adapters/channel';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import { createBroadcastDriver } from '@/shared/lock-data/drivers/broadcast';
import type { LockDriver, LockDriverDeps } from '@/shared/lock-data/drivers/types';
import { LockAbortedError, LockTimeoutError } from '@/shared/lock-data/errors';
import type { ChannelAdapter, ChannelAdapterContext, LockDriverContext, LoggerAdapter } from '@/shared/lock-data/types';

function createSilentLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function buildDeps(id: string): LockDriverDeps {
  const logger = resolveLoggerAdapter(createSilentLogger());
  return {
    name: `${LOCK_PREFIX}:${id}`,
    id,
    logger,
    getChannel: (ctx: ChannelAdapterContext): ChannelAdapter | null => createDefaultChannelAdapter(ctx, { logger }),
  };
}

/**
 * 构造完整 LockDriverContext —— 所有字段必填（见 types.ts:122）
 */
function buildContext(overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const defaultController = new AbortController();
  const token = overrides.token || `tok_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: overrides.name || `${LOCK_PREFIX}:broadcast-ctx`,
    token,
    signal: overrides.signal || defaultController.signal,
    acquireTimeout: overrides.acquireTimeout === undefined ? NEVER_TIMEOUT : overrides.acquireTimeout,
    holdTimeout: overrides.holdTimeout === undefined ? NEVER_TIMEOUT : overrides.holdTimeout,
    force: overrides.force === true,
  };
}

function makeId(): string {
  return `broadcast-driver-${Math.random().toString(36).slice(2, 10)}`;
}

describe('drivers/broadcast (browser, real BroadcastChannel)', () => {
  let driver: LockDriver | null = null;

  beforeEach(() => {
    // 清理可能的残留（理论上每个测试都新 id，但保险起见）
  });

  afterEach(() => {
    driver?.destroy();
    driver = null;
  });

  test('工厂：缺 getChannel / 缺 id 抛错', () => {
    const logger = resolveLoggerAdapter(createSilentLogger());

    // 缺 getChannel
    expect(() =>
      createBroadcastDriver({
        name: `${LOCK_PREFIX}:x`,
        id: 'x',
        logger,
      }),
    ).toThrow(TypeError);

    // 缺 id
    expect(() =>
      createBroadcastDriver({
        name: `${LOCK_PREFIX}:`,
        id: '',
        logger,
        getChannel: (ctx) => createDefaultChannelAdapter(ctx, { logger }),
      }),
    ).toThrow(TypeError);
  });

  test('工厂：getChannel 返回 null 时抛错', () => {
    const logger = resolveLoggerAdapter(createSilentLogger());
    expect(() =>
      createBroadcastDriver({
        name: `${LOCK_PREFIX}:x`,
        id: 'x',
        logger,
        getChannel: () => null,
      }),
    ).toThrow(TypeError);
  });

  test('buildChannelName 仍然工作（sanity）', () => {
    expect(buildChannelName('abc', 'custom')).toBe(`${LOCK_PREFIX}:abc:custom`);
  });

  test('acquire → release round-trip', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));

    const handle = await driver.acquire(buildContext());
    expect(handle).toBeDefined();
    handle.release();
  });

  test('handle.release 幂等', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));

    const handle = await driver.acquire(buildContext());
    handle.release();
    handle.release();
    handle.release();

    const next = await driver.acquire(buildContext());
    expect(next).toBeDefined();
    next.release();
  });

  test('同 driver 实例：第二个 acquire 在第一个持有时排队', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    let secondSettled = false;
    const secondPromise = driver.acquire(buildContext({ token: 'second' })).then((handle) => {
      secondSettled = true;
      return handle;
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(secondSettled).toBe(false);

    firstHandle.release();

    const secondHandle = await secondPromise;
    expect(secondSettled).toBe(true);
    secondHandle.release();
  });

  test('acquireTimeout：第二个 waiter 到期抛 LockTimeoutError', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    await expect(driver.acquire(buildContext({ token: 'second', acquireTimeout: 80 }))).rejects.toBeInstanceOf(
      LockTimeoutError,
    );

    firstHandle.release();
  });

  test('signal.abort：acquiring 中的 waiter 抛 LockAbortedError', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const controller = new AbortController();
    const secondPromise = driver.acquire(buildContext({ token: 'second', signal: controller.signal }));

    await new Promise((resolve) => setTimeout(resolve, 80));
    controller.abort();

    await expect(secondPromise).rejects.toBeInstanceOf(LockAbortedError);

    firstHandle.release();
  });

  test('已 aborted 的 signal：acquire 立即抛 LockAbortedError', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    const controller = new AbortController();
    controller.abort();

    await expect(driver.acquire(buildContext({ signal: controller.signal }))).rejects.toBeInstanceOf(LockAbortedError);
  });

  test('force acquire：覆盖本方旧 holder，触发 onRevokedByDriver("force")', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const revokeReasons: string[] = [];
    firstHandle.onRevokedByDriver((reason) => {
      revokeReasons.push(reason);
    });

    const secondHandle = await driver.acquire(buildContext({ token: 'second', force: true }));

    expect(revokeReasons).toEqual(['force']);

    firstHandle.release(); // 幂等 no-op
    secondHandle.release();
  });

  test('destroy：pending waiters 被 abort', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    const firstHandle = await driver.acquire(buildContext({ token: 'first' }));

    const secondPromise = driver.acquire(buildContext({ token: 'second' }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    driver.destroy();

    await expect(secondPromise).rejects.toBeInstanceOf(LockAbortedError);

    firstHandle.release();
  });

  test('destroy 后 acquire 抛 LockAbortedError', async () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    driver.destroy();

    await expect(driver.acquire(buildContext())).rejects.toBeInstanceOf(LockAbortedError);
  });

  test('destroy 幂等', () => {
    driver = createBroadcastDriver(buildDeps(makeId()));
    expect(() => {
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
    }).not.toThrow();
  });
});
