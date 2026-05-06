/**
 * standalone（无 id）实例的 driver / authority 隔离 — browser 路径
 *
 * 范围：仅放需要浏览器能力（navigator.locks）的回归断言；node 环境的隔离断言放在
 * 同名 .node.test.ts 中。
 *
 * 修复背景：`src/shared/lock-data/fixes/standalone-id-leak.md`
 *
 * 本文件只覆盖 1 个回归断言：**有真实 id 的实例传 `mode: 'web-locks'` 仍按预期
 * 起 WebLocksDriver**，证明拆分 `Entry.id` / `Entry.lockId` 没有误伤"正常路径"。
 */

/** biome-ignore-all lint/nursery/useGlobalThis: test file uses navigator/AbortController */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetDefaultRegistry, lockData } from '@/shared/lock-data/core/entry';
import type { LockDataActions, LoggerAdapter } from '@/shared/lock-data/types';

function createSilentLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

afterEach(() => {
  __resetDefaultRegistry();
  vi.restoreAllMocks();
});

describe('standalone-driver-isolation / 回归保证（browser）', () => {
  test('有真实 id + mode="web-locks" 仍调用 navigator.locks.request（lockId 透传未误伤正常路径）', async () => {
    // 前置：浏览器测试环境必须支持 Web Locks API；不支持则跳过本断言（视测试环境而定）
    if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') {
      return;
    }

    const requestSpy = vi.spyOn(navigator.locks, 'request');

    const [, actions] = lockData(
      { v: 0 },
      { id: 'real-id-web-locks', mode: 'web-locks', adapters: { logger: createSilentLogger() } },
    ) as readonly [{ v: number }, LockDataActions<{ v: number }>];

    await actions.update((draft) => {
      draft.v = 1;
    });

    // navigator.locks.request 至少被调用一次；首次入参的 name 应包含真实 id（而非 '__local__'）
    expect(requestSpy).toHaveBeenCalled();
    const firstCallArgs = requestSpy.mock.calls[0];
    expect(typeof firstCallArgs[0]).toBe('string');
    expect(String(firstCallArgs[0])).toContain('real-id-web-locks');
    expect(String(firstCallArgs[0])).not.toContain('__local__');

    await actions.dispose();
  });
});
