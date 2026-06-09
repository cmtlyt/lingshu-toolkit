import { throwError } from '@/shared/throw-error';
import { buildMachineApi, drainAsyncQueue, drainSyncQueue, processEventSync } from './engine';
import { checkCyclic, enqueueOrWarn, FN_NAME, resolveActionRefs, runActionsAsync, runActionsSync } from './helpers';
import type { EventPayload, InternalState, Registries, StateMachine, StateMachineConfig } from './types';

export function createStateMachine<
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
    guards: guardRegistry as any,
    actions: actionRegistry as any,
    states: states as any,
    onUnhandledEvent: config.onUnhandledEvent,
  };

  // Execute onEntry for initial state
  const initEntryActions = resolveActionRefs(reg.states[initial].onEntry, reg.actions);
  if (initEntryActions.length > 0) {
    const initEvent: EventPayload = { type: '__init__' };
    if (isAsync) {
      void runActionsAsync(initEntryActions, internal.context, initEvent).catch((error) => {
        config.onError?.(error, internal.context);
      });
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
