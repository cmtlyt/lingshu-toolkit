import type { CustomTypeConfig } from './types';

export function serializeValue(
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

export function serializeItems(
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

export function isProxyable(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

export function deepClone<T>(value: T): T {
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
