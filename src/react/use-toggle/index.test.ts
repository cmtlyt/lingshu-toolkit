import { describe, expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useToggle } from './index';

describe('useToggle', () => {
  test('导出测试', () => {
    expect(useToggle).toBeTypeOf('function');
  });

  test('无参数', async () => {
    const { result, act } = await renderHook(() => useToggle());
    expect(result.current[0]).toBe(false);
    await act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(true);
    // @ts-expect-error test
    expect(() => result.current[1].set('')).toThrow(TypeError);
  });

  test('1 个参数', async () => {
    const { result, act } = await renderHook(() => useToggle(true));
    expect(result.current[0]).toBe(true);
    await act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(false);
    await act(() => result.current[1].set(true));
    expect(result.current[0]).toBe(true);
  });

  test('1 个非布尔值参数', async () => {
    const { result, act } = await renderHook(() => useToggle(1));
    expect(result.current[0]).toBe(1);
    await act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(false);
    await act(() => result.current[1].set(1));
    expect(result.current[0]).toBe(1);
  });

  test('2 个参数', async () => {
    const { result, act } = await renderHook(() => useToggle(true, false));
    expect(result.current[0]).toBe(true);
    await act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(false);
    await act(() => result.current[1].set(true));
    expect(result.current[0]).toBe(true);
    await act(() => result.current[1].set(false));
    expect(result.current[0]).toBe(false);
  });

  test('2 个非布尔值参数', async () => {
    const { result, act } = await renderHook(() => useToggle(1, 2));
    expect(result.current[0]).toBe(1);
    await act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(2);
    await act(() => result.current[1].setLeft());
    expect(result.current[0]).toBe(1);
    await act(() => result.current[1].setRight());
    expect(result.current[0]).toBe(2);
    await act(() => result.current[1].toggle());
    expect(result.current[0]).toBe(1);
    expect(() => result.current[1].set(3)).toThrow(TypeError);
  });
});
