import { throwType } from '@/shared/throw-error';
import { isFunction, isPromiseLike } from '@/shared/utils/verify';

type TryCallResultValue<R, E> = Awaited<[E] extends [never] ? R : R | E>;

type TryCallResult<R, E> = [R] extends [never]
  ? E
  : R extends PromiseLike<infer P>
    ? Promise<TryCallResultValue<P, E>>
    : TryCallResultValue<R, E>;

type TryCallFinalArgs<R, E> = TryCallResultValue<R, E> | Error;

const EMPTY = Symbol('EMPTY');

interface TryCallCtx {
  oriResult: any;
  errorResult: any;
  error: any;
}

/**
 * 包装一个拦截错误的函数
 *
 * @platform web, node, webworker
 *
 * @param cb 回调函数
 * @param onError 错误处理函数
 */
function tryCallFunc<A extends any[], R, E = never>(
  cb: (...args: A) => R,
  onError?: ((err: any) => E) | null,
  onFinal?: (result: TryCallFinalArgs<R, E>) => void,
): (...args: A) => TryCallResult<R, E> {
  if (!isFunction(cb)) {
    throwType('tryCallFunc', 'callback is not a function');
  }

  const catchFn = (self: any, ctx: TryCallCtx, error: any): any => {
    if (isFunction(onError)) {
      try {
        ctx.errorResult = Reflect.apply(onError, self, [error]);
      } catch (err) {
        ctx.error = err;
      }
    } else {
      ctx.error = error;
    }
    return ctx.errorResult;
  };

  const finallyFn = (self: any, ctx: TryCallCtx, result: any): void => {
    try {
      if (ctx.error !== EMPTY) {
        throw ctx.error;
      }
    } finally {
      if (isFunction(onFinal)) {
        if (ctx.errorResult !== EMPTY) {
          Reflect.apply(onFinal, self, [ctx.errorResult]);
        } else if (ctx.error === EMPTY) {
          Reflect.apply(onFinal, self, [result]);
        } else {
          Reflect.apply(onFinal, self, [ctx.error]);
        }
      }
    }
  };

  return function (this: any, ...args: A) {
    const ctx = {
      oriResult: EMPTY as R,
      errorResult: EMPTY as E,
      error: EMPTY as any,
    };

    const asyncFn = async (): Promise<any> => {
      try {
        ctx.oriResult = Reflect.apply(cb, this, args);
        // 如果是 promise 状态会被吸收, 否则 promise 直接完成
        return ctx.oriResult;
      } catch (error) {
        return catchFn(this, ctx, error);
      }
    };

    const fnPromise = asyncFn().catch((error) => {
      // 捕获异步任务中抛出的错误, 包括异步任务中的同步错误
      return catchFn(this, ctx, error);
    });

    if (isPromiseLike(ctx.oriResult)) {
      // 如果原始结果是 promise 则等待完成再调用 finally
      return fnPromise.then((result) => {
        finallyFn(this, ctx, result);
        return result;
      });
    }

    finallyFn(this, ctx, ctx.oriResult);
    return ctx.oriResult === EMPTY ? ctx.errorResult : (ctx.oriResult as any);
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
function tryCall<R, E = never>(
  this: any,
  cb: () => R,
  onError?: ((err: any) => E) | null,
  onFinal?: (result: TryCallFinalArgs<R, E>) => void,
): TryCallResult<R, E> {
  if (!isFunction(cb)) {
    throwType('tryCall', 'callback is not a function');
  }

  return tryCallFunc(cb, onError, onFinal).call(this);
}

export { tryCall, tryCallFunc };
