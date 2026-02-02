import { useReducer } from 'react';

export function useForceUpdate() {
  const [, forceUpdate] = useReducer(() => Math.random(), 0);
  return forceUpdate;
}
