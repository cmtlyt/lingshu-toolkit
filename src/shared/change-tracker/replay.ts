import { throwError } from '@/shared/throw-error';
import { deepClone, isProxyable } from './helpers';
import type { CustomTypeConfig, Patch, ReplayOptions } from './types';

function resolvePathParent(
  root: object,
  path: (string | number)[],
): { parent: Record<string, unknown> | unknown[]; lastKey: string | number } {
  let current: unknown = root;

  for (let idx = 0; idx < path.length - 1; idx++) {
    const key = path[idx];
    if (!isProxyable(current)) {
      throwError('replay', `Cannot traverse path: value at "${path.slice(0, idx).join('.')}" is not an object.`);
    }
    current = (current as Record<string | number, unknown>)[key];
  }

  if (!isProxyable(current)) {
    throwError('replay', `Cannot apply patch: parent at "${path.slice(0, -1).join('.')}" is not an object.`);
  }

  return { parent: current as Record<string, unknown> | unknown[], lastKey: path[path.length - 1] };
}

function deserializeValue(
  value: unknown,
  typeName: string | undefined,
  typeMap: Map<string, CustomTypeConfig<any>>,
): unknown {
  if (!typeName) {
    return value;
  }
  const config = typeMap.get(typeName);
  if (!config) {
    return value;
  }
  return config.deserialize(value);
}

function applyPatch(target: object, patch: Patch, typeMap: Map<string, CustomTypeConfig<any>>): void {
  if (patch.path.length === 0) {
    throwError('replay', 'Patch path cannot be empty.');
  }

  const { parent, lastKey } = resolvePathParent(target, patch.path);

  switch (patch.op) {
    case 'set': {
      const deserialized = deserializeValue(patch.value, patch.type, typeMap);
      (parent as Record<string | number, unknown>)[lastKey] = deserialized;
      break;
    }
    case 'delete': {
      if (Array.isArray(parent)) {
        delete (parent as unknown[])[lastKey as number];
      } else {
        delete (parent as Record<string, unknown>)[lastKey as string];
      }
      break;
    }
    case 'splice': {
      const arr = (parent as Record<string | number, unknown>)[lastKey];
      if (!Array.isArray(arr)) {
        throwError('replay', `Cannot apply splice: value at "${patch.path.join('.')}" is not an array.`);
      }
      const deserializedItems = patch.items
        ? patch.items.map((item) => deserializeValue(item, patch.type, typeMap))
        : [];
      arr.splice(patch.index ?? 0, patch.deleteCount ?? 0, ...deserializedItems);
      break;
    }
    default:
      break;
  }
}

export function replay<T extends object>(baseObject: T, patchList: Patch[], options?: ReplayOptions): T {
  const target = options?.mutate ? baseObject : deepClone(baseObject);

  const typeMap = new Map<string, CustomTypeConfig<any>>();
  if (options?.types) {
    for (const config of options.types) {
      typeMap.set(config.type, config);
    }
  }

  const sorted = [...patchList].sort((left, right) => left.timestamp - right.timestamp);

  for (const patch of sorted) {
    applyPatch(target, patch, typeMap);
  }

  return target;
}
