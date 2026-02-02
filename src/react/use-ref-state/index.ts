import { useMemo, useRef } from 'react';
import { useForceUpdate } from '@/react/use-force-update';

export interface UseRefStateCtrl<T> {
  patchState: (updater: (draft: T) => void, update?: boolean) => void;
  forceUpdate: () => void;
  getState: () => T;
  setState: (state: T, update?: boolean) => void;
  reset: (update?: boolean) => void;
}

function clone<T>(_v: T) {
  return structuredClone(_v);
}

export function useRefState<T>(initialState: T) {
  const stateRef = useRef(initialState);
  const forceUpdate = useForceUpdate();

  const ctrl = useMemo<UseRefStateCtrl<T>>(() => {
    const origin = clone(stateRef.current);

    const updateHandler = (update = true) => void (update && forceUpdate());

    const patchState: UseRefStateCtrl<T>['patchState'] = (updater, update = true) => {
      updater(stateRef.current);
      updateHandler(update);
    };

    const setState: UseRefStateCtrl<T>['setState'] = (state, update = true) => {
      stateRef.current = state;
      updateHandler(update);
    };

    return {
      patchState,
      forceUpdate,
      getState: () => stateRef.current,
      setState,
      reset: (update = true) => setState(clone(origin), update),
    };
  }, [forceUpdate]);

  return [stateRef.current, ctrl] as const;
}
