import { logger } from '@/shared/logger';
import { throwType } from '@/shared/throw-error';
import { isNullOrUndef } from '@/shared/utils';
import { getType } from '@/shared/utils/base';
import type { Handler } from './types';

type TypeHandler = NonNullable<Exclude<Handler<any>, (...args: any[]) => any>[string]>;

type TypeHandlerParams = Parameters<TypeHandler> extends [any, ...infer Rest] ? Rest : never;

type ParseType<T extends string> = T extends keyof TypeMap ? TypeMap[T] : any;

type TypeHandlerInfo<T extends string> = (value: ParseType<T>, ...args: TypeHandlerParams) => ReturnType<TypeHandler>;

type Fullback<T extends string> = T extends 'function'
  ? (_v: any) => ParseType<T>
  : ((_v: any) => ParseType<T>) | (ParseType<T> & {});

function typeHandler<T extends string>(type: T, verifyFn?: (_v: any) => boolean) {
  return (fullback?: Fullback<T>): TypeHandlerInfo<T> =>
    (_v, actions) => {
      if (verifyFn ? verifyFn(_v) : getType(_v) === type) {
        return true;
      }
      if (isNullOrUndef(fullback)) {
        return false;
      }
      let fullbackValue = fullback;
      if (typeof fullback === 'function') {
        fullbackValue = fullback(_v);
      }
      actions.transform(fullbackValue);
    };
}

interface TypeMap {
  notNullable: any & {};
  string: string;
  validString: string;
  number: number;
  validNumber: number;
  boolean: boolean;
  object: Record<PropertyKey, any>;
  array: any[];
  function: (...args: any[]) => any;
  symbol: symbol;
  enum: any & {};
}

const $t = {
  notNullable: typeHandler('notNullable', (_v) => !isNullOrUndef(_v)),
  string: typeHandler('string'),
  validString: typeHandler('validString', (_v) => typeof _v === 'string' && _v.length > 0),
  number: typeHandler('number'),
  validNumber: typeHandler('validNumber', (_v) => typeof _v === 'number' && !Number.isNaN(_v)),
  boolean: typeHandler('boolean'),
  object: typeHandler('object'),
  array: typeHandler('array'),
  function: typeHandler('function'),
  symbol: typeHandler('symbol'),
  enum: <T>(list: T[], fullback?: T) => {
    if (!Array.isArray(list)) {
      throwType('$t.enum', 'list must be an array');
    }
    const set = new Set(list);
    return typeHandler('enum', (_v) => set.has(_v))(fullback);
  },
} satisfies Record<keyof TypeMap, TypeHandler>;

type TransformMap = typeof $t;

type TransformKey = Exclude<keyof TransformMap, 'enum'>;

type DataTransformResult<D extends Record<PropertyKey, TransformKey | TypeHandler | undefined>> = {
  [K in keyof D]: D[K] extends TransformKey ? TransformMap[D[K]] : D[K];
};

type Transform2Type<R extends DataTransformResult<any>> = {
  [K in keyof R]: R[K] extends TypeHandlerInfo<infer T> ? ParseType<T> & {} : any & {};
};

function defineTransform<
  T extends Record<PropertyKey, any>,
  D extends Partial<Record<keyof T, TransformKey | TypeHandler>> = Partial<Record<keyof T, TransformKey | TypeHandler>>,
>(dataInfo: D): DataTransformResult<D> {
  const verifyInfo: Record<PropertyKey, TypeHandler> = {};
  const keys = Reflect.ownKeys(dataInfo);
  for (let i = 0, key = keys[i], item = dataInfo[key]; i < keys.length; key = keys[++i], item = dataInfo[key]) {
    if (typeof item === 'function') {
      verifyInfo[key] = item;
      continue;
    }
    const handler = $t[item as TransformKey];
    if (!handler) {
      logger.warn('defineTransform', `${item} is not a valid type`);
      continue;
    }
    verifyInfo[key] = handler();
  }
  return verifyInfo as DataTransformResult<D>;
}

export { $t, defineTransform, defineTransform as $dt, type Transform2Type };
