import { throwType } from '@/shared/throw-error';
import type { IsPrimitive, Printify, UnionToIntersection } from '@/shared/types';

type AssertValue = Record<PropertyKey, any> | any[];

type ConditionArrayItem = [boolean, AssertValue, AssertValue?];

type ConditionObjItem = { condition: boolean; value: AssertValue; fullback?: AssertValue };

type ConditionItem = ConditionObjItem | ConditionArrayItem;

type GetDefaultValue<V> = IsPrimitive<V> extends true ? never : Record<never, any>;

type ParseDefaultValue<V, D> = FormatValue<
  unknown extends D ? (V extends any[] ? [] : GetDefaultValue<V>) : D extends undefined | null ? GetDefaultValue<V> : D
>;

type ParseArrayCondition<T extends [any, any, any?]> = T extends [infer Flag, infer Value, (infer DefaultValue)?]
  ? boolean extends Flag
    ? FormatValue<Value> | ParseDefaultValue<Value, DefaultValue>
    : Flag extends true
      ? FormatValue<Value> & Record<PropertyKey, any>
      : ParseDefaultValue<Value, DefaultValue> & Record<PropertyKey, any>
  : never;

type ParseObjCondition<T extends ConditionObjItem> = T extends {
  condition: infer Flag extends boolean;
  value: infer Value;
  fullback?: infer DefaultValue;
}
  ? ParseArrayCondition<[Flag, Value, DefaultValue]>
  : never;

type FormatValue<V> = [V] extends [never]
  ? never
  : V extends any[]
    ? V
    : { [K in keyof V as V[K] extends undefined ? never : K]: V[K] };

type BuildConditionValue<T> = [T];

type ParseConditionValue<T extends ConditionItem> = UnionToIntersection<
  T extends infer IT
    ? BuildConditionValue<
        Printify<
          IT extends ConditionArrayItem
            ? ParseArrayCondition<IT>
            : IT extends ConditionObjItem
              ? ParseObjCondition<IT>
              : never
        >
      >
    : never
>;

type MergedResult<T extends ConditionItem[]> = T extends [
  infer First extends ConditionItem,
  ...infer Last extends [ConditionItem, ...ConditionItem[]],
]
  ? ParseConditionValue<First> & MergedResult<Last>
  : ParseConditionValue<T[0]>;

type CMInput = ConditionItem[];

type FormatResult<T extends any[]> = T[0] & Record<PropertyKey, any>;

function getEmpty(_v: unknown) {
  return Array.isArray(_v) ? [] : {};
}

function valueCheck(_v: unknown) {
  return Array.isArray(_v) || typeof _v === 'object';
}

export function conditionMerge<T extends CMInput>(...input: T): FormatResult<MergedResult<T>>;
export function conditionMerge<T extends CMInput>(input: T): FormatResult<MergedResult<T>>;
export function conditionMerge(...input: any) {
  const conditionItems: ConditionObjItem[] = (input.length > 1 ? input : input[0]).map((item: ConditionItem) => {
    let result: ConditionObjItem | null = null;
    // 处理数组方式
    if (Array.isArray(item)) {
      const [condition, value, fullback] = item;
      result = { condition, value, fullback };
    }
    // 处理对象方式
    else if (Object.getOwnPropertyDescriptor(item, 'condition')) {
      result = item;
    }
    // 其余类型直接报错
    else {
      throwType('conditionMerge', 'input must be an ConditionItem');
    }
    // 校验 value 和 fullback 是否合法
    const validValue = valueCheck(result.value);
    const validFullback = typeof result.fullback === 'undefined' || valueCheck(result.fullback);
    if (!(validValue && validFullback)) {
      throwType('conditionMerge', 'value and fullback must be an array or object');
    }
    return result;
  });

  const result = getEmpty(conditionItems[0].value);
  const mergeFn = Array.isArray(result)
    ? (a1: any[], a2: any[]) => Reflect.apply(Array.prototype.splice.bind(a1, a1.length, 0), null, a2)
    : Object.assign;

  for (let i = 0, item = conditionItems[i]; i < conditionItems.length; item = conditionItems[++i]) {
    mergeFn(result, item.condition ? item.value : item.fullback || getEmpty(item.value));
  }

  return result;
}
