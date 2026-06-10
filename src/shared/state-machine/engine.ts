import { throwError } from '@/shared/throw-error';
import {
  checkCyclic,
  FN_NAME,
  getCandidates,
  notifyListeners,
  resolveActionRefs,
  resolveGuard,
  runActionsAsync,
  runActionsSync,
} from './helpers';
import type {
  EventPayload,
  InternalState,
  Registries,
  StateMachine,
  StateMachineListener,
  StateNode,
  TransitionConfig,
} from './types';

export function executeTransitionSync<
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

export async function executeTransitionAsync<
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

export function processEventSync<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
>(
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

export async function processEventAsync<
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

export function drainSyncQueue<
  TStates extends string,
  TEvents extends string,
  TContext extends Record<string, unknown>,
>(
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

export async function drainAsyncQueue<
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

export function buildMachineApi<
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
