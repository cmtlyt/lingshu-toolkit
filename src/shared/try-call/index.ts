import { isFunction, isPromiseLike } from '@/shared/utils/verify';
import { throwType } from '../throw-error';

type TryCallResult<R, E> = [E] extends [never] ? (R extends Promise<any> ? Promise<Awaited<R>> : R) : R | E;

/**
 * 包装一个拦截错误的函数
 *
 * @platform web, node, webworker
 *
 * @param cb 回调函数
 * @param onError 错误处理函数
 */
export function tryCallFunc<A extends any[], R, E = never>(
  cb: (...args: A) => R,
  onError?: ((err: any) => E) | null,
  onFinal?: (result: TryCallResult<R, E>) => void,
): (...args: A) => TryCallResult<R, E> {
  if (!isFunction(cb)) {
    throwType('tryCallFunc', 'callback is not a function');
  }

  let result = void 0 as TryCallResult<R, E>;

  const tryFn = function (this: any, args: A) {
    result = Reflect.apply(cb, this, args) as any;
    if (isPromiseLike(result) && isFunction(onError)) {
      result = (result as unknown as Promise<any>).catch(onError) as any;
    }
  };

  const catchFn = (error: any) => {
    result = onError!(error) as any;
  };

  const finallyFn = () => {
    onFinal!(result);
  };

  if (isFunction(onFinal) && isFunction(onError)) {
    return function (this: any, ...args) {
      try {
        Reflect.apply(tryFn, this, [args]);
      } catch (e) {
        catchFn(e);
      } finally {
        finallyFn();
      }
      return result;
    };
  }

  if (isFunction(onError)) {
    return function (this: any, ...args) {
      try {
        Reflect.apply(tryFn, this, [args]);
      } catch (e) {
        catchFn(e);
      }
      return result;
    };
  }

  if (isFunction(onFinal)) {
    return function (this: any, ...args) {
      try {
        Reflect.apply(tryFn, this, [args]);
      } finally {
        finallyFn();
      }
      return result;
    };
  }

  return function (this: any, ...args) {
    Reflect.apply(tryFn, this, [args]);
    return result;
  };
}

/**
 * 尝试调用函数
 *
 * @platform web, node, webworker
 *
 * @param cb 回调函数
 * @param onError 错误处理函数
 */
export function tryCall<R, E = never>(
  this: any,
  cb: () => R,
  onError?: ((err: any) => E) | null,
  onFinal?: (result: TryCallResult<R, E>) => void,
): TryCallResult<R, E> {
  if (!isFunction(cb)) {
    throwType('tryCall', 'callback is not a function');
  }

  return tryCallFunc(cb, onError, onFinal).call(this);
}
