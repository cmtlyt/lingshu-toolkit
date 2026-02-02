import { useReducer } from 'react';

/**
 * 生成一个在调用时触发组件重新渲染的函数。
 *
 * @returns 用于触发宿主组件重新渲染的函数；不接受参数且不返回值
 */
export function useForceUpdate() {
  const [, forceUpdate] = useReducer((prev) => (prev + 1) % 10, 0);
  return forceUpdate;
}