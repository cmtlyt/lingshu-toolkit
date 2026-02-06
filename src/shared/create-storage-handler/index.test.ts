import { describe, expect, test } from 'vitest';
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

  test('clear 之后的操作将会报错', () => {
    const storage = createStorageHandler('test-storage#clear-error');
    expect(storage.get()).toEqual({});
    expect(storage.set({ num: 1 })).toBeUndefined();
    expect(storage.get()).toEqual({ num: 1 });
    expect(storage.get('num')).toEqual(1);
    expect(storage.set(2, 'num')).toBeUndefined();
    expect(storage.get()).toEqual({ num: 2 });
    storage.clear();
    expect(() => storage.get()).toThrowError();
    expect(() => storage.get('num')).toThrowError();
    expect(() => storage.set({ num: 1 })).toThrowError();
    expect(() => storage.set(2, 'num')).toThrowError();
  });
});
