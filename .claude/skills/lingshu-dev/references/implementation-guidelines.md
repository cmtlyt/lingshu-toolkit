# Implementation Guidelines

This reference contains detailed implementation guidelines for different tool types in the lingshu-toolkit.

## Shared Tools (Utilities)

Pure functions with no side effects.

### Characteristics
- **No side effects**: Don't modify global state or external resources
- **Deterministic**: Same input always produces same output
- **Type-safe**: Use TypeScript generics for flexibility
- **Export types**: Make public types available to consumers

### Pattern

```typescript
// src/shared/tool-name/index.ts

/**
 * Brief description of what the tool does
 * 
 * @param param1 - Description of parameter
 * @param param2 - Description of parameter
 * @returns Description of return value
 * 
 * @example
 * ```ts
 * const result = toolName('input');
 * ```
 */
function toolName<T>(data: T, options?: Options): Result {
  // Implementation
  return result;
}

// Export types used in public API
type Options = {
  // Option definitions
};

type Result = {
  // Result type definition
};

export type { Options, Result }

export { toolName };
```

### Examples
- `dataHandler` - Data transformation utilities
- `conditionMerge` - Conditional object merging
- `throwError` - Error-throwing utilities

### Best Practices
- Use TypeScript generics for type flexibility
- Prefer pure functions over classes
- Export all types used in public API
- Add JSDoc comments for public APIs
- Handle edge cases and invalid inputs gracefully
- Return early for error conditions (guard clauses)

## React Hooks

Custom React hooks following React best practices.

### Characteristics
- **Use `use*` naming convention**: Follow React's naming pattern
- **Return `[state, actions]` tuple**: Consistent API pattern
- **Memoize actions**: Use `useMemo` for stable references
- **Handle cleanup**: Use `useEffect` cleanup for side effects
- **Type-safe**: Proper TypeScript typing for state and actions

### Pattern

```typescript
// src/react/use-tool-name/index.ts

import { useMemo, useState, useEffect, useCallback } from 'react';

/**
 * Brief description of what the hook does
 * 
 * @param defaultValue - Initial value
 * @returns Tuple of [state, actions]
 * 
 * @example
 * ```ts
 * const [state, { set, reset }] = useToolName(defaultValue);
 * ```
 */
function useToolName<T>(defaultValue: T): [T, Actions<T>] {
  const [state, setState] = useState<T>(defaultValue);

  const actions = useMemo(() => ({
    set: (value: T) => setState(value),
    reset: () => setState(defaultValue),
    // Add more actions as needed
  }), [defaultValue]);

  // Add useEffect for cleanup if needed
  useEffect(() => {
    // Setup code
    return () => {
      // Cleanup code
    };
  }, []);

  return [state, actions] as const;
}

type Actions<T> = {
  set: (value: T) => void;
  reset: () => void;
};

export { useToolName };
```

### Examples
- `useBoolean` - Boolean state management
- `useToggle` - Toggle between two values
- `useStorage` - LocalStorage synchronization

### Best Practices
- Always use `useMemo` for actions to prevent unnecessary re-renders
- Use `useCallback` for event handlers passed to child components
- Handle cleanup in `useEffect` for subscriptions, timers, etc.
- Return tuple pattern `[state, actions]` for consistency
- Use `as const` for tuple return type to enable type inference

## Vue Hooks

Vue 3 Composition API hooks.

### Characteristics
- **Use `use*` naming convention**: Follow Vue's pattern
- **Composition API**: Use Vue 3's reactive system
- **Reactive state**: Use `ref` or `reactive` for state management
- **Computed values**: Use `computed` for derived state
- **Lifecycle hooks**: Use appropriate Vue lifecycle hooks

### Pattern

```typescript
// src/vue/use-tool-name/index.ts

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

/**
 * Brief description of what the hook does
 * 
 * @param defaultValue - Initial value
 * @returns Object with state and methods
 * 
 * @example
 * ```ts
 * const { state, set, reset } = useToolName(defaultValue);
 * ```
 */
function useToolName<T>(defaultValue: T) {
  const state = ref<T>(defaultValue);

  const set = (value: T) => {
    state.value = value;
  };

  const reset = () => {
    state.value = defaultValue;
  };

  // Add computed values if needed
  const computedValue = computed(() => {
    // Derived state logic
    return state.value;
  });

  // Add watchers if needed
  watch(state, (newValue, oldValue) => {
    // React to state changes
  });

  // Add lifecycle hooks if needed
  onMounted(() => {
    // Setup code
  });

  onUnmounted(() => {
    // Cleanup code
  });

  return {
    state,
    set,
    reset,
    computedValue,
  };
}

export { useToolName };
```

### Examples
- `useTitle` - Document title management

### Best Practices
- Use `ref` for primitives, `reactive` for objects
- Use `computed` for derived state
- Use `watch` for side effects based on state changes
- Clean up in `onUnmounted` for subscriptions, timers, etc.
- Return an object (not a tuple) for better IDE autocomplete

## Code Style

### General Rules
- Use Biome for formatting (auto-applied)
- Prefer `const` over `let`
- Use explicit types for function signatures
- Add JSDoc comments for public APIs
- Handle edge cases and invalid inputs

### TypeScript Guidelines
- Avoid `any` type without justification
- Use generics for reusable functions
- Export types used in public API
- Use `as const` for literal types
- Prefer union types over enums for simple cases

### Error Handling
- Use guard clauses for early returns
- Throw descriptive errors with context
- Validate inputs at function boundaries
- Provide helpful error messages

### Performance
- Memoize expensive computations
- Use `useMemo` for React hook actions
- Avoid unnecessary re-renders in React
- Use `computed` for Vue derived state
