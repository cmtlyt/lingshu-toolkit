import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { $dt, $t, useValidData } from '../use-valid-data';

interface UseControllableValueOptions<Ks extends PropertyKey = PropertyKey, P extends Ks | (string & {}) = 'value'> {
  defaultValue: any;
  defaultValuePropName: Ks;
  valuePropName: P;
  trigger: Ks;
}

const validInfo = $dt<UseControllableValueOptions>({
  defaultValuePropName: $t.validString('defaultValue'),
  valuePropName: $t.validString('value'),
  trigger: $t.validString('onChange'),
});

export type PublicUseControllableValueOptions<
  Ks extends PropertyKey = PropertyKey,
  P extends Ks | (string & {}) = 'value',
> = Partial<UseControllableValueOptions<Ks, P>>;

type ParseDefaultValue<
  OT extends Record<PropertyKey, any>,
  O extends PublicUseControllableValueOptions,
> = O['defaultValuePropName'] extends keyof OT ? OT[O['defaultValuePropName']] : O['defaultValue'];

type Defaultize<
  OT extends Record<PropertyKey, any>,
  P extends keyof OT | (string & {}),
  O extends PublicUseControllableValueOptions,
> = P extends keyof OT
  ? undefined extends OT[P]
    ? OT[P] & ParseDefaultValue<OT, O>
    : OT[P]
  : ParseDefaultValue<OT, O>;

type ValueType<
  T extends Record<PropertyKey, any>,
  O extends PublicUseControllableValueOptions<PropertyKey, any>,
> = O['valuePropName'] extends keyof T ? Defaultize<T, O['valuePropName'], O> : Defaultize<T, 'value', O>;

/**
 * 受控组件 value 逻辑切换, 如果传递了 value 则走受控逻辑, 否则走非受控逻辑
 */
export function useControllableValue<
  T extends Record<PropertyKey, any>,
  P extends keyof T | (string & {}) = PropertyKey,
  O extends PublicUseControllableValueOptions<keyof T, P> = PublicUseControllableValueOptions<keyof T, P>,
>(props = {} as T, options = {} as O) {
  const {
    defaultValue: _defaultValue,
    trigger,
    valuePropName,
    defaultValuePropName,
  } = useValidData(options as UseControllableValueOptions, validInfo);
  const {
    [valuePropName]: propValue,
    [defaultValuePropName]: defaultValue = _defaultValue,
    [trigger]: emitChange,
  } = props;

  const hasValueRef = useRef(Boolean(Reflect.getOwnPropertyDescriptor(props, valuePropName)));
  const isFirstRenderRef = useRef(true);

  const [ctrlValue, setCtrlValue] = useState(hasValueRef.current ? (propValue as ValueType<T, O>) : defaultValue);

  const setValue = useEffectEvent((value: ValueType<T, O>, ...args: any[]) => {
    if (typeof emitChange === 'function') {
      emitChange(value, ...args);
    }
    if (!hasValueRef.current) {
      setCtrlValue(value);
    }
  });

  useEffect(() => {
    if (isFirstRenderRef.current || !hasValueRef.current) {
      isFirstRenderRef.current = false;
      return;
    }
    setCtrlValue(propValue as ValueType<T, O>);
  }, [propValue]);

  return [ctrlValue, setValue] as [ValueType<T, O>, typeof setValue];
}
