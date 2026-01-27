import { logger } from '@/shared/logger';
import type { Handler } from './types';

function getType(_v: any) {
  return Object.prototype.toString.call(_v).slice(8, -1).toLowerCase();
}

type TypeHandler = NonNullable<Exclude<Handler<any>, (...args: any[]) => any>[string]>;

type Fullback = ((_v: any) => any) | (any & {});

function typeHandler(type: any, verifyFn?: (_v: any) => boolean) {
  return (fullback?: Fullback): TypeHandler =>
    (_v, actions) => {
      if (verifyFn ? verifyFn(_v) : getType(_v) === type) {
        return true;
      }
      if (fullback == null) {
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
  notNullable: typeHandler('notNullable', (_v) => _v != null),
  string: typeHandler('string'),
  validString: typeHandler('validString', (_v) => typeof _v === 'string' && _v.length > 0),
  number: typeHandler('number'),
  validNumber: typeHandler('validNumber', (_v) => typeof _v === 'number' && !Number.isNaN(_v)),
  boolean: typeHandler('boolean'),
  object: typeHandler('object'),
  array: typeHandler('array'),
  function: typeHandler('function'),
  symbol: typeHandler('symbol'),
} satisfies Record<string, () => TypeHandler>;

export function defineTransform<T extends Record<PropertyKey, any>>(
  dataInfo: Partial<Record<keyof T, keyof typeof $t | TypeHandler>>,
) {
  const verifyInfo: Record<PropertyKey, TypeHandler> = {};
  const keys = Reflect.ownKeys(dataInfo);
  for (let i = 0, key = keys[i], item = dataInfo[key]; i < keys.length; key = keys[++i], item = dataInfo[key]) {
    if (typeof item === 'function') {
      verifyInfo[key] = item;
      continue;
    }
    const handler = $t[item as keyof typeof $t];
    if (!handler) {
      logger.warn(`${item} is not a valid type`);
      continue;
    }
    verifyInfo[key] = handler();
  }
  return verifyInfo;
}

export const $dt = defineTransform;
