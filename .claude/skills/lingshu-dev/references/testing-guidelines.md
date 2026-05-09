# Testing Guidelines

This reference contains detailed testing guidelines for the lingshu-toolkit.

## Table of Contents

- [Test Structure](#test-structure)
- [Test Coverage Requirements](#test-coverage-requirements)
- [Testing Patterns](#testing-patterns) — Shared / React / Vue
- [Best Practices](#best-practices)
- [Fake Timers](#fake-timers必须使用禁止真实计时器) — 铁律 + 精细化拦截 + async vs sync
- [Running Tests](#running-tests)
- [Coverage Goals](#coverage-goals)
- [Common Pitfalls](#common-pitfalls)

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

### Fake Timers（必须使用，禁止真实计时器）

🚫 **铁律**：涉及定时器、等待时序的测试用例**必须**使用 `vi.useFakeTimers()`。**禁止** `setTimeout(resolve, N)` 真实等待，CI 会被严重拖慢。

✅ **基础用法**（纯 JS 定时器场景）：

```typescript
import { vi, afterEach } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
});

test('定时器到期触发回调', () => {
  vi.useFakeTimers();
  const cb = vi.fn();
  setTimeout(cb, 1000);
  vi.advanceTimersByTime(1000);
  expect(cb).toHaveBeenCalled();
});
```

✅ **精细化拦截**（源码内部用 `Date.now()` / `performance.now()` 做真实时间戳判定，且测试需要主动推进定时器的场景）：

vitest 默认 `useFakeTimers()` 的 toFake 列表是「除 `nextTick` 和 `queueMicrotask` 外所有当前环境全局可用的定时器/时间相关方法」（参考 vitest 官方文档 `Vi | useFakeTimers`）。该清单在不同运行环境（node / 浏览器 / vitest workspace 配置）会有差异，**确切完整列表以你使用的 vitest 版本官方文档为准，不要凭印象列举**。**实测可复现的关键后果**：默认模式下 `Date` / `performance` 通常都被 fake、`queueMicrotask` / `process.nextTick` 通常不被 fake。

这意味着默认 fake 模式下 **`Date.now()` / `performance.now()` 都被冻结**。**源码 / 测试中任何依赖真实时间戳的逻辑**（如超时检测、心跳保活、TTL 比较、单调递增的序号生成等）都会被冻住，导致测试时序断言失败。此时用 `toFake` 选项**只拦截 JS 定时器 API**，让 `Date` / `performance` 保持真实：

```typescript
vi.useFakeTimers({
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
});

// Date.now() / performance.now() 保持真实，源码内的真实时间戳判定逻辑正常工作
// 源码 + 测试的 setTimeout / setInterval 全部受控
await vi.advanceTimersByTimeAsync(60); // 推进时间 + flush 微任务
```

✅ **`advanceTimersByTimeAsync` vs `advanceTimersByTime`**：
- 同步版（`advanceTimersByTime`）：仅推进 timer 队列并跑到期的定时器回调，跑完后**不会主动让出事件循环 flush 微任务**
- 异步版（`advanceTimersByTimeAsync`）：每推进一段时间后会 `await Promise.resolve()` 让出事件循环，把 `.then` 微任务链跑完
- **判断标准**：定时器回调内是否有 `Promise` / `await` / `.then`？有就用 async 版，没有就用 sync 版

❌ **反模式**：

```typescript
// ❌ 真实等待
await new Promise(resolve => setTimeout(resolve, 600));

// ❌ 默认 fake 范围下 Date 被冻住，依赖真实时间戳的逻辑（超时检测、心跳保活、TTL 比较等）会失败
vi.useFakeTimers();
// 此时 Date.now() 不会随 advanceTimersByTime 推进而前进。
// 任何「真实时间戳差值 > 阈值」类的判定（心跳超时、TTL 过期等）会因为差值永远等于 0 / 固定值，断言失败

// ❌ 多级定时器链 + 同步版推进，无法把后续 setTimeout 链全部冲刷
function delayedTwice(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      // 第一层 timer 回调：通过微任务安排第二层 timer
      Promise.resolve().then(() => {
        setTimeout(resolve, 50);
      });
    }, 100);
  });
}

const p = delayedTwice();
vi.advanceTimersByTime(100);
// ⚠️ 第一层 setTimeout 回调跑完，但回调内的 .then 是微任务、未被 flush
// ⚠️ 微任务里安排的第二层 setTimeout(resolve, 50) 也就没被注册
vi.advanceTimersByTime(50);
// ⚠️ 第二次推进也找不到第二层 timer（它从未进入队列）
await p; // ⚠️ p 永远不 settle → 测试超时（vitest 默认 5s，CI 上常表现为 hang）
```

> **机理（同步 vs 异步推进）**：`advanceTimersByTime` 让所有到期 timer 回调同步跑完，但 Promise `.then` / `async` 函数后续链都是微任务（microtask），同步推进结束后**不会让出事件循环**，因此回调内通过 `.then` 注册的「下一层 setTimeout」从未进入 timer 队列；下次再 advance 也找不到它。`advanceTimersByTimeAsync` 在每次推进后 `await` 一次微任务循环，让 `.then` 链跑完、把后续 timer 注册到队列里，再继续推进。判断标准：定时器回调里只要出现 `Promise` / `await` / `.then`，就用 async 版。

✅ **正确替代**：

```typescript
// 想等真实时间 → 改用 fake timers 推进
vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
await vi.advanceTimersByTimeAsync(600);
```

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
