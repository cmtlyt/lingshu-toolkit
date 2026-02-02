import { useMemo, useRef } from 'react';
import { useForceUpdate } from '@/react/use-force-update';

export interface UseRefStateCtrl<T> {
  patchState: (updater: (draft: T) => void, update?: boolean) => void;
  forceUpdate: () => void;
  getState: () => T;
  setState: (state: T, update?: boolean) => void;
  reset: (update?: boolean) => void;
}

/**
 * 深拷贝传入值，返回与原始值结构相同且不共享引用的副本。
 *
 * @param _v - 要深拷贝的值
 * @returns 与 `_v` 等效的深拷贝值
 */
function clone<T>(_v: T) {
  return structuredClone(_v);
}

/**
 * 提供一个以 useRef 持有可变状态并配套控制器的自定义 React Hook。
 *
 * @param initialState - 初始状态值；该值会被拷贝并保存为重置时的原始快照
 * @returns 第一个元素为当前状态值（来自内部 ref），第二个元素为控制器对象，包含：
 * - `getState()`：返回当前状态值；
 * - `setState(state, update?)`：替换当前状态并可选择触发重渲染；
 * - `patchState(updater, update?)`：对当前状态应用变更函数并可选择触发重渲染；
 * - `reset(update?)`：将状态重置为初始快照并可选择触发重渲染；
 * - `forceUpdate()`：强制触发重渲染。
 */
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