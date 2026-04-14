import { describe, expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useCounter } from './index';

describe('useCounter', () => {
  test('导出测试', () => {
    expect(useCounter).toBeTypeOf('function');
  });

  test('基本使用', async () => {
    const { result, act } = await renderHook(() => useCounter(0));
    const [, actions] = result.current;

    expect(result.current[0]).toBe(0);
    await act(() => {
      actions.increment();
    });
    expect(result.current[0]).toBe(1);
    await act(() => {
      actions.decrement();
    });
    expect(result.current[0]).toBe(0);
    await act(() => {
      actions.set(10);
    });
    expect(result.current[0]).toBe(10);
    await act(() => {
      actions.reset();
    });
    expect(result.current[0]).toBe(0);
  });

  test('参数兜底测试', async () => {
    // @ts-expect-error test
    const { result, act } = await renderHook(() => useCounter(0, { min: 1, max: 'a10', step: '10' }));
    const [, actions] = result.current;

    expect(result.current[0]).toBe(1);
    await act(() => {
      actions.increment();
    });
    expect(result.current[0]).toBe(11);
  });
});
