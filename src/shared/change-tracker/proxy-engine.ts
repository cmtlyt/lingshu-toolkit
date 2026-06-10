import { isProxyable, serializeItems, serializeValue } from './helpers';
import type { CustomTypeConfig, Patch, PatchEmitter } from './types';

const ARRAY_MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice'] as const;

interface SplicePatchInfo {
  emit: PatchEmitter;
  path: (string | number)[];
  index: number;
  deleteCount: number;
  items: unknown[];
  types: CustomTypeConfig<any>[] | undefined;
}

function emitSplicePatch(info: SplicePatchInfo): void {
  const { serializedItems, itemTypeName } = serializeItems(info.items, info.types);
  const patch: Patch = {
    path: info.path,
    op: 'splice',
    index: info.index,
    deleteCount: info.deleteCount,
    items: serializedItems,
    timestamp: Date.now(),
  };
  if (itemTypeName) {
    patch.type = itemTypeName;
  }
  info.emit(patch);
}

const arrayMutatorHandlers: Record<
  (typeof ARRAY_MUTATORS)[number],
  (
    array: unknown[],
    path: (string | number)[],
    args: unknown[],
    emit: PatchEmitter,
    types: CustomTypeConfig<any>[] | undefined,
  ) => unknown
> = {
  push(array, path, args, emit, types) {
    emitSplicePatch({ emit, path, index: array.length, deleteCount: 0, items: args, types });
    return Array.prototype.push.apply(array, args);
  },
  pop(array, path, _args, emit) {
    if (array.length > 0) {
      emit({ path, op: 'splice', index: array.length - 1, deleteCount: 1, items: [], timestamp: Date.now() });
    }
    return Array.prototype.pop.call(array);
  },
  shift(array, path, _args, emit) {
    if (array.length > 0) {
      emit({ path, op: 'splice', index: 0, deleteCount: 1, items: [], timestamp: Date.now() });
    }
    return Array.prototype.shift.call(array);
  },
  unshift(array, path, args, emit, types) {
    emitSplicePatch({ emit, path, index: 0, deleteCount: 0, items: args, types });
    return Array.prototype.unshift.apply(array, args);
  },
  splice(array, path, args, emit, types) {
    const [start, deleteCount = 0, ...insertItems] = args as [number, number?, ...unknown[]];
    const resolvedStart = start < 0 ? Math.max(array.length + start, 0) : Math.min(start, array.length);
    const resolvedDeleteCount = Math.min(deleteCount ?? 0, array.length - resolvedStart);
    emitSplicePatch({ emit, path, index: resolvedStart, deleteCount: resolvedDeleteCount, items: insertItems, types });
    return Array.prototype.splice.apply(array, [resolvedStart, resolvedDeleteCount, ...insertItems]);
  },
};

function createArrayMutatorTrap(
  array: unknown[],
  path: (string | number)[],
  method: (typeof ARRAY_MUTATORS)[number],
  emit: PatchEmitter,
  types: CustomTypeConfig<any>[] | undefined,
): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => arrayMutatorHandlers[method](array, path, args, emit, types);
}

export function createDeepProxy<T extends object>(
  target: T,
  path: (string | number)[],
  emit: PatchEmitter,
  types: CustomTypeConfig<any>[] | undefined,
): T {
  const proxyCache = new Map<string | symbol, unknown>();

  return new Proxy(target, {
    get(rawTarget, prop, receiver) {
      if (typeof prop === 'symbol') {
        return Reflect.get(rawTarget, prop, receiver);
      }

      if (Array.isArray(rawTarget) && (ARRAY_MUTATORS as readonly string[]).includes(prop)) {
        return createArrayMutatorTrap(rawTarget, path, prop as (typeof ARRAY_MUTATORS)[number], emit, types);
      }

      const value = Reflect.get(rawTarget, prop, receiver);

      if (isProxyable(value) && typeof prop === 'string') {
        if (!proxyCache.has(prop)) {
          const childPath = [...path, Array.isArray(rawTarget) ? Number(prop) : prop];
          proxyCache.set(prop, createDeepProxy(value as object, childPath, emit, types));
        }
        return proxyCache.get(prop);
      }

      return value;
    },

    set(rawTarget, prop, newValue) {
      if (typeof prop === 'symbol') {
        return Reflect.set(rawTarget, prop, newValue);
      }

      if (Array.isArray(rawTarget) && prop === 'length') {
        return Reflect.set(rawTarget, prop, newValue);
      }

      const fullPath = [...path, Array.isArray(rawTarget) ? Number(prop) : prop];
      const { serialized, typeName } = serializeValue(newValue, types);

      const patch: Patch = {
        path: fullPath,
        op: 'set',
        value: serialized,
        timestamp: Date.now(),
      };
      if (typeName) {
        patch.type = typeName;
      }
      emit(patch);

      proxyCache.delete(prop);
      return Reflect.set(rawTarget, prop, newValue);
    },

    deleteProperty(rawTarget, prop) {
      if (typeof prop === 'symbol') {
        return Reflect.deleteProperty(rawTarget, prop);
      }

      const fullPath = [...path, Array.isArray(rawTarget) ? Number(prop) : prop];
      emit({ path: fullPath, op: 'delete', timestamp: Date.now() });

      proxyCache.delete(prop);
      return Reflect.deleteProperty(rawTarget, prop);
    },
  });
}
