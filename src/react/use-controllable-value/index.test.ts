import { describe, expect, test, vi } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useControllableValue } from './index';

describe('useControllableValue', () => {
  const setUp = (...args: Parameters<typeof useControllableValue>) => renderHook(() => useControllableValue(...args));

  test('传入 defaultValue 正常工作', async () => {
    const hook = await setUp({ defaultValue: 1 });
    expect(hook.result.current[0]).toBe(1);
  });

  test('传入 value 正常工作', async () => {
    const hook = await setUp({ defaultValue: 1, value: 2 });
    expect(hook.result.current[0]).toBe(2);
  });

  test('不传递参数状态应为 undefined', async () => {
    const hook = await setUp();
    expect(hook.result.current[0]).toBeUndefined();
  });

  test('传入 onChange 应该正常触发', async () => {
    let extraParam = '';
    let value = 2;
    const props = {
      get value() {
        return value;
      },
      onChange(_v: any, extra: any) {
        value = _v;
        extraParam = extra;
      },
    };
    const hook = await setUp(props);
    expect(hook.result.current[0]).toBe(2);
    await hook.act(() => {
      hook.result.current[1](3, 'extraParam');
    });
    expect(props.value).toBe(3);
    expect(extraParam).toBe('extraParam');
  });

  test('测试受控状态更新', async () => {
    const props: any = {
      value: 1,
    };
    const { result, rerender } = await setUp(props);
    props.value = 2;
    await rerender(props);
    expect(result.current[0]).toBe(2);
    props.value = 3;
    await rerender(props);
    expect(result.current[0]).toBe(3);
  });

  test('测试使用 setValue 更新状态', async () => {
    const { act, result } = await setUp({
      newValue: 1,
    });
    const [, setValue] = result.current;
    await act(() => setValue(undefined));
    expect(result.current[0]).toBeUndefined();

    await act(() => setValue(null));
    expect(result.current[0]).toBeNull();

    await act(() => setValue(55));
    expect(result.current[0]).toBe(55);

    await act(() => setValue((prevState: number) => prevState + 1));
    expect(result.current[0]).toBe(56);
  });

  test('类型检查', async () => {
    type Value = {
      foo: number;
    };
    const props: {
      value: Value;
      defaultValue: Value;
      onChange: (val: Value) => void;
    } = {
      value: {
        foo: 123,
      },
      defaultValue: {
        foo: 123,
      },
      onChange: () => void 0,
    };
    const hook = await renderHook(() => useControllableValue(props));
    const [_v] = hook.result.current;
    expect(_v.foo).toBe(123);
  });

  test('自定义 value 和 trigger 属性 name', async () => {
    const props = { foo: 1, bar: 2, baz: vi.fn() };
    const { act, result } = await renderHook(() =>
      useControllableValue(props, { valuePropName: 'foo', trigger: 'baz' }),
    );
    const [, setValue] = result.current;
    expect(result.current[0]).toBe(1);
    await act(() => {
      setValue(3);
    });
    expect(result.current[0]).toBe(1);
    expect(props.baz).toHaveBeenCalledOnce();
  });

  test('自定义 defaultValue 和 trigger 属性 name', async () => {
    const props = { foo: 1, bar: 2, baz: vi.fn() };
    const { act, result } = await renderHook(() =>
      useControllableValue(props, { defaultValuePropName: 'foo', trigger: 'baz' }),
    );
    const [, setValue] = result.current;
    expect(result.current[0]).toBe(1);
    await act(() => {
      setValue(3);
    });
    expect(result.current[0]).toBe(3);
    expect(props.baz).toHaveBeenCalledOnce();
  });
});
