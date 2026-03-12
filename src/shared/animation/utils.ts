export type Formatter = (value: number) => any;

export const noop = () => void 0;

export const identity = <T>(_v: T) => _v;

const context = {
  progress: 0,
  valueFormatter: identity as Formatter,
};

function getType(_v: any): string {
  return Object.prototype.toString.call(_v).slice(8, -1).toLowerCase();
}

const baseNextValue = (from: number, to: number) => {
  const { valueFormatter, progress } = context;
  return valueFormatter(from + (to - from) * progress);
};

const arrayHandler = (from: any, to: any) => {
  const result: any[] = Array.from(from, (item: any, idx: number) => {
    if (Array.isArray(item)) {
      return arrayHandler(item, to[idx]);
    }
    if (getType(item) === 'object') {
      return objectHandler(item, to[idx]);
    }
    return baseNextValue(item, to[idx]);
  });
  return result;
};

const objectHandler = (from: any, to: any) => {
  const result: Record<PropertyKey, any> = {};
  const keys = Reflect.ownKeys(from);

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const fromValue = from[key];
    const toValue = to[key];

    if (Array.isArray(from[key])) {
      result[key] = arrayHandler(fromValue, toValue);
    } else if (getType(fromValue) === 'object') {
      result[key] = objectHandler(fromValue, toValue);
    } else {
      result[key] = baseNextValue(fromValue, toValue);
    }
  }

  return result;
};

export function getNextValueHandler(from: any, to: any, valueFormatter: Formatter) {
  const type = getType(from);

  let nextValueHandler: (_from: any, _to: any) => any = baseNextValue;

  if (type === 'array') {
    nextValueHandler = arrayHandler;
  } else if (type === 'object') {
    nextValueHandler = objectHandler;
  }

  return (progress: number) => {
    context.progress = progress;
    context.valueFormatter = valueFormatter;
    const nextValue = nextValueHandler(from, to);
    context.valueFormatter = identity;
    return nextValue;
  };
}

export function matchValid(from: any, to: any, valueParser: (value: any) => number) {
  const fromType = getType(from);
  const toType = getType(to);
  if (fromType !== toType) {
    throw new TypeError('from and to must be the same type');
  }
  if (fromType === 'array') {
    if ((from as any[]).length !== (to as any[]).length) {
      throw new TypeError('from and to must be the same length');
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
        throw new TypeError('from and to must be the same keys');
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

export const nextTick = (() => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame;
  }
  return (callback: FrameRequestCallback) => setTimeout(callback, 16);
})();
