import { describe, expect, test, vi } from 'vitest';
import type { EventPayload } from './index';
import { createStateMachine } from './index';

describe('createStateMachine', () => {
  test('should be a function', () => {
    expect(createStateMachine).toBeTypeOf('function');
  });

  // ============================================================
  // Phase 6.1: Basic transitions & context
  // ============================================================
  describe('basic transitions', () => {
    test('should start in initial state', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: { idle: {}, running: {} },
      });
      expect(machine.getState()).toBe('idle');
    });

    test('should transition between states (sync)', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: {
          idle: { on: { START: { target: 'running' } } },
          running: { on: { STOP: { target: 'idle' } } },
        },
      });

      const result = machine.trigger({ type: 'START' });
      expect(result).toBe(true);
      expect(machine.getState()).toBe('running');

      void machine.trigger({ type: 'STOP' });
      expect(machine.getState()).toBe('idle');
    });

    test('should update context via actions', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: { count: 0 },
        states: {
          idle: {
            on: {
              INCREMENT: {
                target: 'idle',
                action: (ctx) => {
                  ctx.count++;
                },
              },
            },
          },
        },
      });

      void machine.trigger({ type: 'INCREMENT' });
      expect(machine.getContext().count).toBe(1);

      void machine.trigger({ type: 'INCREMENT' });
      expect(machine.getContext().count).toBe(2);
    });

    test('should return immutable context snapshot', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: { value: 42 },
        states: { idle: {} },
      });
      const ctx = machine.getContext();
      expect(ctx.value).toBe(42);
      // Snapshot should be a copy
      expect(ctx).not.toBe(machine.getContext());
    });

    test('should throw if initial state is not defined', () => {
      expect(() => {
        createStateMachine({
          initial: 'nonexistent' as 'idle',
          context: {},
          states: { idle: {} },
        });
      }).toThrow('not defined');
    });
  });

  // ============================================================
  // Phase 6.2: Guard tests
  // ============================================================
  describe('guards', () => {
    test('should allow transition when guard returns true', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: { allowed: true },
        states: {
          idle: {
            on: { GO: { target: 'running', guard: (ctx) => ctx.allowed } },
          },
          running: {},
        },
      });

      expect(machine.trigger({ type: 'GO' })).toBe(true);
      expect(machine.getState()).toBe('running');
    });

    test('should reject transition when guard returns false', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: { allowed: false },
        states: {
          idle: {
            on: { GO: { target: 'running', guard: (ctx) => ctx.allowed } },
          },
          running: {},
        },
      });

      expect(machine.trigger({ type: 'GO' })).toBe(false);
      expect(machine.getState()).toBe('idle');
    });

    test('should match first passing guard in array', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: { balance: 50 },
        states: {
          idle: {
            on: {
              PAY: [
                { target: 'premium', guard: (ctx) => ctx.balance >= 100 },
                { target: 'basic', guard: (ctx) => ctx.balance >= 10 },
                { target: 'rejected' },
              ],
            },
          },
          premium: {},
          basic: {},
          rejected: {},
        },
      });

      expect(machine.trigger({ type: 'PAY' })).toBe(true);
      expect(machine.getState()).toBe('basic');
    });

    test('should fall through to guardless transition', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: { balance: 0 },
        states: {
          idle: {
            on: {
              PAY: [{ target: 'premium', guard: (ctx) => ctx.balance >= 100 }, { target: 'rejected' }],
            },
          },
          premium: {},
          rejected: {},
        },
      });

      expect(machine.trigger({ type: 'PAY' })).toBe(true);
      expect(machine.getState()).toBe('rejected');
    });

    test('should resolve named guards from registry', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: { ok: true },
        states: {
          idle: {
            on: { GO: { target: 'done', guard: 'isOk' } },
          },
          done: {},
        },
        guards: {
          isOk: (ctx) => ctx.ok,
        },
      });

      expect(machine.trigger({ type: 'GO' })).toBe(true);
      expect(machine.getState()).toBe('done');
    });

    test('should throw on unregistered named guard', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: {
          idle: {
            on: { GO: { target: 'done', guard: 'missingGuard' } },
          },
          done: {},
        },
      });

      expect(() => machine.trigger({ type: 'GO' })).toThrow('missingGuard');
    });
  });

  // ============================================================
  // Phase 6.3: Action tests (onEntry / onExit / transition / order)
  // ============================================================
  describe('actions', () => {
    test('should execute onEntry on initial state', () => {
      const log: string[] = [];
      createStateMachine({
        initial: 'idle',
        context: {},
        states: {
          idle: {
            onEntry: () => {
              log.push('enter-idle');
            },
          },
        },
      });
      expect(log).toEqual(['enter-idle']);
    });

    test('should execute actions in correct order: onExit → transition → onEntry', () => {
      const log: string[] = [];
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: {
              GO: {
                target: 'b',
                action: () => {
                  log.push('transition');
                },
              },
            },
            onExit: () => {
              log.push('exit-a');
            },
          },
          b: {
            onEntry: () => {
              log.push('enter-b');
            },
          },
        },
      });

      // Clear initial entry log
      log.length = 0;

      void machine.trigger({ type: 'GO' });
      expect(log).toEqual(['exit-a', 'transition', 'enter-b']);
    });

    test('should support multiple actions as array', () => {
      const log: string[] = [];
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: {
              GO: {
                target: 'b',
                action: [
                  () => {
                    log.push('t1');
                  },
                  () => {
                    log.push('t2');
                  },
                ],
              },
            },
            onExit: [
              () => {
                log.push('exit1');
              },
              () => {
                log.push('exit2');
              },
            ],
          },
          b: {
            onEntry: [
              () => {
                log.push('enter1');
              },
              () => {
                log.push('enter2');
              },
            ],
          },
        },
      });

      log.length = 0;
      void machine.trigger({ type: 'GO' });
      expect(log).toEqual(['exit1', 'exit2', 't1', 't2', 'enter1', 'enter2']);
    });

    test('should resolve named actions from registry', () => {
      const log: string[] = [];
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: { GO: { target: 'b', action: 'doTransition' } },
            onExit: 'doExit',
          },
          b: { onEntry: 'doEntry' },
        },
        actions: {
          doExit: () => {
            log.push('exit');
          },
          doTransition: () => {
            log.push('transition');
          },
          doEntry: () => {
            log.push('entry');
          },
        },
      });

      log.length = 0;
      void machine.trigger({ type: 'GO' });
      expect(log).toEqual(['exit', 'transition', 'entry']);
    });

    test('should throw on unregistered named action', () => {
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: { GO: { target: 'b', action: 'missing' } },
          },
          b: {},
        },
      });

      expect(() => machine.trigger({ type: 'GO' })).toThrow('missing');
    });

    test('should pass event payload to actions', () => {
      let receivedEvent: EventPayload | null = null;
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: {
              GO: {
                target: 'b',
                action: (_ctx, event) => {
                  receivedEvent = event;
                },
              },
            },
          },
          b: {},
        },
      });

      void machine.trigger({ type: 'GO', data: 123 });
      expect(receivedEvent).toEqual({ type: 'GO', data: 123 });
    });

    test('should support self-transition (no target)', () => {
      const log: string[] = [];
      const machine = createStateMachine({
        initial: 'idle',
        context: { count: 0 },
        states: {
          idle: {
            on: {
              TICK: {
                action: (ctx) => {
                  ctx.count++;
                  log.push('tick');
                },
              },
            },
          },
        },
      });

      log.length = 0;
      void machine.trigger({ type: 'TICK' });
      expect(machine.getState()).toBe('idle');
      expect(machine.getContext().count).toBe(1);
      expect(log).toContain('tick');
    });
  });

  // ============================================================
  // Phase 6.4: Event queue tests
  // ============================================================
  describe('event queue', () => {
    test('should handle events triggered from actions via queue (FIFO)', () => {
      const log: string[] = [];
      let machineRef: { trigger: (event: { type: string }) => unknown } | null = null;

      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: {
              GO: {
                target: 'b',
                action: () => {
                  log.push('a→b');
                  // Trigger another event from within action
                  void machineRef!.trigger({ type: 'NEXT' });
                },
              },
            },
          },
          b: {
            on: {
              NEXT: {
                target: 'c',
                action: () => {
                  log.push('b→c');
                },
              },
            },
          },
          c: {},
        },
      });
      machineRef = machine;

      log.length = 0;
      void machine.trigger({ type: 'GO' });
      expect(log).toEqual(['a→b', 'b→c']);
      expect(machine.getState()).toBe('c');
    });
  });

  // ============================================================
  // Phase 6.5: Async mode tests
  // ============================================================
  describe('async mode', () => {
    test('should return Promise<boolean> in async mode', async () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        async: true as const,
        states: {
          idle: { on: { GO: { target: 'done' } } },
          done: {},
        },
      });

      const result = machine.trigger({ type: 'GO' });
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe(true);
      expect(machine.getState()).toBe('done');
    });

    test('should support async guard', async () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        async: true as const,
        states: {
          idle: {
            on: {
              GO: {
                target: 'done',
                guard: async () => {
                  await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                  });
                  return true;
                },
              },
            },
          },
          done: {},
        },
      });

      expect(await machine.trigger({ type: 'GO' })).toBe(true);
      expect(machine.getState()).toBe('done');
    });

    test('should support async action', async () => {
      const log: string[] = [];
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        async: true as const,
        states: {
          idle: {
            on: {
              GO: {
                target: 'done',
                action: async () => {
                  await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                  });
                  log.push('async-action');
                },
              },
            },
          },
          done: {},
        },
      });

      await machine.trigger({ type: 'GO' });
      expect(log).toEqual(['async-action']);
    });

    test('should reject transition when async guard returns false', async () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        async: true as const,
        states: {
          idle: {
            on: { GO: { target: 'done', guard: async () => false } },
          },
          done: {},
        },
      });

      expect(await machine.trigger({ type: 'GO' })).toBe(false);
      expect(machine.getState()).toBe('idle');
    });

    test('should execute onEntry for initial state in async mode', async () => {
      const log: string[] = [];
      createStateMachine({
        initial: 'idle',
        context: {},
        async: true as const,
        states: {
          idle: {
            onEntry: async () => {
              log.push('async-init-entry');
            },
          },
        },
      });
      // Give async entry time to complete
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      expect(log).toEqual(['async-init-entry']);
    });
  });

  // ============================================================
  // Phase 6.6: Defensive programming tests
  // ============================================================
  describe('defensive programming', () => {
    test('should call onUnhandledEvent for undefined events', () => {
      const unhandled: Array<{ state: string; event: string }> = [];
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: { idle: {} },
        onUnhandledEvent: (state, event) => {
          unhandled.push({ state, event });
        },
      });

      void machine.trigger({ type: 'UNKNOWN' });
      expect(unhandled).toEqual([{ state: 'idle', event: 'UNKNOWN' }]);
    });

    test('should silently ignore undefined events when no handler', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: { idle: {} },
      });

      expect(machine.trigger({ type: 'UNKNOWN' })).toBe(false);
      expect(machine.getState()).toBe('idle');
    });

    test('should reject events on final state', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: {
          idle: { on: { FINISH: { target: 'done' } } },
          done: { final: true },
        },
      });

      void machine.trigger({ type: 'FINISH' });
      expect(machine.getState()).toBe('done');

      expect(machine.trigger({ type: 'FINISH' })).toBe(false);
      expect(machine.getState()).toBe('done');
    });

    test('should detect cyclic events and throw', () => {
      let machineRef: { trigger: (event: { type: string }) => unknown } | null = null;

      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: {
              LOOP: {
                target: 'a',
                action: () => {
                  void machineRef!.trigger({ type: 'LOOP' });
                },
              },
            },
          },
        },
        settings: { maxCyclicCount: 3 },
      });
      machineRef = machine;

      expect(() => machine.trigger({ type: 'LOOP' })).toThrow('Cyclic event detected');
    });

    test('should drop events when queue overflows', () => {
      let machineRef: { trigger: (event: { type: string }) => unknown } | null = null;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: {
            on: {
              FILL: {
                target: 'a',
                action: () => {
                  // Queue up more events than allowed
                  for (let i = 0; i < 5; i++) {
                    void machineRef!.trigger({ type: 'EXTRA' });
                  }
                },
              },
              EXTRA: { target: 'a' },
            },
          },
        },
        settings: { maxQueueSize: 3, maxCyclicCount: 100 },
      });
      machineRef = machine;

      void machine.trigger({ type: 'FILL' });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('should throw on disposed machine', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: { idle: {} },
      });

      machine.dispose();
      expect(() => machine.trigger({ type: 'GO' })).toThrow('disposed');
    });

    test('should throw if target state is not defined', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: {
          idle: {
            on: { GO: { target: 'nonexistent' as 'idle' } },
          },
        },
      });

      expect(() => machine.trigger({ type: 'GO' })).toThrow('not defined');
    });
  });

  // ============================================================
  // Phase 6.7: subscribe / dispose tests
  // ============================================================
  describe('subscribe & dispose', () => {
    test('should notify subscribers on state change', () => {
      const events: Array<{ from: string; to: string }> = [];
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: { on: { GO: { target: 'b' } } },
          b: {},
        },
      });

      machine.subscribe((event) => {
        events.push({ from: event.from, to: event.to });
      });

      void machine.trigger({ type: 'GO' });
      expect(events).toEqual([{ from: 'a', to: 'b' }]);
    });

    test('should include context snapshot in change event', () => {
      let capturedContext: Record<string, unknown> | null = null;
      const machine = createStateMachine({
        initial: 'a',
        context: { value: 1 },
        states: {
          a: {
            on: {
              GO: {
                target: 'b',
                action: (ctx) => {
                  ctx.value = 99;
                },
              },
            },
          },
          b: {},
        },
      });

      machine.subscribe((event) => {
        capturedContext = event.context as Record<string, unknown>;
      });

      void machine.trigger({ type: 'GO' });
      expect(capturedContext).toEqual({ value: 99 });
    });

    test('should unsubscribe correctly', () => {
      const events: string[] = [];
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: { on: { GO: { target: 'b' } } },
          b: { on: { BACK: { target: 'a' } } },
        },
      });

      const unsubscribe = machine.subscribe(() => {
        events.push('notified');
      });

      void machine.trigger({ type: 'GO' });
      expect(events).toHaveLength(1);

      unsubscribe();
      void machine.trigger({ type: 'BACK' });
      expect(events).toHaveLength(1); // No new notification
    });

    test('should clear everything on dispose', () => {
      const events: string[] = [];
      const machine = createStateMachine({
        initial: 'a',
        context: {},
        states: {
          a: { on: { GO: { target: 'b' } } },
          b: {},
        },
      });

      machine.subscribe(() => {
        events.push('notified');
      });
      machine.dispose();

      expect(() => machine.trigger({ type: 'GO' })).toThrow('disposed');
    });
  });

  // ============================================================
  // API: matches / getAvailableEvents
  // ============================================================
  describe('API methods', () => {
    test('matches() should return correct result', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: {
          idle: { on: { GO: { target: 'running' } } },
          running: {},
        },
      });

      expect(machine.matches('idle')).toBe(true);
      expect(machine.matches('running')).toBe(false);

      void machine.trigger({ type: 'GO' });
      expect(machine.matches('idle')).toBe(false);
      expect(machine.matches('running')).toBe(true);
    });

    test('getAvailableEvents() should return events for current state', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: {
          idle: { on: { START: { target: 'running' }, RESET: { target: 'idle' } } },
          running: { on: { STOP: { target: 'idle' } } },
        },
      });

      expect(machine.getAvailableEvents().sort((a, b) => a.localeCompare(b))).toEqual(['RESET', 'START']);

      void machine.trigger({ type: 'START' });
      expect(machine.getAvailableEvents()).toEqual(['STOP']);
    });

    test('getAvailableEvents() should return empty array for state with no events', () => {
      const machine = createStateMachine({
        initial: 'idle',
        context: {},
        states: { idle: {} },
      });

      expect(machine.getAvailableEvents()).toEqual([]);
    });
  });
});
