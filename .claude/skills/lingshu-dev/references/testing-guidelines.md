# Testing Guidelines

This reference contains detailed testing guidelines for the lingshu-toolkit.

## Test Structure

### Basic Test Template

```typescript
// src/{namespace}/{tool-name}/index.test.ts

import { describe, it, expect } from 'vitest';
import { toolName } from '@/shared/tool-name';

describe('toolName', () => {
  it('should work correctly', () => {
    // Test implementation
  });
});
```

## Test Coverage Requirements

### Required Test Scenarios

1. **Happy Path Scenarios**
   - Normal usage with valid inputs
   - Expected behavior with typical data
   - Common use cases

2. **Edge Cases**
   - Empty values (`''`, `[]`, `{}`, `null`, `undefined`)
   - Boundary values (0, -1, very large numbers)
   - Special characters and unicode
   - Minimum/maximum lengths

3. **Invalid Inputs**
   - Wrong data types
   - Missing required parameters
   - Malformed data structures
   - Out-of-range values

4. **Error Handling**
   - Errors are thrown when expected
   - Error messages are descriptive
   - Graceful degradation when possible

## Testing Patterns

### Shared Tools (Utilities)

```typescript
describe('dataHandler', () => {
  describe('happy path', () => {
    it('should process valid data correctly', () => {
      const result = dataHandler({ key: 'value' });
      expect(result).toEqual({ processed: true });
    });

    it('should handle different data types', () => {
      expect(dataHandler('string')).toBeDefined();
      expect(dataHandler(123)).toBeDefined();
      expect(dataHandler([1, 2, 3])).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty objects', () => {
      const result = dataHandler({});
      expect(result).toBeDefined();
    });

    it('should handle null and undefined', () => {
      expect(dataHandler(null)).toBeDefined();
      expect(dataHandler(undefined)).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should throw error for invalid input', () => {
      expect(() => dataHandler(invalidInput)).toThrow();
    });
  });
});
```

### React Hooks

```typescript
import { renderHook, act } from '@vitest/react';
import { useToolName } from '@/react/use-tool-name';

describe('useToolName', () => {
  it('should initialize with default value', () => {
    const { result } = renderHook(() => useToolName('default'));
    expect(result.current[0]).toBe('default');
  });

  it('should update state when action is called', () => {
    const { result } = renderHook(() => useToolName('default'));
    
    act(() => {
      result.current[1].set('new value');
    });
    
    expect(result.current[0]).toBe('new value');
  });

  it('should reset to default value', () => {
    const { result } = renderHook(() => useToolName('default'));
    
    act(() => {
      result.current[1].set('new value');
      result.current[1].reset();
    });
    
    expect(result.current[0]).toBe('default');
  });

  it('should cleanup on unmount', () => {
    const { unmount } = renderHook(() => useToolName('default'));
    
    act(() => {
      unmount();
    });
    
    // Verify cleanup happened
  });
});
```

### Vue Hooks

```typescript
import { mount } from '@vue/test-utils';
import { useToolName } from '@/vue/use-tool-name';

describe('useToolName', () => {
  it('should initialize with default value', () => {
    const { state } = useToolName('default');
    expect(state.value).toBe('default');
  });

  it('should update state when method is called', () => {
    const { state, set } = useToolName('default');
    
    set('new value');
    
    expect(state.value).toBe('new value');
  });

  it('should reset to default value', () => {
    const { state, set, reset } = useToolName('default');
    
    set('new value');
    reset();
    
    expect(state.value).toBe('default');
  });
});
```

## Best Practices

### Test Organization
- Group related tests with `describe` blocks
- Use descriptive test names that explain what is being tested
- Keep tests independent and isolated
- One assertion per test when possible
- Use `beforeEach`/`afterEach` for setup/teardown

### Test Naming
- Use `should` pattern: "should return X when Y"
- Be specific about expected behavior
- Include edge cases in test names
- Use `describe` for grouping related scenarios

### React Hook Testing
- Use `renderHook` from `@vitest/react`
- Wrap state updates in `act()` for React
- Test both state and actions
- Test cleanup in `useEffect`
- Test memoization with `useMemo`

### Vue Hook Testing
- Use `@vue/test-utils` for component testing
- Test reactive state changes
- Test computed properties
- Test watchers
- Test lifecycle hooks

### Async Testing
- Use `async/await` for async operations
- Use `waitFor` for waiting on conditions
- Test loading states
- Test error states
- Test timeout scenarios

## Running Tests

### Run All Tests
```bash
pnpm run test:ci
```

### Run Specific Test File
```bash
pnpm run test:ci src/{namespace}/{tool-name}/index.test.ts
```

### Run Tests in Watch Mode
```bash
pnpm run test
```

### Run Tests with Coverage
```bash
pnpm run test:ci --coverage
```

## Coverage Goals

- **Statement Coverage**: > 90%
- **Branch Coverage**: > 85%
- **Function Coverage**: > 95%
- **Line Coverage**: > 90%

## Common Pitfalls

❌ **Don't** test implementation details
❌ **Don't** skip error handling tests
❌ **Don't** forget to test edge cases
❌ **Don't** write tests that are too coupled to implementation
❌ **Don't** forget to cleanup in `afterEach`

✅ **Do** test public API behavior
✅ **Do** test error scenarios
✅ **Do** test with realistic data
✅ **Do** keep tests simple and focused
✅ **Do** use descriptive test names
