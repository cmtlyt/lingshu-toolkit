import { throwError } from '@/shared/throw-error';
import type {
  ActionFn,
  ActionRef,
  EventPayload,
  GuardFn,
  InternalState,
  StateChangeEvent,
  StateNode,
  TransitionConfig,
} from './types';

export const FN_NAME = 'createStateMachine';

export function resolveActionRefs<TContext extends Record<string, unknown>>(
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

export function resolveGuard<TContext extends Record<string, unknown>>(
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

export function getCandidates<TStates extends string, TEvents extends string, TContext extends Record<string, unknown>>(
  event: EventPayload,
  stateNode: StateNode<TStates, TEvents, TContext, boolean>,
): TransitionConfig<TStates, TContext, boolean>[] | undefined {
  const transitionDef = stateNode.on?.[event.type as TEvents];
  if (transitionDef === undefined) {
    return;
  }
  return Array.isArray(transitionDef) ? transitionDef : [transitionDef];
}

export function checkCyclic<TStates extends string, TContext extends Record<string, unknown>>(
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

export function notifyListeners<TStates extends string, TContext extends Record<string, unknown>>(
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

export function runActionsSync<TContext extends Record<string, unknown>>(
  actions: ActionFn<TContext, boolean>[],
  context: TContext,
  event: EventPayload,
): void {
  for (const action of actions) {
    action(context, event);
  }
}

export async function runActionsAsync<TContext extends Record<string, unknown>>(
  actions: ActionFn<TContext, boolean>[],
  context: TContext,
  event: EventPayload,
): Promise<void> {
  for (const action of actions) {
    // biome-ignore lint/performance/noAwaitInLoops: actions must execute serially by design
    await action(context, event);
  }
}

export function enqueueOrWarn<TStates extends string, TContext extends Record<string, unknown>>(
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
