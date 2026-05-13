/**
 * drivers/index.ts pickDriver + 能力探测单元测试（node 环境）
 *
 * 为什么走 node：pickDriver 的分支判定基于能力探测函数（hasXxx），
 * node 环境下 navigator.locks / BroadcastChannel / localStorage **全部不可用**，
 * 正好覆盖"auto 全不可用抛错"+"显式 mode 能力不足抛错"两类关键分支；
 * 能力可用的正路径由各 driver 自己的 browser 测试覆盖
 *
 * 覆盖契约：
 * 1. adapters.getLock 存在 → 选 CustomDriver（覆盖 mode）
 * 2. !id → 选 LocalLockDriver（无论 mode 什么值）
 * 3. 显式 mode='web-locks' + 能力不可用 → 抛 TypeError
 * 4. 显式 mode='broadcast' + 能力不可用 → 抛 TypeError
 * 5. 显式 mode='storage' + 能力不可用 → 抛 TypeError
 * 6. mode='auto' + 能力全不可用 → 抛 TypeError
 * 7. 非法 mode 值 → 抛 TypeError
 * 8. 能力探测函数（node 环境下）：
 *    - hasNavigatorLocks → false（node 无 navigator.locks）
 *    - hasBroadcastChannel → 取决于 node 版本（node >= 18 的 globalThis.BroadcastChannel 可用）
 *    - hasUsableLocalStorage → false（node 无 localStorage）
 */
/** biome-ignore-all lint/nursery/noConditionalExpect: ignore */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pickDefaultAdapters } from '@/shared/lock-data/adapters/index';
import {
  hasBroadcastChannel,
  hasNavigatorLocks,
  hasUsableLocalStorage,
  pickDriver,
} from '@/shared/lock-data/drivers/index';
import type { LockDriverContext, LockDriverHandle } from '@/shared/lock-data/types';

/**
 * 强制能力探测返回 "不可用"，用于覆盖"显式 mode + 能力不足 → 抛错"等分支
 *
 * 背景：Node.js v24 起原生提供了 `navigator.locks`（Web Locks API），若直接依赖 node
 * 自身环境会导致测试断言漂移；此处显式 stub globals 让能力探测与 node 版本解耦
 */
function stubGlobalsUnavailable(): void {
  // navigator.locks：stubGlobal 整个 navigator 为空对象（即使 node 原生有）
  vi.stubGlobal('navigator', {});
  // localStorage：stubGlobal 为 undefined（node 原生无，但保险起见）
  vi.stubGlobal('localStorage', undefined);
}

function buildArgs(
  options: { mode?: 'auto' | 'web-locks' | 'broadcast' | 'storage' },
  id: string | undefined,
  userGetLock?: (ctx: LockDriverContext) => Promise<LockDriverHandle> | LockDriverHandle,
) {
  const adapters = pickDefaultAdapters<unknown>({
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getLock: userGetLock,
  });
  return { adapters, options, id };
}

describe('drivers/pickDriver (node)', () => {
  beforeEach(() => {
    stubGlobalsUnavailable();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('能力探测：显式 stub 后 navigator.locks / localStorage 不可用', () => {
    expect(hasNavigatorLocks()).toBe(false);
    expect(hasUsableLocalStorage()).toBe(false);
    // hasBroadcastChannel 取决于 node 版本，不做硬断言，仅校验函数返回布尔
    expect(typeof hasBroadcastChannel()).toBe('boolean');
  });

  test('adapters.getLock 存在 → 选 CustomDriver（忽略 mode）', () => {
    const stubHandle: LockDriverHandle = {
      release: vi.fn(),
      onRevokedByDriver: vi.fn(),
    };
    const userGetLock = vi.fn(() => stubHandle);
    const args = buildArgs({ mode: 'web-locks' }, 'id-1', userGetLock);

    const driver = pickDriver(args);
    expect(driver).toBeDefined();
    expect(typeof driver.acquire).toBe('function');
    expect(typeof driver.destroy).toBe('function');
    // destroy 是 no-op（custom driver 不持有资源）
    driver.destroy();
  });

  test('!id → 选 LocalLockDriver（无论 mode 什么值）', () => {
    const args = buildArgs({ mode: 'web-locks' }, undefined);
    const driver = pickDriver(args);
    expect(driver).toBeDefined();
    driver.destroy();
  });

  test("id='' → 也视为无 id，选 LocalLockDriver", () => {
    const args = buildArgs({ mode: 'storage' }, '');
    const driver = pickDriver(args);
    expect(driver).toBeDefined();
    driver.destroy();
  });

  test("显式 mode='web-locks' + navigator.locks 不可用 → 抛 TypeError", () => {
    const args = buildArgs({ mode: 'web-locks' }, 'id-1');
    expect(() => pickDriver(args)).toThrow(TypeError);
  });

  test("显式 mode='storage' + localStorage 不可用 → 抛 TypeError", () => {
    const args = buildArgs({ mode: 'storage' }, 'id-1');
    expect(() => pickDriver(args)).toThrow(TypeError);
  });

  test("显式 mode='broadcast' + BroadcastChannel 不可用 → 抛 TypeError（仅当 node 环境不支持时）", () => {
    // hasBroadcastChannel 依赖 node 版本：若当前 node 支持 BroadcastChannel，本测试跳过严格断言
    if (hasBroadcastChannel()) {
      // 当前环境支持，mode='broadcast' 会成功构造；跳过 throw 断言，验证构造不抛错即可
      const args = buildArgs({ mode: 'broadcast' }, 'id-1');
      const driver = pickDriver(args);
      expect(driver).toBeDefined();
      driver.destroy();
      return;
    }
    const args = buildArgs({ mode: 'broadcast' }, 'id-1');
    expect(() => pickDriver(args)).toThrow(TypeError);
  });

  test("mode='auto' + 能力检测：按降级链选择，全不可用时抛错", () => {
    const args = buildArgs({ mode: 'auto' }, 'id-1');
    // node 环境：navigator.locks 不可用，localStorage 不可用；BroadcastChannel 取决于版本
    if (hasBroadcastChannel()) {
      // 能走通 broadcast driver
      const driver = pickDriver(args);
      expect(driver).toBeDefined();
      driver.destroy();
    } else {
      // 全不可用 —— auto 抛错
      expect(() => pickDriver(args)).toThrow(TypeError);
    }
  });

  test('mode undefined（默认 auto）：行为等同于显式 auto', () => {
    const args = buildArgs({}, 'id-1');
    if (hasBroadcastChannel()) {
      const driver = pickDriver(args);
      expect(driver).toBeDefined();
      driver.destroy();
    } else {
      expect(() => pickDriver(args)).toThrow(TypeError);
    }
  });

  test('非法 mode 值 → 抛 TypeError', () => {
    const args = buildArgs({ mode: 'invalid' as unknown as 'auto' }, 'id-1');
    expect(() => pickDriver(args)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// 能力探测函数残余分支补测：hasNavigatorLocks / hasBroadcastChannel / hasUsableLocalStorage
//
// stubGlobalsUnavailable 把 navigator stub 成空对象（{}），命中的是 nav.locks 缺失分支；
// 这里用更激进的 stub（navigator=undefined / BroadcastChannel 抛错构造）命中其他防御性分支
// ---------------------------------------------------------------------------

describe('drivers/index 能力探测残余分支', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('hasNavigatorLocks：navigator=undefined 命中 if (!isObject(nav)) → false', () => {
    vi.stubGlobal('navigator', undefined);
    expect(hasNavigatorLocks()).toBe(false);
  });

  test('hasNavigatorLocks：navigator.locks 不是对象（如字符串）→ false', () => {
    vi.stubGlobal('navigator', { locks: 'not-an-object' });
    expect(hasNavigatorLocks()).toBe(false);
  });

  test('hasNavigatorLocks：navigator.locks.request 不是函数 → false', () => {
    vi.stubGlobal('navigator', { locks: { request: 'not-a-function' } });
    expect(hasNavigatorLocks()).toBe(false);
  });

  test('hasNavigatorLocks：navigator.locks.request 是函数 → true', () => {
    vi.stubGlobal('navigator', { locks: { request: () => Promise.resolve() } });
    expect(hasNavigatorLocks()).toBe(true);
  });

  test('hasBroadcastChannel：BroadcastChannel 不是函数 → 命中 if (!isFunction(Ctor)) false 分支', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(hasBroadcastChannel()).toBe(false);

    vi.stubGlobal('BroadcastChannel', 'not-a-function');
    expect(hasBroadcastChannel()).toBe(false);
  });

  test('hasBroadcastChannel：构造函数抛错 → 命中 catch return false 分支', () => {
    function ThrowingBroadcastChannel(): never {
      throw new Error('synthetic ctor error');
    }
    vi.stubGlobal('BroadcastChannel', ThrowingBroadcastChannel);
    expect(hasBroadcastChannel()).toBe(false);
  });

  test('hasUsableLocalStorage：localStorage=undefined → 命中 if (!storage) false 分支', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(hasUsableLocalStorage()).toBe(false);
  });

  test('hasUsableLocalStorage：完整可用的 localStorage stub → setItem/removeItem 走通 + 返回 true', () => {
    const setItemMock = vi.fn();
    const removeItemMock = vi.fn();
    vi.stubGlobal('localStorage', {
      setItem: setItemMock,
      removeItem: removeItemMock,
      // 其他必需字段一并提供，避免类型层面拒绝
      getItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    });
    expect(hasUsableLocalStorage()).toBe(true);
    expect(setItemMock).toHaveBeenCalledTimes(1);
    expect(removeItemMock).toHaveBeenCalledTimes(1);
  });

  test('hasUsableLocalStorage：setItem 抛错 → 命中 catch return false 分支', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: vi.fn(),
      getItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    });
    expect(hasUsableLocalStorage()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickDriver 主入口残余分支补测：mode='storage' 主路径 + auto 降级到 storage
//
// 上面 describe 已覆盖各能力 stub 的不可用情况；这里显式 stub 让某个能力可用，
// 走通 createStorageOrThrow 主路径 + createAutoDriver 的 storage 分支
// ---------------------------------------------------------------------------

describe('pickDriver 显式 mode + auto 降级链残余分支', () => {
  function stubLocalStorageUsable(): void {
    vi.stubGlobal('localStorage', {
      setItem: vi.fn(),
      removeItem: vi.fn(),
      getItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("显式 mode='storage' + localStorage 可用 → 走通 createStorageOrThrow 主路径", () => {
    // 先把其他能力 stub 成不可用，避免误命中
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    stubLocalStorageUsable();

    const args = buildArgs({ mode: 'storage' }, 'id-storage');
    const driver = pickDriver(args);
    expect(driver).toBeDefined();
    expect(typeof driver.acquire).toBe('function');
    driver.destroy();
  });

  test("mode='auto' + 仅 localStorage 可用 → 降级到 storage（命中 createAutoDriver 第三个 if 真分支）", () => {
    // navigator.locks / BroadcastChannel 全部不可用，只有 localStorage 可用
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    stubLocalStorageUsable();

    const args = buildArgs({ mode: 'auto' }, 'id-auto-fallback-storage');
    const driver = pickDriver(args);
    expect(driver).toBeDefined();
    driver.destroy();
  });

  test("显式 mode='broadcast' + BroadcastChannel 不可用 → 抛 TypeError（强制 stub 命中 L141）", () => {
    // 强制 stub BroadcastChannel=undefined，确保命中 createBroadcastOrThrow 的 throw 分支
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', undefined);

    const args = buildArgs({ mode: 'broadcast' }, 'id-broadcast-unavailable');
    expect(() => pickDriver(args)).toThrow(TypeError);
  });

  test("mode='auto' + 三种能力全不可用 → 抛 TypeError（强制 stub 命中 createAutoDriver L184）", () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', undefined);

    const args = buildArgs({ mode: 'auto' }, 'id-auto-all-unavailable');
    expect(() => pickDriver(args)).toThrow(TypeError);
  });
});
