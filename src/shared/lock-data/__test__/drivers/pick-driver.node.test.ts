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

import { describe, expect, test, vi } from 'vitest';
import { pickDefaultAdapters } from '@/shared/lock-data/adapters/index';
import {
  hasBroadcastChannel,
  hasNavigatorLocks,
  hasUsableLocalStorage,
  pickDriver,
} from '@/shared/lock-data/drivers/index';
import type { LockDriverContext, LockDriverHandle } from '@/shared/lock-data/types';

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
  test('能力探测：node 环境 navigator.locks / localStorage 不可用', () => {
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
