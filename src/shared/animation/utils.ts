import { throwType } from '@/shared/throw-error';
import { getType } from '@/shared/utils/base';
import { type Resolver, withResolvers } from '@/shared/with-resolvers';
import type { AnimationOptions, FormatterValue } from './types';

export function getNextValueHandler<T>(from: T, to: T, valueFormatter: FormatterValue) {
  const type = getType(from);

  // 为每个动画实例创建独立的 context
  const context = {
    progress: 0,
    valueFormatter,
  };

  const baseNextValue = (_from: number, _to: number) => {
    const { valueFormatter: formatter, progress } = context;
    if (getType(_from) !== 'number') {
      return _from;
    }
    return formatter(_from + (_to - _from) * progress);
  };

  const arrayHandler = (_from: any, _to: any) => {
    const result: any[] = Array.from(_from, (item: any, idx: number) => {
      if (Array.isArray(item)) {
        return arrayHandler(item, _to[idx]);
      }
      if (getType(item) === 'object') {
        return objectHandler(item, _to[idx]);
      }
      return baseNextValue(item, _to[idx]);
    });
    return result;
  };

  const objectHandler = (_from: any, _to: any) => {
    const result: Record<PropertyKey, any> = {};
    const keys = Reflect.ownKeys(_from);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const fromValue = _from[key];
      const toValue = _to[key];

      if (Array.isArray(_from[key])) {
        result[key] = arrayHandler(fromValue, toValue);
      } else if (getType(fromValue) === 'object') {
        result[key] = objectHandler(fromValue, toValue);
      } else {
        result[key] = baseNextValue(fromValue, toValue);
      }
    }

    return result;
  };

  let nextValueHandler: (_from: any, _to: any) => any = baseNextValue;

  if (type === 'array') {
    nextValueHandler = arrayHandler;
  } else if (type === 'object') {
    nextValueHandler = objectHandler;
  }

  return (progress: number) => {
    context.progress = progress;
    return nextValueHandler(from, to);
  };
}

export function matchValid(from: any, to: any, valueParser: (value: any) => number) {
  const fromType = getType(from);
  const toType = getType(to);
  if (fromType !== toType) {
    throwType('animation/stepAnimation', 'from and to must be the same type');
  }
  if (fromType === 'array') {
    if ((from as any[]).length !== (to as any[]).length) {
      throwType('animation/stepAnimation', 'from and to must be the same length');
    }
    const result = [Array.from({ length: (from as any[]).length }), Array.from({ length: (to as any[]).length })];
    for (let i = 0; i < (from as any[]).length; i++) {
      const [fromItem, toItem] = matchValid((from as any[])[i], (to as any[])[i], valueParser);
      result[0][i] = fromItem;
      result[1][i] = toItem;
    }
    return result;
  }
  if (fromType === 'object') {
    const toKeys = Reflect.ownKeys(to as Record<PropertyKey, any>);
    const fromKeys = new Set<PropertyKey>(Reflect.ownKeys(from as Record<PropertyKey, any>));
    const result: [Record<PropertyKey, any>, Record<PropertyKey, any>] = [{}, {}];
    for (let i = 0; i < toKeys.length; i++) {
      const key = toKeys[i];
      if (!fromKeys.has(key)) {
        throwType('animation/stepAnimation', `from does not have this key: ${String(key)}`);
      }
      const [fromItem, toItem] = matchValid(
        (from as Record<PropertyKey, any>)[key],
        (to as Record<PropertyKey, any>)[key],
        valueParser,
      );
      result[0][key] = fromItem;
      result[1][key] = toItem;
    }
    return result;
  }
  if (fromType !== 'number') {
    return [valueParser(from), valueParser(to)];
  }
  return [from as number, to as number];
}

export function createNextTick(resolvers: Resolver<any>, rcSignal: RCSignal) {
  const nextTick = (() => {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      return globalThis.requestAnimationFrame;
    }
    return (callback: FrameRequestCallback) => setTimeout(callback, 16);
  })();

  return (callback: (...args: any[]) => void) => {
    if (rcSignal.stopSignal) {
      return true;
    }
    nextTick(() =>
      tryRun(callback, resolvers, (error: any) => {
        rcSignal.stop();
        resolvers.reject(error);
      }),
    );
    return false;
  };
}

export async function tryRun(callback: () => any, resolvers: Resolver<any>, customErrorHandler?: (err: any) => void) {
  return new Promise<void>((resolve, reject) => {
    const result = callback();
    if (result && typeof result.then === 'function') {
      return result.then(resolve, reject);
    }
    resolve();
  }).catch(customErrorHandler || resolvers.reject);
}

export function createRunningControllerSignal(startFn: () => void, options: Required<AnimationOptions<any>>) {
  const { onStart, onStop, onClear } = options;
  const resolvers = withResolvers<boolean>();

  const ctrl = {
    stopSignal: true,
    resolvers,

    stop: () => {
      ctrl.stopSignal = true;
      onStop();
    },
    start: () => {
      ctrl.stopSignal = false;
      onStart();
      startFn();
    },
    clear: () => {
      ctrl.stopSignal = true;
      onClear();
      resolvers.resolve(true);
    },
  };
  return ctrl;
}

export type RCSignal = Omit<ReturnType<typeof createRunningControllerSignal>, 'resolvers'>;
