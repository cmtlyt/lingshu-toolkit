import { describe, expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useBoolean } from './index';

describe('useBoolean', () => {
  const setUp = (defaultValue?: boolean) => renderHook(() => useBoolean(defaultValue));

  test('导出测试', () => {
    expect(useBoolean).toBeTypeOf('function');
  });

  test('方法测试', async () => {
    const { result, act } = await setUp();
    expect(result.current[0]).toBe(false);
    await act(() => {
      result.current[1].setTrue();
    });
    expect(result.current[0]).toBe(true);
    await act(() => {
      result.current[1].setFalse();
    });
    expect(result.current[0]).toBe(false);
    await act(() => {
      result.current[1].toggle();
    });
    expect(result.current[0]).toBe(true);
    await act(() => {
      result.current[1].toggle();
    });
    expect(result.current[0]).toBe(false);
    await act(() => {
      result.current[1].set(false);
    });
    expect(result.current[0]).toBe(false);
    await act(() => {
      result.current[1].set(true);
    });
    expect(result.current[0]).toBe(true);
    await act(() => {
      // @ts-expect-error test
      result.current[1].set(0);
    });
    expect(result.current[0]).toBe(false);
    await act(() => {
      // @ts-expect-error test
      result.current[1].set('a');
    });
    expect(result.current[0]).toBe(true);
  });

  test('默认值测试', async () => {
    const hook1 = await setUp(true);
    expect(hook1.result.current[0]).toBe(true);
    const hook2 = await setUp();
    expect(hook2.result.current[0]).toBe(false);
    // @ts-expect-error test
    const hook3 = await setUp(0);
    expect(hook3.result.current[0]).toBe(false);
    // @ts-expect-error test
    const hook4 = await setUp('');
    expect(hook4.result.current[0]).toBe(false);
    // @ts-expect-error test
    const hook5 = await setUp('hello');
    expect(hook5.result.current[0]).toBe(true);
  });
});
