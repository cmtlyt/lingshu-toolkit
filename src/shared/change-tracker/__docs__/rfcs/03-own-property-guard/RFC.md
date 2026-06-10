# RFC：自身属性守卫（Own-Property Guard）

> 状态：implemented
> 作者：陈麦特
> 日期：2026/06/10
> 关联：[01-change-tracker](../01-change-tracker/RFC.md)、[02-refactor-modules](../02-refactor-modules/RFC.md)

## 背景

当前 `proxy-engine.ts` 在 `get` / `set` / `deleteProperty` handler 中，未判断目标属性是否为对象**自身属性**（own property），`Reflect.get` / `Reflect.set` / `Reflect.deleteProperty` 会穿透原型链。这会导致以下问题：

1. **get 穿透**：访问原型链上的可代理属性（如用户通过原型继承了一个对象属性），会被 `isProxyable` 判定为需要代理，从而为原型上的值创建子 Proxy 并缓存——修改该代理不会实际影响自身对象，产生"幽灵 patch"
2. **set 语义歧义**：对一个不存在于自身的属性执行 `set` 时，当前逻辑会正确在自身创建属性（`Reflect.set` 的默认行为），patch 语义上没问题——但若原型链上恰好有同名 getter/setter，`Reflect.set` 会调用 setter 而非在自身创建属性，此时 patch 与实际效果不一致
3. **delete 穿透**：`Reflect.deleteProperty` 只能删除自身属性，对原型属性返回 `true` 但不做任何事，此时仍会 emit 一条无效的 `delete` patch

此外，`replay.ts` 的 `delete` 分支直接 `delete parent[key]`，同样不会验证属性是否存在于自身——虽然 `delete` 操作符本身不穿透原型链，但会产生无意义操作。

## 目标

1. **proxy-engine `get` handler**：仅对自身属性创建深度子 Proxy；原型链上的属性直接返回原始值，不缓存、不代理
2. **proxy-engine `set` handler**：无论属性是否已存在于自身，`set` 都应在自身创建/修改属性并 emit patch——当前行为已基本正确，但需增加对 accessor 属性（getter/setter）的防护
3. **proxy-engine `deleteProperty` handler**：仅当属性存在于自身时才 emit `delete` patch；原型上的属性不产生 patch
4. **replay `delete` 分支**：保持现有行为（`delete` 操作符本身不穿透原型链），无需改动，但补充说明注释
5. **不改变公开 API**，纯内部行为修正
6. **导出 `PatchOp` 类型**：将 `types.ts` 中的 `PatchOp` 从内部类型改为 `export type`，并在 `index.ts` 入口 re-export，供外部消费者使用（如类型判断、patch 过滤等场景）

## 方案设计

### 3.1 属性判定方式

使用 `Object.prototype.hasOwnProperty.call(target, prop)` 进行自身属性判定，不使用 `in` 操作符（会穿透原型链）。

为避免重复代码，在 `helpers.ts` 新增内部工具函数：

```ts
export function hasOwn(target: object, prop: string | number | symbol): boolean {
  return Object.prototype.hasOwnProperty.call(target, prop);
}
```

### 3.2 proxy-engine 改动

#### get handler

```ts
get(rawTarget, prop, receiver) {
  if (typeof prop === 'symbol') {
    return Reflect.get(rawTarget, prop, receiver);
  }

  // 数组变异方法照旧
  if (Array.isArray(rawTarget) && (ARRAY_MUTATORS as readonly string[]).includes(prop)) {
    return createArrayMutatorTrap(...);
  }

  const value = Reflect.get(rawTarget, prop, receiver);

  // ✅ 仅对自身属性创建子 Proxy
  if (hasOwn(rawTarget, prop) && isProxyable(value) && typeof prop === 'string') {
    if (!proxyCache.has(prop)) {
      const childPath = [...path, Array.isArray(rawTarget) ? Number(prop) : prop];
      proxyCache.set(prop, createDeepProxy(value as object, childPath, emit, types));
    }
    return proxyCache.get(prop);
  }

  return value;
}
```

**关键变化**：在 `isProxyable(value)` 判定前增加 `hasOwn(rawTarget, prop)` 守卫。原型上的对象属性仍会被 `Reflect.get` 返回，但不会被代理包装。

#### deleteProperty handler

```ts
deleteProperty(rawTarget, prop) {
  if (typeof prop === 'symbol') {
    return Reflect.deleteProperty(rawTarget, prop);
  }

  // ✅ 仅对自身属性 emit delete patch
  if (hasOwn(rawTarget, prop)) {
    const fullPath = [...path, Array.isArray(rawTarget) ? Number(prop) : prop];
    emit({ path: fullPath, op: 'delete', timestamp: Date.now() });
    proxyCache.delete(prop);
  }

  return Reflect.deleteProperty(rawTarget, prop);
}
```

**关键变化**：emit 和 proxyCache 清理包裹在 `hasOwn` 守卫内。`Reflect.deleteProperty` 本身对非自身属性返回 `true`，行为不变。

#### set handler

`set` handler **不需要** `hasOwn` 守卫——无论属性是否已存在于自身，`set` 操作的语义都是"在这个对象上设置这个属性"，应当 emit patch。`Reflect.set` 会正确在自身创建属性。

但需要注意一个边界情况：如果原型链上有同名 accessor property（getter/setter），`Reflect.set` 不会在自身创建 data property，而是调用 setter。这种场景在 plain object 变更追踪中极为罕见（`changeTracker` 的入参通常是 JSON 可序列化的 POJO），本期不做特殊处理，后续按需扩展。

### 3.3 replay.ts

`replay.ts` 的 `delete` 分支使用 `delete parent[key]`，`delete` 操作符本身不穿透原型链，行为正确。不做改动。

### 3.4 helpers.ts — deepClone

`deepClone` 已使用 `Object.keys()` 遍历（只返回自身可枚举属性），行为正确。不做改动。

## 影响范围

| 文件 | 改动 |
|------|------|
| `helpers.ts` | 新增 `hasOwn` 工具函数 |
| `proxy-engine.ts` | `get` 增加 `hasOwn` 守卫；`deleteProperty` 增加 `hasOwn` 守卫 |
| `types.ts` | `PatchOp` 改为 `export type` |
| `index.ts` | re-export `PatchOp` 类型 |
| `index.node.test.ts` | 新增原型链穿透测试用例 |

## 约束

1. **不改变公开 API**：`recordTransaction` / `createRecorder` / `replay` 签名不变
2. **不影响正常 POJO 操作**：所有现有测试必须保持通过
3. **仅守卫 proxy-engine 层**：replay 的 `delete` 不需要改动（操作符本身安全）
4. **不处理 accessor property 边界**：本期只做 own-property 判定，不处理 getter/setter 在原型链上的极端情况
