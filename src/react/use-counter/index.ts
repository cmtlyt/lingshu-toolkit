import { useEffectEvent, useMemo, useRef, useState } from 'react';
import { $dt, $t, useValidData } from '@/react/use-valid-data';
import { logger } from '@/shared/logger';

interface UseCounterOptions {
  min: number;
  max: number;
  step: number;
}

function getRealValue(value: number, options: UseCounterOptions) {
  const { min, max } = options;
  return Math.min(Math.max(value, min), max);
}

function nanTransform(_dv: number) {
  return (_v: unknown) => {
    if (typeof _v === 'undefined') {
      return _dv;
    }
    logger.warn('useCounter', 'value is not a number', _v, 'useCounter will use default value');
    const numV = Number(_v);
    if (Number.isNaN(numV)) {
      return _dv;
    }
    return numV;
  };
}

const validInfo = $dt({
  min: $t.validNumber(nanTransform(Number.NEGATIVE_INFINITY)),
  max: $t.validNumber(nanTransform(Number.POSITIVE_INFINITY)),
  step: $t.validNumber(nanTransform(1)),
});

export function useCounter(initialValue = 0, options: Partial<UseCounterOptions> = {}) {
  const validOptions = useValidData(options, validInfo);
  const { step } = validOptions;

  const initialValueRef = useRef(getRealValue(Number(initialValue), validOptions));
  const [current, setCurrent] = useState(getRealValue(Number(initialValue), validOptions));

  const setValue = useEffectEvent((value: number | ((prev: number) => number)) => {
    setCurrent(() => getRealValue(typeof value === 'function' ? value(current) : value, validOptions));
  });

  const actions = useMemo(() => {
    const _step = Math.abs(step);

    const increment = (delta = _step) => setValue((prev) => prev + delta);
    const decrement = (delta = _step) => setValue((prev) => prev - delta);
    const reset = () => setCurrent(initialValueRef.current);

    return { increment, decrement, reset, set: setValue };
  }, [step]);

  return [current, actions] as const;
}
