/**
 * drivers/custom.ts 单元测试（node 环境；通过 mock 的 userGetLock 验证 wrap 契约）
 *
 * 覆盖契约：
 * 1. 工厂：缺 userGetLock 抛 TypeError
 * 2. acquire：透传 name / token / force / acquireTimeout 到用户工厂（ctx 拷贝对比）
 * 3. acquire：用户 getLock 返回 handle 被 wrap —— release 透传到用户 handle
 * 4. acquire：用户 getLock 返回 Promise<handle> —— await 后 wrap
 * 5. acquire：用户 handle 没有 onRevokedByDriver 时 wrapped 也没有该字段（可选契约）
 * 6. acquire：用户 handle 有 onRevokedByDriver 时绑定 this 后透传
 * 7. acquireTimeout：用户工厂迟迟不 resolve → timer 到期后合并 signal abort，抛 LockTimeoutError
 * 8. signal.abort：外部 signal abort → 映射为 LockAbortedError
 * 9. 用户工厂自身抛错 → 原样透传
 * 10. release 用户抛错 → logger.error 吞掉；不影响后续 release
 * 11. destroy 幂等；destroy 后 acquire 抛 LockAbortedError
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveLoggerAdapter } from '@/shared/lock-data/adapters/logger';
import { LOCK_PREFIX, NEVER_TIMEOUT } from '@/shared/lock-data/constants';
import { createCustomLockDriver } from '@/shared/lock-data/drivers/custom';
import type { LockDriver, LockDriverDeps } from '@/shared/lock-data/drivers/types';
import { LockAbortedError, LockTimeoutError } from '@/shared/lock-data/errors';
import type { LockDataAdapters, LockDriverContext, LockDriverHandle, LoggerAdapter } from '@/shared/lock-data/types';

function createLoggerSpy(): LoggerAdapter & {
  errorMock: ReturnType<typeof vi.fn>;
  debugMock: ReturnType<typeof vi.fn>;
} {
  const errorMock = vi.fn();
  const debugMock = vi.fn();
  return {
    warn: vi.fn(),
    error: errorMock,
    debug: debugMock,
    errorMock,
    debugMock,
  };
}

function buildDeps(
  getLock: LockDataAdapters<unknown>['getLock'],
  loggerSpy?: ReturnType<typeof createLoggerSpy>,
): LockDriverDeps {
  const logger = loggerSpy || createLoggerSpy();
  return {
    name: `${LOCK_PREFIX}:custom-ctx`,
    id: 'custom-id',
    logger: resolveLoggerAdapter(logger),
    userGetLock: getLock,
  };
}

function buildContext(overrides: Partial<LockDriverContext> = {}): LockDriverContext {
  const defaultController = new AbortController();
  const token = overrides.token || `tok_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: overrides.name || `${LOCK_PREFIX}:custom-ctx`,
    token,
    signal: overrides.signal || defaultController.signal,
    acquireTimeout: overrides.acquireTimeout === undefined ? NEVER_TIMEOUT : overrides.acquireTimeout,
    holdTimeout: overrides.holdTimeout === undefined ? NEVER_TIMEOUT : overrides.holdTimeout,
    force: overrides.force === true,
  };
}

describe('drivers/custom (node)', () => {
  let driver: LockDriver | null = null;

  afterEach(() => {
    driver?.destroy();
    driver = null;
  });

  test('工厂：缺 userGetLock 抛 TypeError', () => {
    const logger = resolveLoggerAdapter(createLoggerSpy());
    expect(() =>
      createCustomLockDriver({
        name: `${LOCK_PREFIX}:x`,
        id: 'x',
        logger,
      }),
    ).toThrow(TypeError);
  });

  test('透传 ctx（name / token / force / acquireTimeout / holdTimeout）到用户工厂', async () => {
    const capturedCtx: LockDriverContext[] = [];
    const userHandle: LockDriverHandle = {
      release: vi.fn(),
      onRevokedByDriver: vi.fn(),
    };
    driver = createCustomLockDriver(
      buildDeps((ctx) => {
        capturedCtx.push(ctx);
        return userHandle;
      }),
    );

    const handle = await driver.acquire(buildContext({ token: 'abc', force: false, acquireTimeout: NEVER_TIMEOUT }));
    expect(handle).toBeDefined();

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0].token).toBe('abc');
    expect(capturedCtx[0].force).toBe(false);
    expect(capturedCtx[0].acquireTimeout).toBe(NEVER_TIMEOUT);
    expect(capturedCtx[0].holdTimeout).toBe(NEVER_TIMEOUT);
    expect(capturedCtx[0].name).toBe(`${LOCK_PREFIX}:custom-ctx`);
    expect(capturedCtx[0].signal).toBeInstanceOf(AbortSignal);
  });

  test('用户 handle 同步返回：release 透传到用户 handle', async () => {
    const userRelease = vi.fn();
    const userHandle: LockDriverHandle = {
      release: userRelease,
      onRevokedByDriver: vi.fn(),
    };
    driver = createCustomLockDriver(buildDeps(() => userHandle));

    const handle = await driver.acquire(buildContext());
    handle.release();

    expect(userRelease).toHaveBeenCalledTimes(1);
  });

  test('用户 handle 异步返回（Promise）：await 后 wrap', async () => {
    const userRelease = vi.fn();
    const userHandle: LockDriverHandle = {
      release: userRelease,
      onRevokedByDriver: vi.fn(),
    };
    driver = createCustomLockDriver(
      buildDeps(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return userHandle;
      }),
    );

    const handle = await driver.acquire(buildContext());
    handle.release();
    expect(userRelease).toHaveBeenCalledTimes(1);
  });

  test('用户 handle 无 onRevokedByDriver：wrapped 也无该字段', async () => {
    const userHandle = {
      release: vi.fn(),
    } as unknown as LockDriverHandle;
    driver = createCustomLockDriver(buildDeps(() => userHandle));

    const handle = await driver.acquire(buildContext());
    expect(handle.onRevokedByDriver).toBeUndefined();
    handle.release();
  });

  test('用户 handle 有 onRevokedByDriver：透传', async () => {
    const userOnRevoked = vi.fn();
    const userHandle: LockDriverHandle = {
      release: vi.fn(),
      onRevokedByDriver: userOnRevoked,
    };
    driver = createCustomLockDriver(buildDeps(() => userHandle));

    const handle = await driver.acquire(buildContext());
    expect(typeof handle.onRevokedByDriver).toBe('function');

    const cb = vi.fn();
    handle.onRevokedByDriver(cb);
    expect(userOnRevoked).toHaveBeenCalledTimes(1);
    expect(userOnRevoked.mock.calls[0][0]).toBe(cb);
  });

  test('acquireTimeout：用户工厂不 resolve → 抛 LockTimeoutError', async () => {
    driver = createCustomLockDriver(
      buildDeps(
        (ctx) =>
          new Promise<LockDriverHandle>((_, reject) => {
            // 监听合并 signal abort（timeout / external 任一都会触发）
            ctx.signal.addEventListener('abort', () => {
              reject(new Error('aborted by signal'));
            });
          }),
      ),
    );

    await expect(driver.acquire(buildContext({ acquireTimeout: 30 }))).rejects.toBeInstanceOf(LockTimeoutError);
  });

  test('signal.abort：外部 signal abort → 抛 LockAbortedError', async () => {
    driver = createCustomLockDriver(
      buildDeps(
        (ctx) =>
          new Promise<LockDriverHandle>((_, reject) => {
            ctx.signal.addEventListener('abort', () => {
              reject(new Error('aborted by signal'));
            });
          }),
      ),
    );

    const controller = new AbortController();
    const p = driver.acquire(buildContext({ signal: controller.signal }));
    // 让工厂先启动
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(p).rejects.toBeInstanceOf(LockAbortedError);
  });

  test('用户工厂自身抛错：原样透传 + logger.error', async () => {
    const logger = createLoggerSpy();
    const userError = new Error('user explicit failure');
    driver = createCustomLockDriver(
      buildDeps(() => {
        throw userError;
      }, logger),
    );

    await expect(driver.acquire(buildContext())).rejects.toBe(userError);
    expect(logger.errorMock).toHaveBeenCalled();
  });

  test('release 用户抛错：logger.error 吞掉，不中断', async () => {
    const logger = createLoggerSpy();
    const releaseError = new Error('release fail');
    const userHandle: LockDriverHandle = {
      release: () => {
        throw releaseError;
      },
      onRevokedByDriver: vi.fn(),
    };
    driver = createCustomLockDriver(buildDeps(() => userHandle, logger));

    const handle = await driver.acquire(buildContext());
    expect(() => handle.release()).not.toThrow();
    expect(logger.errorMock).toHaveBeenCalled();
  });

  test('destroy 后 acquire 抛 LockAbortedError + destroy 幂等', async () => {
    const userHandle: LockDriverHandle = {
      release: vi.fn(),
      onRevokedByDriver: vi.fn(),
    };
    driver = createCustomLockDriver(buildDeps(() => userHandle));

    driver.destroy();
    expect(() => {
      (driver as LockDriver).destroy();
      (driver as LockDriver).destroy();
    }).not.toThrow();

    await expect(driver.acquire(buildContext())).rejects.toBeInstanceOf(LockAbortedError);
  });

  // -------------------------------------------------------------------------
  // 残余分支补测
  // -------------------------------------------------------------------------

  test('外部 signal 已 aborted 进入 acquire → mergeSignalWithTimeout 直接透传 abort（line 51-57 早退）', async () => {
    // 让用户工厂监听合并 signal —— 已 aborted 时立即 reject，触发 acquire 主体的
    // `if (ctx.signal.aborted)` 分支，把错误映射为 LockAbortedError
    const getLock = vi.fn((userCtx: LockDriverContext) => {
      if (userCtx.signal.aborted) {
        return Promise.reject(userCtx.signal.reason);
      }
      return Promise.resolve({
        release: vi.fn(),
        onRevokedByDriver: vi.fn(),
      } satisfies LockDriverHandle);
    });
    driver = createCustomLockDriver(buildDeps(getLock));

    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    // signal 已 aborted 进入 acquire，mergeSignalWithTimeout 走早退分支
    // （controller.abort 后 cleanup: () => undefined，getTimeoutFired: () => false）
    await expect(driver.acquire(buildContext({ signal: controller.signal }))).rejects.toBeInstanceOf(LockAbortedError);

    // 用户工厂确实被调用过（合并 signal 已是 aborted 状态）
    expect(getLock).toHaveBeenCalledTimes(1);
    const passedCtx = getLock.mock.calls[0]?.[0] as LockDriverContext;
    expect(passedCtx.signal.aborted).toBe(true);
  });

  test('用户 release 返回 reject Promise → catch 回调命中 logger.error（line 125-127）', async () => {
    const logger = createLoggerSpy();
    const releaseRejection = new Error('release rejected');

    const userHandle: LockDriverHandle = {
      // 返回 Promise 且 reject —— 触发 wrapUserHandle 内 Promise.resolve(ret).catch 回调
      release: () => Promise.reject(releaseRejection),
      onRevokedByDriver: vi.fn(),
    };
    driver = createCustomLockDriver(buildDeps(() => userHandle, logger));

    const handle = await driver.acquire(buildContext());
    // wrapped.release() 返回 Promise<void>（catch 后不再 reject）；await 不抛
    await expect(Promise.resolve(handle.release())).resolves.toBeUndefined();

    // 命中 catch 回调 + logger.error
    expect(logger.errorMock).toHaveBeenCalled();
    const errorCall = logger.errorMock.mock.calls.find((call) => /user release rejected/u.test(String(call[0])));
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toBe(releaseRejection);
  });
});
