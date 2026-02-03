import { describe, expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useStorage } from './index';

describe('useStorage', () => {
  test('导出测试', () => {
    expect(useStorage).toBeTypeOf('function');
  });

  test('基本使用', async () => {
    const { result, act } = await renderHook(() => useStorage('test'));
    const handler = result.current;
    expect(handler.get()).toEqual({});
    act(() => handler.set({ a: 1 }));
    expect(handler.get()).toEqual({ a: 1 });
    expect(handler.get('a')).toBe(1);
    handler.clear();
    expect(handler.get()).toBeNullable();
  });
});
