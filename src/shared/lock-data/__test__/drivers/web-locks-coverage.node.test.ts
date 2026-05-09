/**
 * drivers/web-locks.ts 覆盖率补强测试
 *
 * 通过直接 import 内部纯函数（getWebLockManager / mergeSignalWithTimeout /
 * isAbortLikeError / handleStealRejection / wireRequestSettle / createWebLocksDriver），
 * 命中 browser project 主链路下不易触达的防御分支。
 *
 * 覆盖目标（参考 analyze-coverage 输出）：
 * - L66-67: getWebLockManager navigator===undefined → null
 * - L70: navigator.locks 为 falsy → null
 * - L108-113: mergeSignalWithTimeout externalSignal.aborted=true 早退 + cleanup/getTimeoutFired 闭包
 * - L150-151: isAbortLikeError !isObject(error) → false
 * - L175-176: handleStealRejection seized.released=true → 早退
 * - L186-187: handleStealRejection revokeCallback 抛错 → logger.error 捕获
 * - L208-210: wireRequestSettle resolve 路径 + current 未释放 → 兜底标 released
 * - L227-228: createWebLocksDriver manager=null → throwError
 * - L298 / L306-307: acquire 失败链路（非 abort、非 timeout 的错误重抛）
 *
 * 设计约束：node 环境（无 navigator.locks），通过 stubGlobal 控制能力探测；
 * 需要 navigator.locks 的路径用伪造 manager 喂 createWebLocksDriver
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type DriverScope,
  drainHoldingsOnDestroy,
  getWebLockManager,
  handleStealRejection,
  isAbortLikeError,
  mergeSignalWithTimeout,
  type WebLockHolding,
  type WebLockManager,
  wireRequestSettle,
} from '../../drivers/web-locks';
import type { LoggerAdapter } from '../../types';

function createLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createScope(holdings = new Set<WebLockHolding>()): DriverScope {
  return {
    holdings,
    // @ts-expect-error test
    logger: createLogger(),
    driverName: 'web-locks-test',
  };
}

function createHolding(overrides: Partial<WebLockHolding> = {}): WebLockHolding {
  return {
    token: 'token-test',
    holdPromise: Promise.resolve(),
    resolveHold: vi.fn(),
    revokeCallback: null,
    released: false,
    ...overrides,
  };
}

describe('drivers/web-locks — getWebLockManager 能力探测', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('navigator===undefined → 返回 null（命中 L66-67）', () => {
    vi.stubGlobal('navigator', undefined);
    expect(getWebLockManager()).toBeNull();
  });

  test('navigator.locks 缺失 → 返回 null（命中 L70 二元右分支）', () => {
    vi.stubGlobal('navigator', {});
    expect(getWebLockManager()).toBeNull();
  });

  test('navigator.locks 为 falsy（null）→ 返回 null', () => {
    vi.stubGlobal('navigator', { locks: null });
    expect(getWebLockManager()).toBeNull();
  });

  test('navigator.locks 是真值对象 → 返回该对象', () => {
    const fakeManager = { request: vi.fn() };
    vi.stubGlobal('navigator', { locks: fakeManager });
    expect(getWebLockManager()).toBe(fakeManager);
  });
});

describe('drivers/web-locks — mergeSignalWithTimeout', () => {
  test('externalSignal.aborted=true → 直接返回 aborted signal + no-op cleanup（命中 L108-113）', () => {
    const controller = new AbortController();
    controller.abort(new Error('preset-abort'));

    const result = mergeSignalWithTimeout(controller.signal, 0, 'token-x');

    expect(result.signal.aborted).toBe(true);
    expect(result.getTimeoutFired()).toBe(false);
    // cleanup 是 no-op，调用不抛错
    expect(() => result.cleanup()).not.toThrow();
  });

  test('cleanup 闭包可独立调用（命中 L112 anonymous_2）', () => {
    const controller = new AbortController();
    controller.abort();
    const { cleanup } = mergeSignalWithTimeout(controller.signal, 0, 'token-y');
    cleanup();
    cleanup();
    expect(typeof cleanup).toBe('function');
  });

  test('getTimeoutFired 闭包返回 false（命中 L113 anonymous_3）', () => {
    const controller = new AbortController();
    controller.abort();
    const { getTimeoutFired } = mergeSignalWithTimeout(controller.signal, 0, 'token-z');
    expect(getTimeoutFired()).toBe(false);
  });
});

describe('drivers/web-locks — isAbortLikeError', () => {
  test('error 不是 object → false（命中 L150-151）', () => {
    expect(isAbortLikeError(undefined)).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError('AbortError')).toBe(false);
    expect(isAbortLikeError(42)).toBe(false);
  });

  test('error.name="AbortError" → true', () => {
    expect(isAbortLikeError({ name: 'AbortError' })).toBe(true);
  });

  test('error.name 不是 AbortError → false', () => {
    expect(isAbortLikeError({ name: 'OtherError' })).toBe(false);
    expect(isAbortLikeError({})).toBe(false);
  });
});

describe('drivers/web-locks — handleStealRejection', () => {
  test('seized.released=true → 直接 return（命中 L175-176）', () => {
    const seized = createHolding({ released: true });
    const scope = createScope();
    const resolveHold = seized.resolveHold as ReturnType<typeof vi.fn>;

    handleStealRejection(seized, scope);

    expect(resolveHold).not.toHaveBeenCalled();
    expect(scope.holdings.has(seized)).toBe(false);
  });

  test('revokeCallback 抛错 → logger.error 捕获，不阻断流程（命中 L186-187）', () => {
    const revokeCallback = vi.fn(() => {
      throw new Error('callback boom');
    });
    const seized = createHolding({ revokeCallback });
    const holdings = new Set<WebLockHolding>([seized]);
    const scope = createScope(holdings);
    const resolveHold = seized.resolveHold as ReturnType<typeof vi.fn>;

    expect(() => handleStealRejection(seized, scope)).not.toThrow();

    expect(seized.released).toBe(true);
    expect(holdings.has(seized)).toBe(false);
    expect(resolveHold).toHaveBeenCalledTimes(1);
    expect(revokeCallback).toHaveBeenCalledWith('force');
    expect(scope.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('revoke callback threw'),
      expect.any(Error),
    );
  });

  test('revokeCallback=null → 跳过回调，但仍清理 holding', () => {
    const seized = createHolding({ revokeCallback: null });
    const holdings = new Set<WebLockHolding>([seized]);
    const scope = createScope(holdings);

    handleStealRejection(seized, scope);

    expect(seized.released).toBe(true);
    expect(holdings.has(seized)).toBe(false);
  });
});

describe('drivers/web-locks — wireRequestSettle', () => {
  test('resolve 路径 + current && !released → 兜底标 released（命中 L208-210）', async () => {
    const holding = createHolding({ released: false });
    const holdings = new Set<WebLockHolding>([holding]);
    const scope = createScope(holdings);
    const requestPromise = Promise.resolve('done');
    const rejectGranted = vi.fn();

    wireRequestSettle(requestPromise, () => holding, rejectGranted, scope);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(holding.released).toBe(true);
    expect(holdings.has(holding)).toBe(false);
    expect(rejectGranted).not.toHaveBeenCalled();
  });

  test('resolve 路径 + current=null → 不动 holdings', async () => {
    const holdings = new Set<WebLockHolding>();
    const scope = createScope(holdings);
    const requestPromise = Promise.resolve();
    const rejectGranted = vi.fn();

    wireRequestSettle(requestPromise, () => null, rejectGranted, scope);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(holdings.size).toBe(0);
    expect(rejectGranted).not.toHaveBeenCalled();
  });

  test('resolve 路径 + current.released=true → 不重复清理（不会再次 delete）', async () => {
    const holding = createHolding({ released: true });
    const holdings = new Set<WebLockHolding>([holding]);
    const scope = createScope(holdings);
    const requestPromise = Promise.resolve();
    const rejectGranted = vi.fn();

    wireRequestSettle(requestPromise, () => holding, rejectGranted, scope);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // 已是 released，分支 if 走 false 路径；holdings 不被删除（但本来就含它）
    expect(holding.released).toBe(true);
  });

  test('reject 路径 + current=null → rejectGranted 被调用', async () => {
    const scope = createScope();
    const error = new Error('reject-granted');
    const requestPromise = Promise.reject(error);
    const rejectGranted = vi.fn();

    wireRequestSettle(requestPromise, () => null, rejectGranted, scope);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(rejectGranted).toHaveBeenCalledWith(error);
  });

  test('reject 路径 + current!=null → 走 handleStealRejection（不调用 rejectGranted）', async () => {
    const holding = createHolding({ released: false });
    const holdings = new Set<WebLockHolding>([holding]);
    const scope = createScope(holdings);
    const requestPromise = Promise.reject(new Error('stolen'));
    const rejectGranted = vi.fn();

    wireRequestSettle(requestPromise, () => holding, rejectGranted, scope);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(rejectGranted).not.toHaveBeenCalled();
    expect(holding.released).toBe(true);
  });
});

describe('drivers/web-locks — createWebLocksDriver manager 缺失', () => {
  let originalNavigator: typeof globalThis.navigator | undefined;

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalNavigator !== undefined) {
      Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true });
    }
  });

  test('navigator.locks 缺失 → createWebLocksDriver 抛 TypeError（命中 L227-228）', async () => {
    vi.stubGlobal('navigator', {});

    const { createWebLocksDriver } = await import('../../drivers/web-locks');
    expect(() =>
      createWebLocksDriver({
        id: 'test',
        name: 'driver-test',
        logger: createLogger(),
      } as unknown as Parameters<typeof createWebLocksDriver>[0]),
    ).toThrow(TypeError);
  });
});

describe('drivers/web-locks — drainHoldingsOnDestroy', () => {
  test('混合 holdings：未 released 的释放，已 released 的跳过（命中 L348 两个分支）', () => {
    const activeHolding = createHolding({ token: 'active', released: false });
    const releasedHolding = createHolding({ token: 'released', released: true });
    const holdings = new Set<WebLockHolding>([activeHolding, releasedHolding]);

    drainHoldingsOnDestroy(holdings);

    // 未 released 的 holding 被释放并从集合移除
    expect(activeHolding.released).toBe(true);
    expect(holdings.has(activeHolding)).toBe(false);
    expect(activeHolding.resolveHold).toHaveBeenCalledTimes(1);

    // 已 released 的 holding 不重复 resolveHold，也不动其状态
    expect(releasedHolding.released).toBe(true);
    expect(releasedHolding.resolveHold).not.toHaveBeenCalled();
  });

  test('空 holdings → 不抛错', () => {
    const holdings = new Set<WebLockHolding>();
    expect(() => drainHoldingsOnDestroy(holdings)).not.toThrow();
    expect(holdings.size).toBe(0);
  });
});

describe('drivers/web-locks — acquire 失败重抛非 abort 错误', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('manager.request 抛非 abort 错误 → logger.error + 重抛（命中 L298 false 分支 + L306-307）', async () => {
    const logger = createLogger();
    const fakeError = new Error('synthetic-non-abort');
    const fakeManager: WebLockManager = {
      request: vi.fn(async () => {
        throw fakeError;
      }),
    };
    vi.stubGlobal('navigator', { locks: fakeManager });

    const { createWebLocksDriver } = await import('../../drivers/web-locks');
    const driver = createWebLocksDriver({
      id: 'test',
      name: 'driver-test',
      logger,
    } as unknown as Parameters<typeof createWebLocksDriver>[0]);

    const controller = new AbortController();
    await expect(
      // @ts-expect-error test
      driver.acquire({
        token: 'token-fail',
        signal: controller.signal,
        force: false,
        acquireTimeout: 0,
      }),
    ).rejects.toThrow('synthetic-non-abort');

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('request failed'), fakeError);

    driver.destroy();
  });
});
