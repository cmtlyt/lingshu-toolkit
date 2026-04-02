# Code Examples Reference

This document provides guidelines and templates for writing high-quality code examples in lingshu-toolkit documentation.

## General Principles

### 1. Type Safety
- Always include TypeScript types
- Avoid `any` type unless absolutely necessary
- Use interfaces for complex objects
- Provide type annotations for function parameters

### 2. Executability
- Code should run without modification
- No placeholder comments (TODO, FIXME, xxx)
- All imports are correct and complete
- Dependencies are clearly stated

### 3. Clarity
- Use meaningful variable names
- Add comments for complex logic
- Keep examples focused and concise
- Show only relevant code

## React Hook Examples

### Basic Hook Usage

```tsx
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function BasicExample() {
  const result = useHookName()

  return <div>{result}</div>
}
```

### Hook with Parameters

```tsx
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function ParameterExample({ value }: { value: string }) {
  const result = useHookName(value)

  return <div>{result}</div>
}
```

### Hook with Options

```tsx
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function OptionsExample() {
  const result = useHookName({
    option1: true,
    option2: 'value',
  })

  return <div>{result}</div>
}
```

### Hook with State

```tsx
import { useState } from 'react'
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function StateExample() {
  const [count, setCount] = useState(0)
  const result = useHookName(count)

  const handleClick = () => {
    setCount(count + 1)
  }

  return (
    <div>
      <p>Count: {count}</p>
      <p>Result: {result}</p>
      <button onClick={handleClick}>Increment</button>
    </div>
  )
}
```

### Hook with Effect

```tsx
import { useEffect } from 'react'
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function EffectExample() {
  const result = useHookName()

  useEffect(() => {
    console.log('Result changed:', result)
  }, [result])

  return <div>{result}</div>
}
```

### Advanced Hook Pattern

```tsx
import { useState, useRef, useEffect } from 'react'
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function AdvancedExample() {
  const [data, setData] = useState(null)
  const ref = useRef(null)
  const result = useHookName(data)

  useEffect(() => {
    // Side effect logic
    return () => {
      // Cleanup
    }
  }, [result])

  const handleAction = () => {
    // Handler logic
  }

  return (
    <div ref={ref}>
      <button onClick={handleAction}>Action</button>
      {result && <div>{result}</div>}
    </div>
  )
}
```

## Shared Tool Examples

### Basic Function Call

```ts
import { toolName } from '@cmtlyt/lingshu-toolkit/shared'

const result = toolName()
console.log(result)
```

### Function with Parameters

```ts
import { toolName } from '@cmtlyt/lingshu-toolkit/shared'

const result = toolName('input', 123)
console.log(result)
```

### Async Function

```ts
import { toolName } from '@cmtlyt/lingshu-toolkit/shared'

async function example() {
  const result = await toolName()
  console.log(result)
}
```

### Function with Options

```ts
import { toolName } from '@cmtlyt/lingshu-toolkit/shared'

const result = toolName({
  option1: true,
  option2: 'value',
})
console.log(result)
```

### Chained Operations

```ts
import { toolName1, toolName2 } from '@cmtlyt/lingshu-toolkit/shared'

const result1 = toolName1('input')
const result2 = toolName2(result1)
console.log(result2)
```

### Error Handling

```ts
import { toolName } from '@cmtlyt/lingshu-toolkit/shared'

async function example() {
  try {
    const result = await toolName()
    console.log(result)
  } catch (error) {
    console.error('Error:', error)
  }
}
```

## Vue Composable Examples

### Basic Composable Usage

```vue
<script setup lang="ts">
import { useComposableName } from '@cmtlyt/lingshu-toolkit/vue'

const result = useComposableName()
</script>

<template>
  <div>{{ result }}</div>
</template>
```

### Composable with Parameters

```vue
<script setup lang="ts">
import { useComposableName } from '@cmtlyt/lingshu-toolkit/vue'

const props = defineProps<{
  value: string
}>()

const result = useComposableName(props.value)
</script>

<template>
  <div>{{ result }}</div>
</template>
```

### Composable with Refs

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { useComposableName } from '@cmtlyt/lingshu-toolkit/vue'

const count = ref(0)
const result = useComposableName(count)

const increment = () => {
  count.value++
}
</script>

<template>
  <div>
    <p>Count: {{ count }}</p>
    <p>Result: {{ result }}</p>
    <button @click="increment">Increment</button>
  </div>
</template>
```

## Real-World Scenarios

### Data Fetching

```tsx
import { useState, useEffect } from 'react'
import { useDataFetcher } from '@cmtlyt/lingshu-toolkit/react'

function UserProfile({ userId }: { userId: string }) {
  const [user, setUser] = useState(null)
  const fetcher = useDataFetcher()

  useEffect(() => {
    fetcher.fetch(`/api/users/${userId}`)
      .then(setUser)
      .catch(console.error)
  }, [userId, fetcher])

  if (!user) return <div>Loading...</div>
  return <div>{user.name}</div>
}
```

### Form Handling

```tsx
import { useState } from 'react'
import { useFormValidator } from '@cmtlyt/lingshu-toolkit/react'

function ContactForm() {
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const validator = useFormValidator()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const validationErrors = validator.validate({ email })
    
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors)
      return
    }

    // Submit form
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {errors.email && <span className="error">{errors.email}</span>}
      <button type="submit">Submit</button>
    </form>
  )
}
```

### Performance Optimization

```tsx
import { useMemo, useCallback } from 'react'
import { useMemoized } from '@cmtlyt/lingshu-toolkit/react'

function ExpensiveComponent({ data }: { data: any[] }) {
  const processedData = useMemoized(
    () => data.map(item => ({
      ...item,
      computed: expensiveCalculation(item)
    })),
    [data]
  )

  const handleClick = useCallback(() => {
    // Handler logic
  }, [])

  return (
    <div>
      {processedData.map(item => (
        <div key={item.id} onClick={handleClick}>
          {item.computed}
        </div>
      ))}
    </div>
  )
}
```

### State Management

```ts
import { createStore } from '@cmtlyt/lingshu-toolkit/shared'

interface StoreState {
  count: number
  user: any | null
}

const store = createStore<StoreState>({
  count: 0,
  user: null,
})

// Usage
store.setState({ count: 1 })
const state = store.getState()
console.log(state.count) // 1
```

### Utility Functions

```ts
import { formatDate, debounce, throttle } from '@cmtlyt/lingshu-toolkit/shared'

// Date formatting
const formatted = formatDate(new Date(), 'YYYY-MM-DD')

// Debouncing
const debouncedSearch = debounce((query: string) => {
  console.log('Searching:', query)
}, 300)

// Throttling
const throttledScroll = throttle(() => {
  console.log('Scrolled')
}, 100)
```

## Code Quality Checklist

Before including a code example:

- [ ] All types are properly defined
- [ ] No `any` types (unless necessary)
- [ ] Imports are complete and correct
- [ ] Variable names are meaningful
- [ ] Complex logic has comments
- [ ] Example is focused and concise
- [ ] Code is executable
- [ ] No placeholder text (TODO, FIXME)
- [ ] Follows project coding standards
- [ ] Error handling is included where appropriate

## Common Mistakes to Avoid

### ❌ Bad Examples

```tsx
// Missing types
function Example() {
  const result = useHookName(anyValue)
  return <div>{result}</div>
}

// Placeholder comments
function Example() {
  const result = useHookName()
  // TODO: add more logic
  // FIXME: this is broken
  return <div>{result}</div>
}

// Incomplete imports
function Example() {
  const result = useHookName()
  // Missing import statement
  return <div>{result}</div>
}
```

### ✅ Good Examples

```tsx
// Complete with types
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function Example() {
  const result = useHookName('value')
  return <div>{result}</div>
}

// Clear and complete
import { useHookName } from '@cmtlyt/lingshu-toolkit/react'

function Example() {
  const [count, setCount] = useState(0)
  const result = useHookName(count)

  const increment = () => setCount(count + 1)

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={increment}>Increment</button>
    </div>
  )
}
```
