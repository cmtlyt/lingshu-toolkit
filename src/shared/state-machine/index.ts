import { throwError } from '@/shared/throw-error';

const FN_NAME = 'createStateMachine';

// ============================================================
// Type Definitions
// ============================================================

interface EventPayload {
  type: string;
  [key: string]: unknown;
}

interface StateMachineSettings {
  /** @default 100 */
  maxQueueSize?: number;
  /** @default 10 */
  maxCyclicCount?: number;
}

type GuardFn<TContext, TAsync extends boolean = false> = TAsync extends true
  ? (context: Readonly<TContext>, event: EventPayload) => boolean | Promise<boolean>
  : (context: Readonly<TContext>, event: EventPayload) => boolean;

type ActionFn<TContext, TAsync extends boolean = false> = TAsync extends true
  ? (context: TContext, event: EventPayload) => void | Promise<void>
  : (context: TContext, event: EventPayload) => void;

type ActionRef<TContext, TAsync extends boolean = false> = string | ActionFn<TContext, TAsync>;

interface TransitionConfig<
  TStates extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean = false,
> {
  target?: NoInfer<TStates>;
  guard?: string | GuardFn<TContext, TAsync>;
  action?: ActionRef<TContext, TAsync> | ActionRef<TContext, TAsync>[];
}

interface StateNode<
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

interface StateMachineConfig<
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

interface StateChangeEvent<TStates extends string, TContext extends Record<string, unknown>> {
  from: TStates;
  to: TStates;
  event: EventPayload;
  context: Readonly<TContext>;
}

type StateMachineListener<TStates extends string, TContext extends Record<string, unknown>> = (
  event: StateChangeEvent<TStates, TContext>,
) => void;

interface StateMachine<
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

// ============================================================
// Implementation Helpers (extracted to reduce complexity)
// ============================================================

interface InternalState<TStates extends string, TContext extends Record<string, unknown>> {
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

interface Registries<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>> {
  states: Record<TStates, StateNode<TStates, TEvents, TContext, boolean>>;
  guards: Record<string, GuardFn<TContext, boolean>>;
  actions: Record<string, ActionFn<TContext, boolean>>;
  onUnhandledEvent: ((state: TStates, eventType: string, context: TContext) => void) | undefined;
}

function resolveActionRefs<TContext extends Record<string, unknown>>(
  refs: ActionRef<TContext, boolean> | ActionRef<TContext, boolean>[] | undefined,
  actionRegistry: Record<string, ActionFn<TContext, boolean>>,
): ActionFn<TContext, boolean>[] {
  if (refs === undefined) {
    return [];
  }
  const refArray = Array.isArray(refs) ? refs : [refs];
  return refArray.map((ref) => {
    if (typeof ref === 'function') {
      return ref;
    }
    const action = actionRegistry[ref];
    if (!action) {
      throwError(FN_NAME, `Action "${ref}" is not registered in the actions registry`);
    }
    return action;
  });
}

function resolveGuard<TContext extends Record<string, unknown>>(
  guard: string | GuardFn<TContext, boolean> | undefined,
  guardRegistry: Record<string, GuardFn<TContext, boolean>>,
): GuardFn<TContext, boolean> | undefined {
  if (guard === undefined) {
    return;
  }
  if (typeof guard === 'function') {
    return guard;
  }
  const resolved = guardRegistry[guard];
  if (!resolved) {
    throwError(FN_NAME, `Guard "${guard}" is not registered in the guards registry`);
  }
  return resolved;
}

function checkCyclic<TStates extends string, TContext extends Record<string, unknown>>(
  event: EventPayload,
  internal: InternalState<TStates, TContext>,
  maxCyclicCount: number,
): void {
  if (event.type === internal.lastEventType && internal.currentState === internal.lastState) {
    internal.cyclicCounter++;
    if (internal.cyclicCounter >= maxCyclicCount) {
      throwError(
        FN_NAME,
        `Cyclic event detected: event "${event.type}" triggered ${internal.cyclicCounter} times consecutively in state "${internal.currentState}"`,
      );
    }
  } else {
    internal.lastEventType = event.type;
    internal.lastState = internal.currentState;
    internal.cyclicCounter = 1;
  }
}

function notifyListeners<TStates extends string, TContext extends Record<string, unknown>>(
  from: TStates,
  to: TStates,
  event: EventPayload,
  internal: InternalState<TStates, TContext>,
): void {
  const changeEvent: StateChangeEvent<TStates, TContext> = {
    from,
    to,
    event,
    context: { ...internal.context },
  };
  for (const listener of internal.listeners) {
    listener(changeEvent);
  }
}

function runActionsSync<TContext extends Record<string, unknown>>(
  actions: ActionFn<TContext, boolean>[],
  context: TContext,
  event: EventPayload,
): void {
  for (const action of actions) {
    action(context, event);
  }
}

async function runActionsAsync<TContext extends Record<string, unknown>>(
  actions: ActionFn<TContext, boolean>[],
  context: TContext,
  event: EventPayload,
): Promise<void> {
  for (const action of actions) {
    // biome-ignore lint/performance/noAwaitInLoops: actions must execute serially by design
    await action(context, event);
  }
}

function executeTransitionSync<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
>(
  event: EventPayload,
  candidate: TransitionConfig<TStates, TContext, boolean>,
  stateNode: StateNode<TStates, TEvents, TContext, boolean>,
  internal: InternalState<TStates, TContext>,
  reg: Registries<TStates, TEvents, TContext>,
): void {
  const previousState = internal.currentState;
  const targetState = (candidate.target ?? internal.currentState) as TStates;

  if (!(targetState in reg.states)) {
    throwError(FN_NAME, `Target state "${targetState}" is not defined in states`);
  }

  runActionsSync(resolveActionRefs(stateNode.onExit, reg.actions), internal.context, event);
  runActionsSync(resolveActionRefs(candidate.action, reg.actions), internal.context, event);
  internal.currentState = targetState;
  runActionsSync(resolveActionRefs(reg.states[targetState].onEntry, reg.actions), internal.context, event);
  notifyListeners(previousState, targetState, event, internal);
}

async function executeTransitionAsync<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
>(
  event: EventPayload,
  candidate: TransitionConfig<TStates, TContext, boolean>,
  stateNode: StateNode<TStates, TEvents, TContext, boolean>,
  internal: InternalState<TStates, TContext>,
  reg: Registries<TStates, TEvents, TContext>,
): Promise<void> {
  const previousState = internal.currentState;
  const targetState = (candidate.target ?? internal.currentState) as TStates;

  if (!(targetState in reg.states)) {
    throwError(FN_NAME, `Target state "${targetState}" is not defined in states`);
  }

  await runActionsAsync(resolveActionRefs(stateNode.onExit, reg.actions), internal.context, event);
  await runActionsAsync(resolveActionRefs(candidate.action, reg.actions), internal.context, event);
  internal.currentState = targetState;
  await runActionsAsync(resolveActionRefs(reg.states[targetState].onEntry, reg.actions), internal.context, event);
  notifyListeners(previousState, targetState, event, internal);
}

function getCandidates<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>>(
  event: EventPayload,
  stateNode: StateNode<TStates, TEvents, TContext, boolean>,
): TransitionConfig<TStates, TContext, boolean>[] | undefined {
  const transitionDef = stateNode.on?.[event.type as TEvents];
  if (transitionDef === undefined) {
    return;
  }
  return Array.isArray(transitionDef) ? transitionDef : [transitionDef];
}

function processEventSync<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>>(
  event: EventPayload,
  internal: InternalState<TStates, TContext>,
  reg: Registries<TStates, TEvents, TContext>,
): boolean {
  const stateNode = reg.states[internal.currentState] as StateNode<TStates, TEvents, TContext, boolean>;
  if (stateNode.final) {
    return false;
  }

  const candidates = getCandidates(event, stateNode);
  if (!candidates) {
    reg.onUnhandledEvent?.(internal.currentState, event.type, internal.context);
    return false;
  }

  for (const candidate of candidates) {
    const guardFn = resolveGuard(candidate.guard, reg.guards);
    if (guardFn && !guardFn(internal.context, event)) {
      continue;
    }
    executeTransitionSync(event, candidate, stateNode, internal, reg);
    return true;
  }

  reg.onUnhandledEvent?.(internal.currentState, event.type, internal.context);
  return false;
}

async function processEventAsync<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
>(
  event: EventPayload,
  internal: InternalState<TStates, TContext>,
  reg: Registries<TStates, TEvents, TContext>,
): Promise<boolean> {
  const stateNode = reg.states[internal.currentState] as StateNode<TStates, TEvents, TContext, boolean>;
  if (stateNode.final) {
    return false;
  }

  const candidates = getCandidates(event, stateNode);
  if (!candidates) {
    reg.onUnhandledEvent?.(internal.currentState, event.type, internal.context);
    return false;
  }

  for (const candidate of candidates) {
    const guardFn = resolveGuard(candidate.guard, reg.guards);
    if (guardFn) {
      // biome-ignore lint/performance/noAwaitInLoops: guard evaluation must be serial to match first passing candidate
      const guardResult = await guardFn(internal.context, event);
      if (!guardResult) {
        continue;
      }
    }
    await executeTransitionAsync(event, candidate, stateNode, internal, reg);
    return true;
  }

  reg.onUnhandledEvent?.(internal.currentState, event.type, internal.context);
  return false;
}

function enqueueOrWarn<TStates extends string, TContext extends Record<string, unknown>>(
  event: EventPayload,
  internal: InternalState<TStates, TContext>,
  maxQueueSize: number,
): boolean {
  if (internal.eventQueue.length >= maxQueueSize) {
    console.warn(
      `[@cmtlyt/lingshu-toolkit#${FN_NAME}]: Event queue overflow (max: ${maxQueueSize}), event "${event.type}" dropped`,
    );
    return false;
  }
  internal.eventQueue.push(event);
  return true;
}

// ============================================================
// Queue Draining
// ============================================================

function drainSyncQueue<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>>(
  internal: InternalState<TStates, TContext>,
  reg: Registries<TStates, TEvents, TContext>,
  maxCyclicCount: number,
): void {
  while (internal.eventQueue.length > 0) {
    const queuedEvent = internal.eventQueue.shift()!;
    checkCyclic(queuedEvent, internal, maxCyclicCount);
    processEventSync(queuedEvent, internal, reg);
  }
}

async function drainAsyncQueue<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
>(
  event: EventPayload,
  internal: InternalState<TStates, TContext>,
  reg: Registries<TStates, TEvents, TContext>,
  maxCyclicCount: number,
): Promise<boolean> {
  try {
    checkCyclic(event, internal, maxCyclicCount);
    const result = await processEventAsync(event, internal, reg);
    while (internal.eventQueue.length > 0) {
      const queuedEvent = internal.eventQueue.shift()!;
      checkCyclic(queuedEvent, internal, maxCyclicCount);
      // biome-ignore lint/performance/noAwaitInLoops: queue must drain serially
      await processEventAsync(queuedEvent, internal, reg);
    }
    return result;
  } finally {
    internal.processing = false;
  }
}

// ============================================================
// Machine API Builder
// ============================================================

function buildMachineApi<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean,
>(
  internal: InternalState<TStates, TContext>,
  reg: Registries<TStates, TEvents, TContext>,
  isAsync: boolean,
  triggerSync: (event: EventPayload) => boolean,
  triggerAsync: (event: EventPayload) => Promise<boolean>,
): StateMachine<TStates, TEvents, TContext, TAsync> {
  return {
    trigger(event: EventPayload) {
      return (isAsync ? triggerAsync(event) : triggerSync(event)) as TAsync extends true ? Promise<boolean> : boolean;
    },
    getState: () => internal.currentState,
    getContext: () => {
      return { ...internal.context };
    },
    matches: (state: TStates) => internal.currentState === state,
    getAvailableEvents() {
      const stateNode = reg.states[internal.currentState];
      return stateNode.on ? (Object.keys(stateNode.on) as TEvents[]) : [];
    },
    subscribe(listener: StateMachineListener<TStates, TContext>) {
      internal.listeners.add(listener);
      return () => {
        internal.listeners.delete(listener);
      };
    },
    dispose() {
      internal.disposed = true;
      internal.eventQueue.length = 0;
      internal.listeners.clear();
    },
  };
}

// ============================================================
// Factory
// ============================================================

function createStateMachine<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
  TAsync extends boolean = false,
>(config: StateMachineConfig<TStates, TEvents, TContext, TAsync>): StateMachine<TStates, TEvents, TContext, TAsync> {
  const { initial, states, guards: guardRegistry = {}, actions: actionRegistry = {}, settings = {} } = config;
  const isAsync = config.async === true;

  if (!(initial in states)) {
    throwError(FN_NAME, `Initial state "${initial}" is not defined in states`);
  }

  const maxQueueSize = settings.maxQueueSize ?? 100;
  const maxCyclicCount = settings.maxCyclicCount ?? 10;

  const internal: InternalState<TStates, TContext> = {
    currentState: initial,
    context: { ...config.context },
    disposed: false,
    processing: false,
    eventQueue: [],
    listeners: new Set(),
    lastEventType: null,
    lastState: null,
    cyclicCounter: 0,
  };

  const reg: Registries<TStates, TEvents, TContext> = {
    guards: guardRegistry as Record<string, GuardFn<TContext, boolean>>,
    actions: actionRegistry as Record<string, ActionFn<TContext, boolean>>,
    states: states as Record<TStates, StateNode<TStates, TEvents, TContext, boolean>>,
    onUnhandledEvent: config.onUnhandledEvent,
  };

  // Execute onEntry for initial state
  const initEntryActions = resolveActionRefs(reg.states[initial].onEntry, reg.actions);
  if (initEntryActions.length > 0) {
    const initEvent: EventPayload = { type: '__init__' };
    if (isAsync) {
      void runActionsAsync(initEntryActions, internal.context, initEvent);
    } else {
      runActionsSync(initEntryActions, internal.context, initEvent);
    }
  }

  function assertNotDisposed(): void {
    if (internal.disposed) {
      throwError(FN_NAME, 'Cannot trigger events on a disposed state machine');
    }
  }

  function triggerSync(event: EventPayload): boolean {
    assertNotDisposed();
    if (internal.processing) {
      return enqueueOrWarn(event, internal, maxQueueSize);
    }
    internal.processing = true;
    try {
      checkCyclic(event, internal, maxCyclicCount);
      const result = processEventSync(event, internal, reg);
      drainSyncQueue(internal, reg, maxCyclicCount);
      return result;
    } finally {
      internal.processing = false;
    }
  }

  function triggerAsync(event: EventPayload): Promise<boolean> {
    assertNotDisposed();
    if (internal.processing) {
      return Promise.resolve(enqueueOrWarn(event, internal, maxQueueSize));
    }
    internal.processing = true;
    return drainAsyncQueue(event, internal, reg, maxCyclicCount);
  }

  return buildMachineApi(internal, reg, isAsync, triggerSync, triggerAsync);
}

export type {
  ActionFn,
  ActionRef,
  EventPayload,
  GuardFn,
  StateChangeEvent,
  StateMachine,
  StateMachineConfig,
  StateMachineListener,
  StateMachineSettings,
  StateNode,
  TransitionConfig,
};
export { createStateMachine };
