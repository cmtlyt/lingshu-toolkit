import { describe, expect, test } from 'vitest';
import { createStorageHandler } from './index';

describe('createStorage', () => {
  test('导出测试', () => {
    expect(createStorageHandler).toBeTypeOf('function');
  });

  test('基本使用', () => {
    const storage = createStorageHandler('test-storage');
    expect(storage).toBeTypeOf('object');
    expect(storage.get()).toEqual({});
    expect(storage.set({ num: 1 })).toBeUndefined();
    expect(storage.get()).toEqual({ num: 1 });
    expect(storage.get('num')).toEqual(1);
    expect(storage.set(2, 'num')).toBeUndefined();
    expect(storage.get()).toEqual({ num: 2 });
    expect(storage.clear()).toBeUndefined();
    expect(storage.get()).toBeNullable();
  });
});
