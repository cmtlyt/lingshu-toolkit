import { describe, expect, test } from 'vitest';
import { render, renderHook } from 'vitest-browser-react';
import { useRefState } from './index';

describe('useRefState', () => {
  test('导出测试', () => {
    expect(useRefState).toBeTypeOf('function');
  });

  test('基本使用', async () => {
    const { result, act } = await renderHook(() => useRefState(0));
    expect(result.current[0]).toBe(0);
    act(() => {
      result.current[1].setState(1);
    });
    expect(result.current[0]).toBe(1);
    expect(result.current[1].getState()).toBe(1);
    act(() => {
      result.current[1].reset();
    });
    expect(result.current[0]).toBe(0);
  });

  test('传入对象', async () => {
    const { result, act } = await renderHook(() => useRefState({ num: 0, str: '0' }));
    expect(result.current[0]).toEqual({ num: 0, str: '0' });
    act(() => {
      result.current[1].setState({ num: 1, str: '1' });
    });
    expect(result.current[0]).toEqual({ num: 1, str: '1' });
    expect(result.current[1].getState()).toEqual({ num: 1, str: '1' });
    act(() => {
      result.current[1].reset();
    });
    expect(result.current[0]).toEqual({ num: 0, str: '0' });
    expect(result.current[1].getState()).toBe(result.current[0]);
    act(() => {
      result.current[1].patchState((state) => {
        state.num = 2;
      });
    });
    expect(result.current[0]).toEqual({ num: 2, str: '0' });
  });

  test('组件中使用', async () => {
    const App = () => {
      const [state, ctrl] = useRefState({ num: 0, str: '0' });
      return (
        <div>
          <span data-testid="num">{state.num}</span>
          <span data-testid="str">{state.str}</span>
          <button data-testid="setBtn" onClick={() => ctrl.setState({ num: 1, str: '1' })} type="button" />
          <button data-testid="resetBtn" onClick={() => ctrl.reset()} type="button" />
          <button
            data-testid="patchBtn"
            onClick={() =>
              ctrl.patchState((draft) => {
                draft.num = 2;
              })
            }
            type="button"
          />
          {/* no update */}
          <button data-testid="setBtnNU" onClick={() => ctrl.setState({ num: 1, str: '1' }, false)} type="button" />
          <button data-testid="resetBtnNU" onClick={() => ctrl.reset(false)} type="button" />
          <button
            data-testid="patchBtnNU"
            onClick={() =>
              ctrl.patchState((draft) => {
                draft.num = 2;
              }, false)
            }
            type="button"
          />
          <button data-testid="forceUpdateBtn" onClick={ctrl.forceUpdate} type="button" />
        </div>
      );
    };
    const screne = await render(<App />);
    const $num = screne.getByTestId('num');
    const $str = screne.getByTestId('str');

    await expect.poll(() => $num).toHaveTextContent('0');
    await expect.poll(() => $str).toHaveTextContent('0');

    await screne.getByTestId('setBtn').click();
    await expect.poll(() => $num).toHaveTextContent('1');
    await expect.poll(() => $str).toHaveTextContent('1');

    await screne.getByTestId('resetBtn').click();
    await expect.poll(() => $num).toHaveTextContent('0');
    await expect.poll(() => $str).toHaveTextContent('0');

    await screne.getByTestId('patchBtn').click();
    await expect.poll(() => $num).toHaveTextContent('2');
    await expect.poll(() => $str).toHaveTextContent('0');

    await screne.getByTestId('resetBtn').click();
    await expect.poll(() => $num).toHaveTextContent('0');
    await expect.poll(() => $str).toHaveTextContent('0');

    await screne.getByTestId('patchBtnNU').click();
    await expect.poll(() => $num).toHaveTextContent('0');
    await expect.poll(() => $str).toHaveTextContent('0');

    await screne.getByTestId('forceUpdateBtn').click();
    await expect.poll(() => $num).toHaveTextContent('2');
    await expect.poll(() => $str).toHaveTextContent('0');

    await screne.getByTestId('setBtnNU').click();
    await expect.poll(() => $num).toHaveTextContent('2');
    await expect.poll(() => $str).toHaveTextContent('0');

    await screne.getByTestId('forceUpdateBtn').click();
    await expect.poll(() => $num).toHaveTextContent('1');
    await expect.poll(() => $str).toHaveTextContent('1');

    await screne.getByTestId('resetBtnNU').click();
    await expect.poll(() => $num).toHaveTextContent('1');
    await expect.poll(() => $str).toHaveTextContent('1');

    await screne.getByTestId('forceUpdateBtn').click();
    await expect.poll(() => $num).toHaveTextContent('0');
    await expect.poll(() => $str).toHaveTextContent('0');
  });
});
