import { describe, expect, test, vi } from 'vitest';
import { render, renderHook } from 'vitest-browser-react';
import { ErrorBoundary } from '@/test/utils';
import { useMount } from './index';

describe('useMount', () => {
  test('导出测试', () => {
    expect(useMount).toBeTypeOf('function');
  });

  test('基本使用', async () => {
    const callback = vi.fn();
    await renderHook(() => useMount(callback));
    expect(callback).toBeCalledTimes(1);
  });

  test('不传递参数', async () => {
    const Test = () => {
      // @ts-expect-error test
      useMount();
      return null;
    };
    const errorCallback = vi.fn();
    const App = () => (
      <ErrorBoundary onError={errorCallback}>
        <Test />
      </ErrorBoundary>
    );
    await render(<App />);
    expect(errorCallback).toBeCalledTimes(1);
  });
});
