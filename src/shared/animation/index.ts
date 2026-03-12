import { withResolvers } from '@/shared/with-resolvers';
import { type Formatter, getNextValueHandler, identity, matchValid, nextTick, noop } from './utils';

export interface AnimationOptions {
  easing?: (time: number) => number;
  onUpdate?: (value: any) => void;
  onComplete?: () => void;

  parser?: (value: any) => number;
  formatter?: Formatter;
}

export function* stepAnimation<T>(
  from: T,
  to: T,
  step: number,
  options: Omit<AnimationOptions, 'onUpdate' | 'onComplete' | 'easing'> = {},
) {
  const { parser: valueParser = identity, formatter: valueFormatter = identity } = options;
  const [validFrom, validTo] = matchValid(from, to, valueParser);

  const getNextValue = getNextValueHandler(validFrom, validTo, valueFormatter);

  for (let i = 0; i <= step; i++) {
    const value = getNextValue(i / step) as T;
    yield value;
  }
}

export async function animation<T>(from: T, to: T, duration: number, options: AnimationOptions = {}) {
  const [validFrom, validTo] = matchValid(from, to, options.parser || identity);

  const { easing = (time) => time, onUpdate = noop, onComplete = noop, formatter: valueFormatter = identity } = options;
  const getNextValue = getNextValueHandler(validFrom, validTo, valueFormatter);

  const startTime = performance.now();
  const resolvers = withResolvers<void>();

  const tick = () => {
    const elapsed = performance.now() - startTime;
    const progress = easing(Math.min(elapsed / duration, 1));
    const value = getNextValue(progress) as T;
    onUpdate(value);
    if (elapsed < duration) {
      nextTick(tick);
    } else {
      resolvers.resolve();
      onComplete();
    }
  };

  onUpdate(getNextValue(0));
  nextTick(tick);

  return resolvers.promise;
}
