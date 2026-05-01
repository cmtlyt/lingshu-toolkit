import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SESSION_PROBE_TIMEOUT,
  DEFAULT_TIMEOUT,
  ERROR_FN_NAME,
  LOCK_PREFIX,
  NEVER_TIMEOUT,
  PERSISTENT_EPOCH,
} from '../constants';

describe('lock-data 常量', () => {
  test('LOCK_PREFIX 固化为 scoped 命名空间', () => {
    expect(LOCK_PREFIX).toBe('@cmtlyt/lingshu-toolkit:lockData');
  });

  test('NEVER_TIMEOUT 是 unique symbol', () => {
    expect(typeof NEVER_TIMEOUT).toBe('symbol');
    // unique symbol 应当与 Symbol.for 创建的全局 symbol 不同
    expect(NEVER_TIMEOUT).not.toBe(Symbol.for('@cmtlyt/lingshu-toolkit:lockData#NEVER_TIMEOUT'));
  });

  test('默认超时遵循 RFC 约定值', () => {
    expect(DEFAULT_TIMEOUT).toBe(5000);
    expect(DEFAULT_SESSION_PROBE_TIMEOUT).toBe(100);
  });

  test('PERSISTENT_EPOCH 为固定常量字符串', () => {
    expect(PERSISTENT_EPOCH).toBe('persistent');
  });

  test('ERROR_FN_NAME 为 lockData', () => {
    expect(ERROR_FN_NAME).toBe('lockData');
  });
});
