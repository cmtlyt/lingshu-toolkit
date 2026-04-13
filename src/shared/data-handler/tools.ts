import { logger } from '@/shared/logger';
import { throwType } from '@/shared/throw-error';
import { getType } from '@/shared/utils/base';
import { isNullOrUndef } from '@/shared/utils/verify';
import type { Fullback, ParseType, TypeHandler, TypeHandlerInfo, TypeMap } from './types';

export function typeHandler<T extends string>(type: T, verifyFn?: (_v: any) => boolean) {
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

export const $t = {
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

export type TransformMap = typeof $t;

export type TransformKey = Exclude<keyof TransformMap, 'enum'>;

export type DataTransformResult<D extends Record<PropertyKey, TransformKey | TypeHandler | undefined>> = {
  [K in keyof D]: D[K] extends TransformKey ? TransformMap[D[K]] : D[K];
};

export type Transform2Type<R extends DataTransformResult<any>> = {
  [K in keyof R]: R[K] extends TypeHandlerInfo<infer T> ? ParseType<T> & {} : any & {};
};

export function defineTransform<
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

export { defineTransform as $dt };
