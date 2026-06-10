import { throwError } from '@/shared/throw-error';

// ─── Types ───────────────────────────────────────────────

type PatchOp = 'set' | 'delete' | 'splice';

interface Patch {
  path: (string | number)[];
  op: PatchOp;
  value?: unknown;
  index?: number;
  deleteCount?: number;
  items?: unknown[];
  type?: string;
  timestamp: number;
}

interface CustomTypeConfig<T = unknown> {
  type: string;
  is: (value: unknown) => value is T;
  serialize: (value: T) => unknown;
  deserialize: (raw: unknown) => T;
}

interface TrackerOptions {
  types?: CustomTypeConfig<any>[];
}

interface ReplayOptions extends TrackerOptions {
  mutate?: boolean;
}

interface RecorderInstance<T extends object> {
  proxy: T;
  flush: () => Patch[];
  dispose: () => void;
}

// ─── Internal Helpers ────────────────────────────────────

type PatchEmitter = (patch: Patch) => void;

const ARRAY_MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice'] as const;

function serializeValue(
  value: unknown,
  types: CustomTypeConfig<any>[] | undefined,
): { serialized: unknown; typeName?: string } {
  if (!types) {
    return { serialized: value };
  }
  for (const config of types) {
    if (config.is(value)) {
      return { serialized: config.serialize(value as never), typeName: config.type };
    }
  }
  return { serialized: value };
}

function serializeItems(
  items: unknown[],
  types: CustomTypeConfig<any>[] | undefined,
): { serializedItems: unknown[]; itemTypeName?: string } {
  if (!types) {
    return { serializedItems: items };
  }
  let detectedType: string | undefined;
  const serializedItems = items.map((item) => {
    const { serialized, typeName } = serializeValue(item, types);
    if (typeName && !detectedType) {
      detectedType = typeName;
    }
    return serialized;
  });
  return { serializedItems, itemTypeName: detectedType };
}

function isProxyable(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function deepClone<T>(value: T): T {
  if (!isProxyable(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = deepClone((value as Record<string, unknown>)[key]);
  }
  return result as T;
}

// ─── Proxy Engine ────────────────────────────────────────

function createDeepProxy<T extends object>(
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

// ─── API: recordTransaction ──────────────────────────────

function recordTransaction<T extends object>(
  baseObject: T,
  changeFn: (draft: T) => void,
  options?: TrackerOptions,
): Patch[] {
  const draft = deepClone(baseObject);
  const patches: Patch[] = [];
  const emit: PatchEmitter = (patch) => patches.push(patch);
  const proxy = createDeepProxy(draft, [], emit, options?.types);

  changeFn(proxy);

  return patches;
}

// ─── API: createRecorder ─────────────────────────────────

function createRecorder<T extends object>(baseObject: T, options?: TrackerOptions): RecorderInstance<T> {
  let disposed = false;
  let patches: Patch[] = [];

  // Emit callback always pushes to the current `patches` reference
  const emit: PatchEmitter = (patch) => patches.push(patch);
  const proxy = createDeepProxy(baseObject, [], emit, options?.types);

  const guardedProxy = new Proxy(proxy, {
    get(target, prop, receiver) {
      if (disposed && prop !== 'toString' && prop !== 'valueOf' && prop !== Symbol.toPrimitive) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot access proxy after dispose().');
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (disposed) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot modify proxy after dispose().');
      }
      return Reflect.set(target, prop, value);
    },
    deleteProperty(target, prop) {
      if (disposed) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot modify proxy after dispose().');
      }
      return Reflect.deleteProperty(target, prop);
    },
  });

  return {
    proxy: guardedProxy,
    flush(): Patch[] {
      if (disposed) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot flush after dispose().');
      }
      const flushed = patches;
      patches = [];
      return flushed;
    },
    dispose(): void {
      disposed = true;
      patches = [];
    },
  };
}

// ─── API: replay ─────────────────────────────────────────

function replay<T extends object>(baseObject: T, patchList: Patch[], options?: ReplayOptions): T {
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

// ─── Exports ─────────────────────────────────────────────

export type { CustomTypeConfig, Patch, RecorderInstance, ReplayOptions, TrackerOptions };
export { createRecorder, recordTransaction, replay };
