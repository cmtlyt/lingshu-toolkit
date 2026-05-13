/**
 * adapters/session-store.ts 在真实浏览器环境下的烟囱测试
 *
 * 覆盖点（浏览器端）：
 * 1. 真实浏览器下工厂返回非 null 实例
 * 2. write / read 与真实 sessionStorage 的 round-trip 一致
 * 3. 覆盖式写入
 * 4. 不同 id 之间 key 隔离
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildSessionStoreKey, createDefaultSessionStoreAdapter } from '@/shared/lock-data/adapters/session-store';
import type { LoggerAdapter } from '@/shared/lock-data/types';

function createSilentLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('adapters/session-store (browser, real sessionStorage)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  test('工厂在真实浏览器下返回非 null 实例', () => {
    const adapter = createDefaultSessionStoreAdapter({ id: 'browser-k' }, { logger: createSilentLogger() });
    expect(adapter).not.toBeNull();
  });

  test('write / read 与真实 sessionStorage 一致', () => {
    const adapter = createDefaultSessionStoreAdapter({ id: 'browser-k' }, { logger: createSilentLogger() });
    expect(adapter).not.toBeNull();

    adapter?.write('epoch-42');
    expect(sessionStorage.getItem(buildSessionStoreKey('browser-k'))).toBe('epoch-42');
    expect(adapter?.read()).toBe('epoch-42');
  });

  test('未写入时 read 返回 null', () => {
    const adapter = createDefaultSessionStoreAdapter({ id: 'browser-empty' }, { logger: createSilentLogger() });
    expect(adapter?.read()).toBeNull();
  });

  test('覆盖式写入', () => {
    const adapter = createDefaultSessionStoreAdapter({ id: 'browser-k' }, { logger: createSilentLogger() });

    adapter?.write('first');
    adapter?.write('second');

    expect(adapter?.read()).toBe('second');
  });

  test('不同 id 之间的 key 隔离', () => {
    const logger = createSilentLogger();
    const a = createDefaultSessionStoreAdapter({ id: 'browser-a' }, { logger });
    const b = createDefaultSessionStoreAdapter({ id: 'browser-b' }, { logger });

    a?.write('a-epoch');
    b?.write('b-epoch');

    expect(a?.read()).toBe('a-epoch');
    expect(b?.read()).toBe('b-epoch');
  });
});
