# Testing Guidelines

This reference contains detailed testing guidelines for the lingshu-toolkit.

## Test Structure

### Basic Test Template

```typescript
// src/{namespace}/{tool-name}/index.test.ts

import { describe, test, expect } from 'vitest';
import { toolName } from '@/shared/tool-name';

describe('toolName', () => {
  test('should work correctly', () => {
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
    test('should process valid data correctly', () => {
      const result = dataHandler({ key: 'value' });
      expect(result).toEqual({ processed: true });
    });

    test('should handle different data types', () => {
      expect(dataHandler('string')).toBeDefined();
      expect(dataHandler(123)).toBeDefined();
      expect(dataHandler([1, 2, 3])).toBeDefined();
    });
  });

  describe('edge cases', () => {
    test('should handle empty objects', () => {
      const result = dataHandler({});
      expect(result).toBeDefined();
    });

    test('should handle null and undefined', () => {
      expect(dataHandler(null)).toBeDefined();
      expect(dataHandler(undefined)).toBeDefined();
    });
  });

  describe('error handling', () => {
    test('should throw error for invalid input', () => {
      expect(() => dataHandler(invalidInput)).toThrow();
    });
  });
});
```

### React Hooks

```typescript
import { describe, expect, test } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { useToolName } from '@/react/use-tool-name';

describe('useToolName', () => {
  const setUp = (defaultValue?: any) => renderHook(() => useToolName(defaultValue));

  test('导出测试', () => {
    expect(useToolName).toBeTypeOf('function');
  });

  test('方法测试', async () => {
    const { result, act } = await setUp();
    expect(result.current[0]).toBe('default');
    act(() => {
      result.current[1].set('new value');
    });
    expect(result.current[0]).toBe('new value');
    act(() => {
      result.current[1].reset();
    });
    expect(result.current[0]).toBe('default');
  });

  test('默认值测试', async () => {
    const hook1 = await setUp('custom');
    expect(hook1.result.current[0]).toBe('custom');
    const hook2 = await setUp();
    expect(hook2.result.current[0]).toBe('default');
  });
});
```

### Vue Hooks

```typescript
import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-vue';
import { defineComponent, nextTick, ref } from 'vue';
import { useToolName } from '@/vue/use-tool-name';

describe('useToolName', () => {
  test('基本使用', async () => {
    const TestComponent = defineComponent({
      setup() {
        const value = useToolName('default');
        return () => null;
      },
    });
    render(TestComponent);
    await nextTick();
  });

  test('响应式更新', async () => {
    const value = ref('initial');
    const TestComponent = defineComponent({
      setup() {
        useToolName(value);
        return () => null;
      },
    });
    render(TestComponent);
    await nextTick();
    value.value = 'updated';
    await nextTick();
  });

  test('卸载时清理', async () => {
    const TestComponent = defineComponent({
      setup() {
        useToolName('value');
        return () => null;
      },
    });
    const { unmount } = render(TestComponent);
    await nextTick();
    unmount();
    await nextTick();
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
- Use `renderHook` from `vitest-browser-react`
- Wrap state updates in `act()` for React
- Test both state and actions
- Test cleanup in `useEffect`
- Test memoization with `useMemo`

### Vue Hook Testing
- Use `vitest-browser-vue` for component testing
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

- **Statement Coverage**: = 100%
- **Branch Coverage**: = 100%
- **Function Coverage**: = 100%
- **Line Coverage**: = 100%

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
