import { useMemo, useRef, useState } from 'react';
import { throwType } from '@/shared/throw-error';

interface Actions<T> {
  set: (value: T) => void;
  setLeft: () => void;
  setRight: () => void;
  toggle: () => void;
}

function useToggle(): [boolean, Actions<boolean>];
function useToggle<L>(defaultValue: L): [L, Actions<L>];
function useToggle<L, R>(defaultValue: L, reverseValue: R): [L | R, Actions<L | R>];
function useToggle<L, R>(defualtValue = false as L, reverseValue?: R) {
  const [state, setState] = useState<L | R>(defualtValue);
  const toggleRef = useRef([
    defualtValue,
    (typeof reverseValue === 'undefined' ? !defualtValue : reverseValue) as R,
  ] as const);

  const actions: Actions<L | R> = useMemo(() => {
    const [left, right] = toggleRef.current;

    return {
      set: (value: L | R) => {
        if (value !== left && value !== right) {
          throwType('useToggle', 'value is not left or right');
        }
        setState(value);
      },
      setLeft: () => setState(left),
      setRight: () => setState(right),
      toggle: () => setState((prev) => (prev === left ? right : left)),
    };
  }, []);

  return [state, actions];
}

export { useToggle };
