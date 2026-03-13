import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// 单选模式配置
interface SingleModeOptions<T> {
  mode: 'single';
  defaultValue?: T;
  value?: T;
  onChange?: (value: T | undefined) => void;
}

// 多选模式配置
interface MultipleModeOptions<T> {
  mode: 'multiple';
  defaultValue?: T[];
  value?: T[];
  onChange?: (value: T[]) => void;
}

export type UseSelectButtonGroupOptions<T> = SingleModeOptions<T> | MultipleModeOptions<T>;

// 单选模式 actions
interface SingleActions<T> {
  select: (value: T) => void;
  clear: () => void;
  isSelected: (value: T) => boolean;
}

// 多选模式 actions
interface MultipleActions<T> {
  select: (value: T) => void;
  deselect: (value: T) => void;
  toggle: (value: T) => void;
  clear: () => void;
  selectAll: (values: T[]) => void;
  isSelected: (value: T) => boolean;
}

// 单选模式重载
export function useSelectButtonGroup<T>(options: SingleModeOptions<T>): [T | undefined, SingleActions<T>];

// 多选模式重载
export function useSelectButtonGroup<T>(options: MultipleModeOptions<T>): [T[], MultipleActions<T>];

// 实现
export function useSelectButtonGroup<T>(options: UseSelectButtonGroupOptions<T>) {
  const { mode } = options;
  const isSingleMode = mode === 'single';

  // 单选模式的初始值
  const singleDefaultValue = isSingleMode ? (options as SingleModeOptions<T>).defaultValue : undefined;
  const singleControlledValue = isSingleMode ? (options as SingleModeOptions<T>).value : undefined;
  const singleOnChange = isSingleMode ? (options as SingleModeOptions<T>).onChange : undefined;

  // 多选模式的初始值
  const multiDefaultValue = isSingleMode ? [] : ((options as MultipleModeOptions<T>).defaultValue ?? []);
  const multiControlledValue = isSingleMode ? undefined : (options as MultipleModeOptions<T>).value;
  const multiOnChange = isSingleMode ? undefined : (options as MultipleModeOptions<T>).onChange;

  // 单选状态
  const [singleInternalValue, setSingleInternalValue] = useState<T | undefined>(singleDefaultValue);
  const singleIsControlled = singleControlledValue !== undefined;
  const singleCurrentValue = singleIsControlled ? singleControlledValue : singleInternalValue;

  // 多选状态
  const [multiInternalValue, setMultiInternalValue] = useState<T[]>(multiDefaultValue);
  const multiIsControlled = multiControlledValue !== undefined;
  const multiCurrentValue = multiIsControlled ? multiControlledValue : multiInternalValue;

  // 同步单选受控值
  const singleIsFirstRender = useRef(true);
  useEffect(() => {
    if (!isSingleMode) {
      return;
    }
    if (singleIsFirstRender.current) {
      singleIsFirstRender.current = false;
      return;
    }
    if (singleIsControlled) {
      setSingleInternalValue(singleControlledValue);
    }
  }, [isSingleMode, singleControlledValue, singleIsControlled]);

  // 同步多选受控值
  const multiIsFirstRender = useRef(true);
  useEffect(() => {
    if (isSingleMode) {
      return;
    }
    if (multiIsFirstRender.current) {
      multiIsFirstRender.current = false;
      return;
    }
    if (multiIsControlled) {
      setMultiInternalValue(multiControlledValue);
    }
  }, [isSingleMode, multiControlledValue, multiIsControlled]);

  // 单选 setValue
  const setSingleValue = useCallback(
    (newValue: T | undefined) => {
      if (!singleIsControlled) {
        setSingleInternalValue(newValue);
      }
      singleOnChange?.(newValue);
    },
    [singleIsControlled, singleOnChange],
  );

  // 多选 setValue
  const setMultiValue = useCallback(
    (newValue: T[]) => {
      if (!multiIsControlled) {
        setMultiInternalValue(newValue);
      }
      multiOnChange?.(newValue);
    },
    [multiIsControlled, multiOnChange],
  );

  // 单选 actions
  const singleActions = useMemo<SingleActions<T>>(() => {
    return {
      select: (newValue: T) => setSingleValue(newValue),
      clear: () => setSingleValue(undefined),
      isSelected: (checkValue: T) => singleCurrentValue === checkValue,
    };
  }, [singleCurrentValue, setSingleValue]);

  // 多选 actions
  const multiActions = useMemo<MultipleActions<T>>(() => {
    return {
      select: (newValue: T) => {
        if (!multiCurrentValue.includes(newValue)) {
          setMultiValue([...multiCurrentValue, newValue]);
        }
      },
      deselect: (removeValue: T) => {
        setMultiValue(multiCurrentValue.filter((val) => val !== removeValue));
      },
      toggle: (toggleValue: T) => {
        if (multiCurrentValue.includes(toggleValue)) {
          setMultiValue(multiCurrentValue.filter((val) => val !== toggleValue));
        } else {
          setMultiValue([...multiCurrentValue, toggleValue]);
        }
      },
      clear: () => setMultiValue([]),
      selectAll: (values: T[]) => setMultiValue(values),
      isSelected: (checkValue: T) => multiCurrentValue.includes(checkValue),
    };
  }, [multiCurrentValue, setMultiValue]);

  // 根据模式返回对应的值和 actions
  if (isSingleMode) {
    return [singleCurrentValue, singleActions] as [T | undefined, SingleActions<T>];
  }
  return [multiCurrentValue, multiActions] as [T[], MultipleActions<T>];
}
