import { describe, expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useTitle } from './index';

describe('useTitle', () => {
  test('导出测试', () => {
    expect(useTitle).toBeTypeOf('function');
  });

  test('基本使用', async () => {
    const { result, act } = await renderHook(() => useTitle('test'));

    expect(document.title).toBe('test');
    act(() => result.current('test2'));
    expect(document.title).toBe('test2');
  });

  test('不传参数', async () => {
    const originalTitle = document.title;
    const { result, act } = await renderHook(() => useTitle());

    expect(document.title).toBe(originalTitle);
    act(() => result.current('test2'));
    expect(document.title).toBe('test2');
  });

  test('卸载时不恢复标题', async () => {
    const originalTitle = document.title;
    const { result, act, unmount } = await renderHook(() => useTitle('test', { restoreOnUnmount: false }));

    expect(document.title).toBe('test');
    act(() => result.current('test2'));
    expect(document.title).toBe('test2');
    unmount();
    expect(document.title).toBe('test2');
    document.title = originalTitle;
  });

  test('参数变更触发标题更新', async () => {
    const { result, act, rerender } = await renderHook<string, ReturnType<typeof useTitle>>((title = 'test') =>
      useTitle(title),
    );

    expect(document.title).toBe('test');
    act(() => result.current('test2'));
    expect(document.title).toBe('test2');
    rerender('test3');
    expect(document.title).toBe('test3');
  });
});
