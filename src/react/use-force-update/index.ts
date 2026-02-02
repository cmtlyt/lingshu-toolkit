import { useReducer } from 'react';

export function useForceUpdate() {
  const [, forceUpdate] = useReducer((prev) => (prev + 1) % 10, 0);
  return forceUpdate;
}
