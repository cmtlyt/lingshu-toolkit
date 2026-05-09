/**
 * drivers/storage-protocol.ts 单元测试（node 环境，无外部依赖）
 *
 * 覆盖契约：
 *   - isStorageLockValue：完整 shape 校验 + 各字段非法分支
 *   - isStorageHolder / isStorageQueueEntry（被 isStorageLockValue 间接覆盖）
 *   - isHolderDead：>阈值 / <阈值 / =阈值 边界
 *   - genNonce / genWaiterId：格式校验 + 多次调用结果不同
 *   - nextRetryJitter：返回值在 [0, WRITE_RETRY_JITTER_MAX) 区间
 *   - EMPTY_VALUE / 常量导出
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DEAD_THRESHOLD,
  EMPTY_VALUE,
  genNonce,
  genWaiterId,
  HEARTBEAT_INTERVAL,
  isHolderDead,
  isStorageLockValue,
  nextRetryJitter,
  POLL_INTERVAL,
  type StorageHolder,
  WRITE_RETRY_MAX,
} from '@/shared/lock-data/drivers/storage-protocol';

// ---------------------------------------------------------------------------
// isStorageLockValue —— 顶层 shape 校验
// ---------------------------------------------------------------------------

describe('isStorageLockValue / 顶层 shape 校验', () => {
  test('非对象（null / 字符串 / 数字）→ false', () => {
    expect(isStorageLockValue(null)).toBe(false);
    expect(isStorageLockValue('not-object')).toBe(false);
    expect(isStorageLockValue(123)).toBe(false);
  });

  test('完整合法 value（holder=null, queue=[], rev=0）→ true', () => {
    expect(isStorageLockValue({ holder: null, queue: [], rev: 0 })).toBe(true);
  });

  test('rev 缺失 / 非有限数字 → false', () => {
    expect(isStorageLockValue({ holder: null, queue: [] })).toBe(false);
    expect(isStorageLockValue({ holder: null, queue: [], rev: Number.NaN })).toBe(false);
    expect(isStorageLockValue({ holder: null, queue: [], rev: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isStorageLockValue({ holder: null, queue: [], rev: '0' })).toBe(false);
  });

  test('queue 不是数组 → false', () => {
    expect(isStorageLockValue({ holder: null, queue: 'not-array', rev: 0 })).toBe(false);
    expect(isStorageLockValue({ holder: null, queue: { length: 0 }, rev: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isStorageLockValue —— queue 项校验
// ---------------------------------------------------------------------------

describe('isStorageLockValue / queue 项校验', () => {
  test('queue 项缺 token → false', () => {
    expect(isStorageLockValue({ holder: null, queue: [{ ts: 100 }], rev: 0 })).toBe(false);
  });

  test('queue 项 ts 非有限数字 → false', () => {
    expect(isStorageLockValue({ holder: null, queue: [{ token: 't1', ts: Number.NaN }], rev: 0 })).toBe(false);
  });

  test('queue 项非对象 → false', () => {
    expect(isStorageLockValue({ holder: null, queue: ['not-an-entry'], rev: 0 })).toBe(false);
  });

  test('queue 多项合法 → true', () => {
    const value = {
      holder: null,
      queue: [
        { token: 't1', ts: 100 },
        { token: 't2', ts: 200 },
      ],
      rev: 5,
    };
    expect(isStorageLockValue(value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isStorageLockValue —— holder 项校验
// ---------------------------------------------------------------------------

describe('isStorageLockValue / holder 项校验', () => {
  const validHolder: StorageHolder = { token: 'h-tok', heartbeat: 1000, nonce: 'n-1' };

  test('holder 完整合法 → true', () => {
    expect(isStorageLockValue({ holder: validHolder, queue: [], rev: 0 })).toBe(true);
  });

  test('holder 缺 token → false', () => {
    expect(isStorageLockValue({ holder: { heartbeat: 1000, nonce: 'n-1' }, queue: [], rev: 0 })).toBe(false);
  });

  test('holder.heartbeat 非有限数字 → false', () => {
    expect(
      isStorageLockValue({
        holder: { token: 'h', heartbeat: Number.POSITIVE_INFINITY, nonce: 'n' },
        queue: [],
        rev: 0,
      }),
    ).toBe(false);
  });

  test('holder.nonce 非 string → false', () => {
    expect(isStorageLockValue({ holder: { token: 'h', heartbeat: 1000, nonce: 123 }, queue: [], rev: 0 })).toBe(false);
  });

  test('holder 是非对象（数字 / 字符串）但非 null → false', () => {
    expect(isStorageLockValue({ holder: 'not-object', queue: [], rev: 0 })).toBe(false);
    expect(isStorageLockValue({ holder: 123, queue: [], rev: 0 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isHolderDead —— 心跳超时判定
// ---------------------------------------------------------------------------

describe('isHolderDead / 心跳超时边界', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('heartbeat 距今 < DEAD_THRESHOLD → false（活跃）', () => {
    const now = Date.now();
    const holder: StorageHolder = { token: 't', heartbeat: now - (DEAD_THRESHOLD - 100), nonce: 'n' };
    expect(isHolderDead(holder)).toBe(false);
  });

  test('heartbeat 距今 = DEAD_THRESHOLD → false（边界：仅严格大于才算死）', () => {
    const now = Date.now();
    const holder: StorageHolder = { token: 't', heartbeat: now - DEAD_THRESHOLD, nonce: 'n' };
    expect(isHolderDead(holder)).toBe(false);
  });

  test('heartbeat 距今 > DEAD_THRESHOLD → true（已崩溃）', () => {
    const now = Date.now();
    const holder: StorageHolder = { token: 't', heartbeat: now - (DEAD_THRESHOLD + 1), nonce: 'n' };
    expect(isHolderDead(holder)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// genNonce / genWaiterId —— 格式 + 唯一性
// ---------------------------------------------------------------------------

describe('genNonce / genWaiterId / id 工厂', () => {
  test('genNonce 以 n_ 开头 + 多次调用结果不同', () => {
    const a = genNonce();
    const b = genNonce();
    expect(a.startsWith('n_')).toBe(true);
    expect(b.startsWith('n_')).toBe(true);
    expect(a).not.toBe(b);
  });

  test('genWaiterId 以 w_ 开头 + 多次调用结果不同', () => {
    const a = genWaiterId();
    const b = genWaiterId();
    expect(a.startsWith('w_')).toBe(true);
    expect(b.startsWith('w_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// nextRetryJitter —— 退避抖动
// ---------------------------------------------------------------------------

describe('nextRetryJitter / 退避值边界', () => {
  test('返回值在 [0, WRITE_RETRY_JITTER_MAX) 区间，多次抽样均符合', () => {
    for (let i = 0; i < 50; i += 1) {
      const value = nextRetryJitter();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(20); // WRITE_RETRY_JITTER_MAX
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  test('Math.random 返回 0 时 jitter=0（最小值边界）', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(nextRetryJitter()).toBe(0);
    spy.mockRestore();
  });

  test('Math.random 返回接近 1 时 jitter=19（最大值边界）', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999_999_9);
    expect(nextRetryJitter()).toBe(19);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// EMPTY_VALUE 与常量
// ---------------------------------------------------------------------------

describe('storage-protocol / 常量导出', () => {
  test('EMPTY_VALUE 是合法 StorageLockValue', () => {
    expect(isStorageLockValue(EMPTY_VALUE)).toBe(true);
    expect(EMPTY_VALUE.holder).toBeNull();
    expect(EMPTY_VALUE.queue).toEqual([]);
    expect(EMPTY_VALUE.rev).toBe(0);
  });

  test('所有时间常量都是有限正数', () => {
    expect(HEARTBEAT_INTERVAL).toBeGreaterThan(0);
    expect(DEAD_THRESHOLD).toBeGreaterThan(0);
    expect(POLL_INTERVAL).toBeGreaterThan(0);
    expect(WRITE_RETRY_MAX).toBeGreaterThan(0);
  });
});
