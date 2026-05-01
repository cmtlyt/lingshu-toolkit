/**
 * adapters/authority.ts 在真实浏览器环境下的烟囱测试
 *
 * 目的：在 Node mock 环境之外，验证默认 AuthorityAdapter 能真实驱动浏览器
 * 的 localStorage 与 storage 事件。
 *
 * 覆盖点（浏览器端）：
 * 1. read / write / remove 与真实 localStorage 的 round-trip 一致
 * 2. 真实 localStorage 下工厂返回非 null
 * 3. subscribe 订阅跨上下文 `storage` 事件
 *    （同上下文的 setItem 不会触发本页面的 storage 事件，此处通过
 *    手动派发 StorageEvent 验证监听器绑定正确）
 */
/** biome-ignore-all lint/nursery/useGlobalThis: test file */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildAuthorityKey, createDefaultAuthorityAdapter } from '@/shared/lock-data/adapters/authority';
import type { LoggerAdapter } from '@/shared/lock-data/types';

function createSilentLogger(): LoggerAdapter {
  return {
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('adapters/authority (browser, real localStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test('工厂在真实浏览器下返回非 null 实例', () => {
    const adapter = createDefaultAuthorityAdapter({ id: 'browser-k' }, { logger: createSilentLogger() });
    expect(adapter).not.toBeNull();
  });

  test('write / read / remove 与真实 localStorage 一致', () => {
    const adapter = createDefaultAuthorityAdapter({ id: 'browser-k' }, { logger: createSilentLogger() });
    expect(adapter).not.toBeNull();

    adapter?.write('{"rev":1,"payload":"hello"}');
    expect(localStorage.getItem(buildAuthorityKey('browser-k'))).toBe('{"rev":1,"payload":"hello"}');
    expect(adapter?.read()).toBe('{"rev":1,"payload":"hello"}');

    adapter?.remove();
    expect(localStorage.getItem(buildAuthorityKey('browser-k'))).toBeNull();
    expect(adapter?.read()).toBeNull();
  });

  test('subscribe 能响应手动派发的跨上下文 storage 事件', () => {
    const adapter = createDefaultAuthorityAdapter({ id: 'browser-k' }, { logger: createSilentLogger() });
    const cb = vi.fn();
    const unsubscribe = adapter?.subscribe(cb) || (() => void 0);

    const targetKey = buildAuthorityKey('browser-k');

    // 同上下文 setItem 不会触发 storage 事件（浏览器规范），
    // 但我们可以手动派发一个 StorageEvent 验证监听器绑定生效
    const event = new StorageEvent('storage', {
      key: targetKey,
      newValue: 'remote-update',
      oldValue: null,
      storageArea: localStorage,
    });
    window.dispatchEvent(event);

    expect(cb).toHaveBeenCalledWith('remote-update');

    unsubscribe();

    // 解绑后不再触发
    const event2 = new StorageEvent('storage', {
      key: targetKey,
      newValue: 'ignored',
      oldValue: 'remote-update',
      storageArea: localStorage,
    });
    window.dispatchEvent(event2);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('不同 key 的 storage 事件不会触发回调', () => {
    const adapter = createDefaultAuthorityAdapter({ id: 'browser-k' }, { logger: createSilentLogger() });
    const cb = vi.fn();
    adapter?.subscribe(cb);

    const event = new StorageEvent('storage', {
      key: 'unrelated-key',
      newValue: 'v',
      storageArea: localStorage,
    });
    window.dispatchEvent(event);

    expect(cb).not.toHaveBeenCalled();
  });
});
