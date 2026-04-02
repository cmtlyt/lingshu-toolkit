import { $dt, $t, dataHandler } from '@/shared/data-handler';
import { throwError } from '@/shared/throw-error';
import { identity, noop } from '@/shared/utils/base';
import type { AnimationBaseOptions, AnimationOptions, AnimationResult } from './types';
import { createNextTick, createRunningControllerSignal, getNextValueHandler, matchValid } from './utils';

const validInfo = $dt({
  autoStart: $t.boolean(true),
  easing: $t.function(() => identity),

  onStart: $t.function(() => noop),
  onStop: $t.function(() => noop),
  onClear: $t.function(() => noop),

  onUpdate: $t.function(() => noop),
  onComplete: $t.function(() => noop),

  formatterValue: $t.function(() => identity),
  formatter: $t.function(() => identity),
  parser: $t.function(() => identity),
});

export function* stepAnimation<T>(from: T, to: T, step: number, options: AnimationBaseOptions<T> = {}) {
  if (!Number.isInteger(step) || step <= 0) {
    throwError('stepAnimation', 'step must be a positive integer', RangeError);
  }

  const validOptions = dataHandler(options, validInfo, { unwrap: true });
  const { parser: valueParser = identity, formatterValue = identity, formatter } = validOptions;
  const [validFrom, validTo] = matchValid(from, to, valueParser);

  const getNextValue = getNextValueHandler(validFrom, validTo, formatterValue);

  for (let i = 0; i <= step; i++) {
    const value = formatter(getNextValue(i / step) as T);
    yield value;
  }
}

export function animation<T>(from: T, to: T, duration: number, options: AnimationOptions<T> = {}): AnimationResult {
  if (duration <= 0 || !Number.isInteger(duration)) {
    throwError('animation', 'duration must be a positive integer', RangeError);
  }

  const validOptions = dataHandler(options, validInfo, { unwrap: true });
  const [validFrom, validTo] = matchValid(from, to, validOptions.parser);

  const { autoStart, easing, onComplete, onUpdate, formatterValue, formatter } = validOptions;
  const _getNextValue = getNextValueHandler(validFrom, validTo, formatterValue);
  const getNextValue = (...args: Parameters<typeof _getNextValue>) => formatter(_getNextValue(...args) as T);

  let startTime = 0;
  let hasStarted = false;
  const rcSignal = createRunningControllerSignal(() => {
    const now = performance.now();
    startTime += now;
    const stopFlag = nextTick(tick);
    if (stopFlag) {
      startTime -= performance.now();
      return;
    }
    if (!hasStarted) {
      // 第一次启动：触发原始值并开始动画
      onUpdate(getNextValue(0) as T);
      hasStarted = true;
    }
  }, validOptions);
  const { resolvers } = rcSignal;
  const nextTick = createNextTick(resolvers, rcSignal);

  const tick = () => {
    const elapsed = performance.now() - startTime;
    const progress = easing(Math.min(elapsed / duration, 1));
    const value = getNextValue(progress) as T;
    onUpdate(value);
    if (elapsed < duration) {
      const stopFlag = nextTick(tick);
      if (stopFlag) {
        startTime = -elapsed;
      }
    } else {
      onComplete();
      resolvers.resolve(false);
    }
  };

  if (autoStart !== false) {
    rcSignal.start();
  }

  return {
    promise: resolvers.promise,
    stop: rcSignal.stop,
    start: rcSignal.start,
    clear: rcSignal.clear,
  };
}
