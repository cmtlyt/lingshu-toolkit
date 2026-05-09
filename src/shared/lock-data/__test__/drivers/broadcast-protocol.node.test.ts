/**
 * drivers/broadcast-protocol.ts 单元测试（node 环境，无外部依赖）
 *
 * 覆盖契约：
 *   - isBroadcastMessage：5 个 kind 的所有必需字段缺失分支 + 非对象 / senderId 缺失 + 未知 kind
 *   - isEarlier：tsA !== tsB / tsA === tsB / tsA < tsB / tsA > tsB / idA < idB / idA > idB
 *   - genId：格式校验 + 多次调用结果不同
 *   - 常量导出：REJECT_WINDOW / FORCE_ARBITRATION_WINDOW / HEARTBEAT_INTERVAL / DEAD_THRESHOLD
 */

import { describe, expect, test } from 'vitest';
import {
  DEAD_THRESHOLD,
  FORCE_ARBITRATION_WINDOW,
  genId,
  HEARTBEAT_INTERVAL,
  isBroadcastMessage,
  isEarlier,
  REJECT_WINDOW,
} from '@/shared/lock-data/drivers/broadcast-protocol';

// ---------------------------------------------------------------------------
// isBroadcastMessage —— 非对象 / 缺 senderId
// ---------------------------------------------------------------------------

describe('isBroadcastMessage / 顶层 shape 校验', () => {
  test('非对象（null / 字符串 / 数字 / undefined）→ false', () => {
    expect(isBroadcastMessage(null)).toBe(false);
    expect(isBroadcastMessage('not-object')).toBe(false);
    expect(isBroadcastMessage(123)).toBe(false);
    expect(isBroadcastMessage(undefined)).toBe(false);
  });

  test('缺 senderId 字段 → false', () => {
    expect(isBroadcastMessage({ kind: 'announce' })).toBe(false);
  });

  test('senderId 不是 string → false', () => {
    expect(isBroadcastMessage({ kind: 'announce', senderId: 123 })).toBe(false);
  });

  test('未知 kind → 命中 default 分支返回 false', () => {
    expect(isBroadcastMessage({ kind: 'unknown-kind', senderId: 'tab-1' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBroadcastMessage —— 5 个 kind 的字段校验
// ---------------------------------------------------------------------------

describe('isBroadcastMessage / kind=announce', () => {
  const baseValid = {
    kind: 'announce',
    senderId: 'tab-1',
    requestId: 'req-1',
    token: 'tok-1',
    ts: 100,
    force: false,
  };

  test('所有字段合法 → true', () => {
    expect(isBroadcastMessage(baseValid)).toBe(true);
  });

  test('requestId 不是 string → false', () => {
    expect(isBroadcastMessage({ ...baseValid, requestId: 123 })).toBe(false);
  });

  test('token 不是 string → false', () => {
    expect(isBroadcastMessage({ ...baseValid, token: null })).toBe(false);
  });

  test('ts 不是有限数字（NaN / Infinity / 字符串）→ false', () => {
    expect(isBroadcastMessage({ ...baseValid, ts: Number.NaN })).toBe(false);
    expect(isBroadcastMessage({ ...baseValid, ts: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isBroadcastMessage({ ...baseValid, ts: '100' })).toBe(false);
  });

  test('force 不是 boolean → false', () => {
    expect(isBroadcastMessage({ ...baseValid, force: 'yes' })).toBe(false);
  });
});

describe('isBroadcastMessage / kind=reject', () => {
  const baseValid = {
    kind: 'reject',
    senderId: 'tab-2',
    requestId: 'req-1',
    holderToken: 'holder-tok',
    holderTs: 200,
  };

  test('所有字段合法 → true', () => {
    expect(isBroadcastMessage(baseValid)).toBe(true);
  });

  test('requestId 不是 string → false', () => {
    expect(isBroadcastMessage({ ...baseValid, requestId: undefined })).toBe(false);
  });

  test('holderToken 不是 string → false', () => {
    expect(isBroadcastMessage({ ...baseValid, holderToken: 123 })).toBe(false);
  });

  test('holderTs 不是有限数字 → false', () => {
    expect(isBroadcastMessage({ ...baseValid, holderTs: Number.NEGATIVE_INFINITY })).toBe(false);
  });
});

describe('isBroadcastMessage / kind=release', () => {
  test('合法 release：仅需 senderId + token → true', () => {
    expect(isBroadcastMessage({ kind: 'release', senderId: 'tab-1', token: 'tok' })).toBe(true);
  });

  test('release 缺 token → false', () => {
    expect(isBroadcastMessage({ kind: 'release', senderId: 'tab-1' })).toBe(false);
  });
});

describe('isBroadcastMessage / kind=force', () => {
  const baseValid = { kind: 'force', senderId: 'tab-1', token: 'tok-1', ts: 300 };

  test('所有字段合法 → true', () => {
    expect(isBroadcastMessage(baseValid)).toBe(true);
  });

  test('token 不是 string → false', () => {
    expect(isBroadcastMessage({ ...baseValid, token: 123 })).toBe(false);
  });

  test('ts 不是有限数字 → false', () => {
    expect(isBroadcastMessage({ ...baseValid, ts: Number.NaN })).toBe(false);
  });
});

describe('isBroadcastMessage / kind=heartbeat', () => {
  const baseValid = { kind: 'heartbeat', senderId: 'tab-1', token: 'tok-1', ts: 400 };

  test('所有字段合法 → true', () => {
    expect(isBroadcastMessage(baseValid)).toBe(true);
  });

  test('token 不是 string → false', () => {
    expect(isBroadcastMessage({ ...baseValid, token: null })).toBe(false);
  });

  test('ts 不是有限数字 → false', () => {
    expect(isBroadcastMessage({ ...baseValid, ts: '400' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isEarlier —— 仲裁规则
// ---------------------------------------------------------------------------

describe('isEarlier / (ts, id) 字典序仲裁', () => {
  test('tsA < tsB → true（命中 if true 分支 + return tsA<tsB true 分支）', () => {
    expect(isEarlier(100, 'a', 200, 'a')).toBe(true);
  });

  test('tsA > tsB → false（命中 if true 分支 + return tsA<tsB false 分支）', () => {
    expect(isEarlier(200, 'a', 100, 'a')).toBe(false);
  });

  test('tsA === tsB && idA < idB → true（命中 if false 分支 + return idA<idB true 分支）', () => {
    expect(isEarlier(100, 'aaa', 100, 'bbb')).toBe(true);
  });

  test('tsA === tsB && idA > idB → false（命中 if false 分支 + return idA<idB false 分支）', () => {
    expect(isEarlier(100, 'bbb', 100, 'aaa')).toBe(false);
  });

  test('tsA === tsB && idA === idB → false（边界：完全相等不视为更早）', () => {
    expect(isEarlier(100, 'a', 100, 'a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// genId —— 唯一 id 生成
// ---------------------------------------------------------------------------

describe('genId / 唯一 id 生成', () => {
  test('结果以 prefix_ 开头 + 包含两段 base36 段', () => {
    const id = genId('req');
    expect(id.startsWith('req_')).toBe(true);
    // 形如 req_<base36-time>_<base36-rand8>
    expect(id.split('_')).toHaveLength(3);
  });

  test('多次调用结果不同（避免常量返回）', () => {
    const id1 = genId('s');
    const id2 = genId('s');
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// 常量导出
// ---------------------------------------------------------------------------

describe('broadcast-protocol / 常量导出', () => {
  test('所有常量都是有限正数', () => {
    expect(REJECT_WINDOW).toBeGreaterThan(0);
    expect(FORCE_ARBITRATION_WINDOW).toBeGreaterThan(0);
    expect(HEARTBEAT_INTERVAL).toBeGreaterThan(0);
    expect(DEAD_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isFinite(REJECT_WINDOW)).toBe(true);
    expect(Number.isFinite(FORCE_ARBITRATION_WINDOW)).toBe(true);
    expect(Number.isFinite(HEARTBEAT_INTERVAL)).toBe(true);
    expect(Number.isFinite(DEAD_THRESHOLD)).toBe(true);
  });
});
