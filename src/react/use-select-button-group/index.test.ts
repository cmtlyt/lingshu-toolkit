import { describe, expect, it } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useSelectButtonGroup } from '@/react/use-select-button-group';

describe('useSelectButtonGroup', () => {
  describe('single mode', () => {
    describe('uncontrolled', () => {
      it('should initialize with undefined when no defaultValue', async () => {
        const { result } = await renderHook(() => useSelectButtonGroup({ mode: 'single' }));
        expect(result.current[0]).toBeUndefined();
      });

      it('should initialize with defaultValue', async () => {
        const { result } = await renderHook(() => useSelectButtonGroup({ mode: 'single', defaultValue: 'button1' }));
        expect(result.current[0]).toBe('button1');
      });

      it('should select a value', async () => {
        const { result, act } = await renderHook(() => useSelectButtonGroup({ mode: 'single' }));

        act(() => {
          result.current[1].select('button1');
        });

        expect(result.current[0]).toBe('button1');
      });

      it('should clear selected value', async () => {
        const { result, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'single', defaultValue: 'button1' }),
        );

        act(() => {
          result.current[1].clear();
        });

        expect(result.current[0]).toBeUndefined();
      });

      it('should check if value is selected', async () => {
        const { result } = await renderHook(() => useSelectButtonGroup({ mode: 'single', defaultValue: 'button1' }));

        expect(result.current[1].isSelected('button1')).toBe(true);
        expect(result.current[1].isSelected('button2')).toBe(false);
      });

      it('should update selection', async () => {
        const { result, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'single', defaultValue: 'button1' }),
        );

        act(() => {
          result.current[1].select('button2');
        });

        expect(result.current[0]).toBe('button2');
        expect(result.current[1].isSelected('button1')).toBe(false);
        expect(result.current[1].isSelected('button2')).toBe(true);
      });
    });

    describe('controlled', () => {
      it('should use controlled value', async () => {
        const { result } = await renderHook(() => useSelectButtonGroup({ mode: 'single', value: 'button1' }));
        expect(result.current[0]).toBe('button1');
      });

      it('should call onChange when selecting', async () => {
        let controlledValue: string | undefined = 'button1';
        const onChange = (value: string | undefined) => {
          controlledValue = value;
        };

        const { result, rerender, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'single', value: controlledValue, onChange }),
        );

        act(() => {
          result.current[1].select('button2');
        });

        expect(controlledValue).toBe('button2');

        await rerender();
        expect(result.current[0]).toBe('button2');
      });

      it('should call onChange when clearing', async () => {
        let controlledValue: string | undefined = 'button1';
        const onChange = (value: string | undefined) => {
          controlledValue = value;
        };

        const { result, rerender, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'single', value: controlledValue, onChange }),
        );

        act(() => {
          result.current[1].clear();
        });

        expect(controlledValue).toBeUndefined();

        await rerender();
        expect(result.current[0]).toBeUndefined();
      });
    });
  });

  describe('multiple mode', () => {
    describe('uncontrolled', () => {
      it('should initialize with empty array when no defaultValue', async () => {
        const { result } = await renderHook(() => useSelectButtonGroup({ mode: 'multiple' }));
        expect(result.current[0]).toEqual([]);
      });

      it('should initialize with defaultValue', async () => {
        const { result } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', defaultValue: ['button1', 'button2'] }),
        );
        expect(result.current[0]).toEqual(['button1', 'button2']);
      });

      it('should select a value', async () => {
        const { result, act } = await renderHook(() => useSelectButtonGroup({ mode: 'multiple' }));

        act(() => {
          result.current[1].select('button1');
        });

        expect(result.current[0]).toEqual(['button1']);
      });

      it('should not add duplicate values when selecting', async () => {
        const { result, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', defaultValue: ['button1'] }),
        );

        act(() => {
          result.current[1].select('button1');
        });

        expect(result.current[0]).toEqual(['button1']);
      });

      it('should deselect a value', async () => {
        const { result, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', defaultValue: ['button1', 'button2'] }),
        );

        act(() => {
          result.current[1].deselect('button1');
        });

        expect(result.current[0]).toEqual(['button2']);
      });

      it('should toggle a value', async () => {
        const { result, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', defaultValue: ['button1'] }),
        );

        act(() => {
          result.current[1].toggle('button2');
        });

        expect(result.current[0]).toEqual(['button1', 'button2']);

        act(() => {
          result.current[1].toggle('button1');
        });

        expect(result.current[0]).toEqual(['button2']);
      });

      it('should clear all selected values', async () => {
        const { result, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', defaultValue: ['button1', 'button2'] }),
        );

        act(() => {
          result.current[1].clear();
        });

        expect(result.current[0]).toEqual([]);
      });

      it('should select all values', async () => {
        const { result, act } = await renderHook(() => useSelectButtonGroup({ mode: 'multiple' }));

        act(() => {
          result.current[1].selectAll(['button1', 'button2', 'button3']);
        });

        expect(result.current[0]).toEqual(['button1', 'button2', 'button3']);
      });

      it('should check if value is selected', async () => {
        const { result } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', defaultValue: ['button1', 'button2'] }),
        );

        expect(result.current[1].isSelected('button1')).toBe(true);
        expect(result.current[1].isSelected('button2')).toBe(true);
        expect(result.current[1].isSelected('button3')).toBe(false);
      });
    });

    describe('controlled', () => {
      it('should use controlled value', async () => {
        const { result } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', value: ['button1', 'button2'] }),
        );
        expect(result.current[0]).toEqual(['button1', 'button2']);
      });

      it('should call onChange when selecting', async () => {
        let controlledValue: string[] = ['button1'];
        const onChange = (value: string[]) => {
          controlledValue = value;
        };

        const { result, rerender, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', value: controlledValue, onChange }),
        );

        act(() => {
          result.current[1].select('button2');
        });

        expect(controlledValue).toEqual(['button1', 'button2']);

        await rerender();
        expect(result.current[0]).toEqual(['button1', 'button2']);
      });

      it('should call onChange when deselecting', async () => {
        let controlledValue: string[] = ['button1', 'button2'];
        const onChange = (value: string[]) => {
          controlledValue = value;
        };

        const { result, rerender, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', value: controlledValue, onChange }),
        );

        act(() => {
          result.current[1].deselect('button1');
        });

        expect(controlledValue).toEqual(['button2']);

        await rerender();
        expect(result.current[0]).toEqual(['button2']);
      });

      it('should call onChange when toggling', async () => {
        let controlledValue: string[] = ['button1'];
        const onChange = (value: string[]) => {
          controlledValue = value;
        };

        const { result, rerender, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', value: controlledValue, onChange }),
        );

        act(() => {
          result.current[1].toggle('button2');
        });

        expect(controlledValue).toEqual(['button1', 'button2']);

        await rerender();
        expect(result.current[0]).toEqual(['button1', 'button2']);

        act(() => {
          result.current[1].toggle('button1');
        });

        expect(controlledValue).toEqual(['button2']);

        await rerender();
        expect(result.current[0]).toEqual(['button2']);
      });

      it('should call onChange when clearing', async () => {
        let controlledValue: string[] = ['button1', 'button2'];
        const onChange = (value: string[]) => {
          controlledValue = value;
        };

        const { result, rerender, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', value: controlledValue, onChange }),
        );

        act(() => {
          result.current[1].clear();
        });

        expect(controlledValue).toEqual([]);

        await rerender();
        expect(result.current[0]).toEqual([]);
      });

      it('should call onChange when selecting all', async () => {
        let controlledValue: string[] = [];
        const onChange = (value: string[]) => {
          controlledValue = value;
        };

        const { result, rerender, act } = await renderHook(() =>
          useSelectButtonGroup({ mode: 'multiple', value: controlledValue, onChange }),
        );

        act(() => {
          result.current[1].selectAll(['button1', 'button2', 'button3']);
        });

        expect(controlledValue).toEqual(['button1', 'button2', 'button3']);

        await rerender();
        expect(result.current[0]).toEqual(['button1', 'button2', 'button3']);
      });
    });
  });
});
