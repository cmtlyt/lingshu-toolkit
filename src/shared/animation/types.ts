export type FormatterValue = (value: number) => any;
export type Formatter<T> = (value: T) => any;

export interface AnimationBaseOptions<T> {
  parser?: (value: any) => number;
  formatterValue?: FormatterValue;
  formatter?: Formatter<T>;
}

export interface AnimationOptions<T> extends AnimationBaseOptions<T> {
  autoStart?: boolean;

  easing?: (time: number) => number;

  onStart?: () => void;
  onStop?: () => void;
  onClear?: () => void;

  onUpdate?: (value: any) => void;
  onComplete?: () => void;
}

export interface AnimationCtrl {
  stop: () => void;
  start: () => void;
  clear: () => void;
}

export type AnimationResult = AnimationCtrl & {
  promise: Promise<boolean>;
};
