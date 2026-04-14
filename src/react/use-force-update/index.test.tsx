import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useForceUpdate } from './index';

describe('useForceUpdate', () => {
  test('导出测试', () => {
    expect(useForceUpdate).toBeTypeOf('function');
  });

  test('基本使用', async () => {
    const renderCounter = vi.fn();
    const Test = () => {
      const forceUpdate = useForceUpdate();
      renderCounter();
      return <button data-testid="btn" onClick={forceUpdate} type="button" />;
    };

    const screen = await render(<Test />);
    const $btn = screen.getByTestId('btn');
    expect(renderCounter).toHaveBeenCalledTimes(1);
    await $btn.click();
    expect(renderCounter).toHaveBeenCalledTimes(2);
    await $btn.click();
    expect(renderCounter).toHaveBeenCalledTimes(3);
  });
});
