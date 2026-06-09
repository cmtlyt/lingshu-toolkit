export interface EventPayload {
  type: string;
  [key: string]: unknown;
}

export interface StateMachineSettings {
  /** @default 100 */
  maxQueueSize?: number;
  /** @default 10 */
  maxCyclicCount?: number;
}

export type GuardFn<TContext, TAsync extends boolean = false> = TAsync extends true
  ? (context: Readonly<TContext>, event: EventPayload) => boolean | Promise<boolean>
  : (context: Readonly<TContext>, event: EventPayload) => boolean;

export type ActionFn<TContext, TAsync extends boolean = false> = TAsync extends true
  ? (context: TContext, event: EventPayload) => void | Promise<void>
  : (context: TContext, event: EventPayload) => void;

export type ActionRef<TContext, TAsync extends boolean = false> = string | ActionFn<TContext, TAsync>;

export interface TransitionConfig<
  TStates extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean = false,
> {
  target?: NoInfer<TStates>;
  guard?: string | GuardFn<TContext, TAsync>;
  action?: ActionRef<TContext, TAsync> | ActionRef<TContext, TAsync>[];
}

export interface StateNode<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean = false,
> {
  on?: Partial<
    Record<TEvents, TransitionConfig<TStates, TContext, TAsync> | TransitionConfig<TStates, TContext, TAsync>[]>
  >;
  onEntry?: ActionRef<TContext, TAsync> | ActionRef<TContext, TAsync>[];
  onExit?: ActionRef<TContext, TAsync> | ActionRef<TContext, TAsync>[];
  final?: boolean;
}

export interface StateMachineConfig<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean = false,
> {
  initial: NoInfer<TStates>;
  context: TContext;
  async?: TAsync;
  states: Record<TStates, StateNode<TStates, TEvents, TContext, TAsync>>;
  guards?: Record<string, GuardFn<TContext, TAsync>>;
  actions?: Record<string, ActionFn<TContext, TAsync>>;
  onUnhandledEvent?: (state: TStates, eventType: string, context: TContext) => void;
  settings?: StateMachineSettings;
}

export interface StateChangeEvent<TStates extends string, TContext extends Record<string, unknown>> {
  from: TStates;
  to: TStates;
  event: EventPayload;
  context: Readonly<TContext>;
}

export type StateMachineListener<TStates extends string, TContext extends Record<string, unknown>> = (
  event: StateChangeEvent<TStates, TContext>,
) => void;

export interface StateMachine<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean = false,
> {
  trigger: (event: EventPayload) => TAsync extends true ? Promise<boolean> : boolean;
  getState: () => TStates;
  getContext: () => Readonly<TContext>;
  matches: (state: TStates) => boolean;
  getAvailableEvents: () => TEvents[];
  subscribe: (listener: StateMachineListener<TStates, TContext>) => () => void;
  dispose: () => void;
}

// Internal types (not re-exported from index.ts)

export interface InternalState<TStates extends string, TContext extends Record<string, unknown>> {
  currentState: TStates;
  context: TContext;
  disposed: boolean;
  processing: boolean;
  eventQueue: EventPayload[];
  listeners: Set<StateMachineListener<TStates, TContext>>;
  lastEventType: string | null;
  lastState: TStates | null;
  cyclicCounter: number;
}

export interface Registries<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>> {
  states: Record<TStates, StateNode<TStates, TEvents, TContext, boolean>>;
  guards: Record<string, GuardFn<TContext, boolean>>;
  actions: Record<string, ActionFn<TContext, boolean>>;
  onUnhandledEvent: ((state: TStates, eventType: string, context: TContext) => void) | undefined;
}
