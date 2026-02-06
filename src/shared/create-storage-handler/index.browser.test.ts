import { describe, expect, test } from 'vitest';
import { sleep } from '@/test/utils';
import { createStorageHandler } from './index';

describe('createStorage', () => {
  test('导出测试', () => {
    expect(createStorageHandler).toBeTypeOf('function');
  });

  test('基本使用', () => {
    const storage = createStorageHandler('test-storage#base');
    expect(storage).toBeTypeOf('object');
    expect(storage.get()).toEqual({});
    expect(storage.set({ num: 1 })).toBeUndefined();
    expect(storage.get()).toEqual({ num: 1 });
    expect(storage.get('num')).toEqual(1);
    expect(storage.set(2, 'num')).toBeUndefined();
    expect(storage.get()).toEqual({ num: 2 });
    expect(storage.clear()).toBeUndefined();
    expect(() => storage.get()).toThrowError();
  });

  test('定时保存', async () => {
    const storageKey = 'test-local-storage#auto-save';
    const storage = createStorageHandler(storageKey, {} as Record<'num', number>, { autoSaveInterval: 100 });
    expect(storage).toBeTypeOf('object');
    expect(storage.get()).toEqual({});
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(storage.set({ num: 1 })).toBeUndefined();
    expect(localStorage.getItem(storageKey)).toBeNull();
    await sleep(110);
    expect(JSON.parse(localStorage.getItem(storageKey) || '{}')).toEqual({ num: 1 });
    expect(storage.clear()).toBeUndefined();
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  test('sessionStorage', () => {
    const storageKey = 'test-session-storage#base';
    const storage = createStorageHandler(storageKey, {} as Record<'num', number>, { storageType: 'session' });
    expect(storage).toBeTypeOf('object');
    expect(storage.get()).toEqual({});
    expect(storage.set({ num: 1 })).toBeUndefined();
    expect(storage.get()).toEqual({ num: 1 });
    expect(storage.get('num')).toEqual(1);
    expect(storage.set(2, 'num')).toBeUndefined();
    expect(storage.get()).toEqual({ num: 2 });
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toEqual({ num: 2 });
    expect(storage.clear()).toBeUndefined();
    expect(() => storage.get()).toThrowError();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  test('memoryStorage', () => {
    const storageKey = 'test-memory-storage#base';
    const storage = createStorageHandler(storageKey, {} as Record<'num', number>, { storageType: 'memory' });
    expect(storage).toBeTypeOf('object');
    expect(storage.get()).toEqual({});
    expect(storage.set({ num: 1 })).toBeUndefined();
    expect(storage.get()).toEqual({ num: 1 });
    expect(storage.get('num')).toEqual(1);
    expect(storage.set(2, 'num')).toBeUndefined();
    expect(storage.get()).toEqual({ num: 2 });
    expect(storage.clear()).toBeUndefined();
    expect(() => storage.get()).toThrowError();
  });

  test('key 已经存在则不使用传入的默认值', () => {
    const storageKey = 'test-local-storage#key-exists';
    localStorage.setItem(storageKey, JSON.stringify({ str: '0' }));
    const storage = createStorageHandler(storageKey, { str: '1' });
    expect(storage.get()).toEqual({ str: '0' });
    expect(storage.clear()).toBeUndefined();
  });

  test('如果是数组', () => {
    const storageKey = 'test-local-storage#array';
    const storage = createStorageHandler(storageKey, [] as number[]);
    expect(storage.get()).toEqual([]);
    expect(storage.set(0, '0')).toBeUndefined();
    expect(storage.clear()).toBeUndefined();
  });
});
