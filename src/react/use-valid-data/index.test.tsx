import { useEffect, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, renderHook } from 'vitest-browser-react';
import { $dt, $t, useValidData } from './index';

describe('useValidData', () => {
  test('导出测试', () => {
    expect(useValidData).toBeTypeOf('function');
  });

  test('基本使用', async () => {
    const { result } = await renderHook(() =>
      useValidData({ str: '1', num: 1, bool: true }, $dt({ str: 'string', num: 'number', bool: $t.boolean })),
    );
    expect(result.current).toEqual({ str: '1', num: 1, bool: true });
  });

  test('组件基本使用', async () => {
    const effectFn = vi.fn();
    function App(props: Record<PropertyKey, any>) {
      let { num, str } = useValidData(props, $dt({ str: 'string', num: 'number', bool: $t.boolean }));
      const [, setNum] = useState(num);

      useEffect(() => {
        effectFn();
      }, []);

      return (
        <div data-testid="container" onClick={() => setNum(++num)}>
          {str}
        </div>
      );
    }
    const screne = await render(<App bool num={10} str="123" />);
    const container = screne.getByTestId('container');
    await expect.poll(() => container).toBeInTheDocument();
    await expect.poll(() => container).toHaveTextContent('123');
    expect(effectFn).toHaveBeenCalledOnce();
    // 验证 useValidData 是否能正确更新状态
    screne.rerender(<App bool num={10} str="456" />);
    await expect.poll(() => container).toHaveTextContent('456');
    expect(effectFn).toHaveBeenCalledOnce();
    // 验证 useValidData 是否能正确缓存状态
    await container.click();
    await expect.poll(() => container).toHaveTextContent('456');
    expect(effectFn).toHaveBeenCalledOnce();
  });

  test('不解包', async () => {
    const { result } = await renderHook(() =>
      useValidData({ str: '1', num: 1, bool: true }, $dt({ str: 'string', num: 'number', bool: $t.boolean }), {
        unwrap: false,
      }),
    );
    expect(result.current).toEqual({ result: { str: '1', num: 1, bool: true }, errors: [] });
  });
});
