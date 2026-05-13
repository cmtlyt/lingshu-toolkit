# standalone（无 id）实例的 `__local__` 占位泄漏到 driver / authority

> 范围：`src/shared/lock-data/core/entry.ts`、`src/shared/lock-data/core/registry.ts`、
> `src/shared/lock-data/core/actions.ts`（仅修 acquire `name` 来源）
> 目标：把"展示用占位 id"和"驱动 / authority 判定用真实 id"拆开，恢复"无 id 仅限本地"的语义

---

## 1. 缺陷复现路径

`core/entry.ts::acquireStandalone` 在无 id 路径下用伪 id 调用 factory：

```ts
const entry = factory('__local__', options, { registerTeardown });
```

而 `createEntryFactory` 把这个 `id` 直接喂给了 `pickDriver` / `attachAuthority` / `Entry.id`。
对下游来说 `'__local__'` 就是一个普通的非空字符串，所有"是否提供 id"的判定全部失效。

### 1.1 driver 选择被破坏

`drivers/index.ts::pickDriver` 的"无 id → LocalLockDriver"判定是：

```ts
if (!isString(id) || id.length === 0) {
  return createLocalLockDriver(buildDriverDeps(args, false, false));
}
```

`'__local__'` 是非空字符串 → 这条短路分支**不命中**。后续按 `mode` 分派：

| 用户传入                                   | 实际选中的 driver           | 期望                            |
| ------------------------------------------ | --------------------------- | ------------------------------- |
| `mode: 'web-locks'`                        | WebLocksDriver（跨 Tab）    | LocalLockDriver（仅本进程）     |
| `mode: 'broadcast'`                        | BroadcastDriver（跨 Tab）   | LocalLockDriver                 |
| `mode: 'storage'`                          | StorageDriver（跨 Tab）     | LocalLockDriver                 |
| `mode: 'auto'` 默认值（浏览器有 nav.locks）| WebLocksDriver              | LocalLockDriver                 |
| 用户提供 `adapters.getLock`                | CustomDriver，id=`__local__`| CustomDriver，id=`undefined`    |

更糟的是：**两个不同的"无 id"实例 + `mode='web-locks'`**，会把锁名都拼成
`${LOCK_PREFIX}:__local__`（详见 `drivers/index.ts::buildDriverDeps` 的 fallback），
**串到同一把跨 Tab 锁上**，互相阻塞 / 抢占，破坏"无 id 实例之间彼此隔离"的契约。

### 1.2 `syncMode='storage-authority'` 被意外启用

`createEntryFactory` 内：

```ts
const authorityReady =
  syncMode === 'storage-authority' ? attachAuthority(mutableEntry, options, adapters, id) : null;
```

只要用户传了 `syncMode: 'storage-authority'`（即便没传 id），`id` 现在是 `'__local__'`，
就会走进 `attachAuthority`：

- `getAuthority({ id: '__local__' })` / `getChannel({ id: '__local__', channel: 'session' })`
  / `getSessionStore({ id: '__local__' })` 都会被调用
- 三者落到同一个 `__local__` 命名空间 → **所有"无 id + storage-authority"的实例
  共用同一份 storage key**，跨 Tab 互相覆盖 rev 与 snapshot
- `Entry.authority !== null` 之后，`Actions` 走 authority 提交链路（带 token 序号化），
  这条链路本来就假设有真实 id 持久化协调，无 id 场景下没有任何意义

### 1.3 `actions.ts` 拼 driver acquire `name` 时再次泄漏

`core/actions.ts:425` 在调用 `entry.driver.acquire(...)` 时把 `name` 字段拼成
`${LOCK_PREFIX}:${entry.id}`：

```ts
const handle = await entry.driver.acquire({
  // ...
  name: `${LOCK_PREFIX}:${entry.id}`,
  // ...
});
```

无 id 场景下 `entry.id === '__local__'`，于是 `LockDriverContext.name` 会变成
`${LOCK_PREFIX}:__local__`：

- 如果 driver 已经是 LocalLockDriver（修复方案落地后），driver 内部不依赖这个 name，
  问题被掩盖
- 如果用户传了 `adapters.getLock`（CustomDriver），用户实现拿到的就是这个伪 name，
  会以为是真实锁名 —— **泄漏没有被根治**

### 1.4 错误信息 / 日志混淆

`registry.ts::createFailedInitError` 拼出的错误是
`lockData id=__local__ initialization failed`，用户看到会以为自己传了 `id: '__local__'`，
排查方向被带偏。

---

## 2. 候选方案权衡

### 方案 A：在下游用字符串 sentinel 判别（`id !== '__local__'`）

❌ 不可取：

- `'__local__'` 一旦被当成 sentinel，用户**绝对不能**传 `id: '__local__'`，否则两个语义撞车
- 字符串 sentinel 对类型系统不可见，调用方无法静态保证不撞车
- 多个下游（driver、authority、错误消息）每处都要重复这个 sentinel 判别，散落且易漏

### 方案 B：`acquireStandalone` 强制 `mode='local'` + 不启用 authority

❌ 不可取：

- 治标不治本：`'__local__'` 仍被当真实 id 喂给 CustomDriver / 日志 / 错误消息
- 与 `mode` 显式校验冲突 —— 用户传 `mode: 'web-locks'` 时是该 warn / 抛错，
  还是默默改成 `'local'`？语义不清
- `attachAuthority` 的关闭条件还需要单独打补丁，逻辑更分散

### 方案 C ✅：拆分 `Entry.id`（展示） / `Entry.lockId`（语义判定）— **选定**

核心想法：

- `Entry.id: string` —— 仍是稳定的"展示用占位"。无 id 场景填 `'__local__'`，
  日志、错误消息、Registry slot key 全部继续用它（Registry 路径下永远是真实 id；
  standalone 路径不进 Registry，所以 `'__local__'` 也不会和真实 id 撞 key）
- `Entry.lockId: string | undefined` —— **真实 id**。无 id 场景为 `undefined`：
  - `pickDriver({ id: lockId })` → 看到 `undefined`，走 LocalLockDriver
  - `attachAuthority` 的启用条件加 `lockId !== undefined`
  - driver `LockDriverDeps.id` 透传 `lockId`，CustomDriver / 日志拿到的就是真实值

这样既保留了"非空 id 字段"的稳定文本输出，又让所有"是否有真实 id"的判定都通过
显式的 `undefined` 断言完成，类型系统直接卡住。

---

## 3. 实施细节

### 3.1 `core/registry.ts`

#### Entry 类型加 `lockId`

```ts
interface Entry<T extends object> {
  /** 锁 id；展示 / Registry key 用，standalone 路径为占位 '__local__' */
  readonly id: string;
  /**
   * 真实锁 id；用于"是否启用跨 Tab 能力"的语义判定
   *
   * - Registry 路径：与 `id` 同值（必为非空字符串）
   * - Standalone（无 id）路径：`undefined`，由此驱动 `pickDriver` 走 LocalLockDriver、
   *   `syncMode='storage-authority'` 不启用 authority
   *
   * **重要**：永远不要拿 `id` 去做"是否有真实 id"的判定 —— `id` 在 standalone 路径
   * 是占位字符串，会让下游误以为存在真实 id
   */
  readonly lockId: string | undefined;
  // ... 其余字段不变
}
```

#### EntryFactory 签名加 `lockId`

```ts
type EntryFactory<T extends object> = (
  id: string,
  lockId: string | undefined,
  options: LockDataOptions<T>,
  ctx: EntryFactoryContext,
) => Entry<T>;
```

#### Registry 调用 factory 时把 id 同时作为 lockId 透传

`registry.ts::getOrCreateEntry` 内调 factory 的位置（当前 line 277）：

```ts
// before
const entry = factory(id, options, { registerTeardown });

// after：第二个参数是 lockId；Registry 路径下永远等于 id（非空字符串约束已在
// getOrCreateEntry 入口的 `if (id.length === 0) throw` 保证）
const entry = factory(id, id, options, { registerTeardown });
```

`__resetDefaultRegistry` / `peek` / `releaseEntry` 等其他 Registry API 完全不接触
`Entry.id` / `lockId` / factory 签名，无需调整。

### 3.2 `core/entry.ts::createEntryFactory`

用 `lockId` 替换所有"是否有真实 id"的语义判定点：

```ts
function createEntryFactory<T extends object>(initial: T | undefined): EntryFactory<T> {
  return (id, lockId, options, ctx): Entry<T> => {
    const adapters = pickDefaultAdapters<T>(options.adapters);
    // ...
    // pickDriver 看到 undefined → LocalLockDriver；非空字符串 → 按 mode 分派
    const driver = pickDriver<T>({ adapters, options, id: lockId });
    // ...
    const mutableEntry: MutableEntry<T> = {
      id,
      lockId,
      data: initialPatch.data,
      driver,
      adapters,
      authority: null,
      // ...
    };

    const syncMode = normalizeSyncMode(options.syncMode);
    // 关键改动：原来的 `id` 在 standalone 路径是 '__local__'（非空），会错误地启用 authority
    // 改成显式判 `lockId !== undefined`，无真实 id 场景永远不启用 authority
    const authorityReady =
      syncMode === 'storage-authority' && lockId !== undefined
        ? attachAuthority(mutableEntry, options, adapters, lockId)
        : null;
    // ...
  };
}
```

### 3.3 `core/entry.ts::acquireStandalone`

```ts
function acquireStandalone<T extends object>(
  options: LockDataOptions<T>,
  factory: EntryFactory<T>,
): { entry: Entry<T>; releaseFromRegistry: () => void } {
  // ... teardowns / alive / registerTeardown 不变

  // 关键改动：展示用 id 仍用 '__local__' 占位，但真实 id 显式传 undefined
  // 让 createEntryFactory 内部走"无真实 id"分支：
  //   - pickDriver → LocalLockDriver（不会被 mode='web-locks' 等强制起跨 Tab driver）
  //   - syncMode='storage-authority' → 不启用 authority
  const entry = factory('__local__', undefined, options, { registerTeardown });

  // ... release / 返回值不变
}
```
### 3.4 `core/entry.ts::acquireFromRegistry` 不需要改

`acquireFromRegistry` 自身只调 `registry.getOrCreateEntry(id, options, factory)`，
factory 的双 id 透传发生在 `registry.ts::getOrCreateEntry` 内部（见 §3.1 末尾）。
外层 `acquireFromRegistry` 不感知签名变化。

### 3.5 `core/actions.ts`：driver acquire 的 `name` 来源改用 `lockId`

当前 `actions.ts:425`：

```ts
const handle = await entry.driver.acquire({
  // ...
  name: `${LOCK_PREFIX}:${entry.id}`,
  // ...
});
```

无 id 场景下 `entry.id === '__local__'`，会让 driver 拿到伪 name（详见 §1.3）。

修复：用 `entry.lockId` 优先；无 lockId 场景下沿用 driver 构造期已经定下的"展示 name"
fallback（与 `drivers/index.ts::buildDriverDeps` 的 `${LOCK_PREFIX}:__local__` 保持一致），
集中表达成一个 helper：

```ts
function buildAcquireName(entry: Entry<unknown>): string {
  return entry.lockId !== undefined
    ? `${LOCK_PREFIX}:${entry.lockId}`
    : `${LOCK_PREFIX}:__local__`;
}
```

调用点改为：

```ts
const handle = await entry.driver.acquire({
  // ...
  name: buildAcquireName(entry),
  // ...
});
```

`token` / `disposeToken` 仍用 `entry.id` 作可读前缀（纯展示，不影响语义），保留不动。

### 3.6 driver / authority / fanout / readonly-view 不变

- `drivers/index.ts::pickDriver` / `buildDriverDeps` 完全不动 ——
  原来 `name = id ? ... : '${LOCK_PREFIX}:__local__'` 的 fallback 在
  LocalLockDriver 路径下仍然命中（此时入参 id 已是 `undefined`）
- `attachAuthority` 内部完全不动；启用与否的判定收敛在 `createEntryFactory` 单点
- `core/fanout.ts` / `core/readonly-view.ts` 不接触 `entry.id` / `entry.lockId`，零改动
- `core/actions.ts` 其余位置：`entry.id` 仅用于 token 可读前缀 / 错误消息，保留不动
---

## 4. 关键设计点

1. **`lockId` 是"是否有真实 id"的唯一权威**。任何后续新增"跨 Tab 能力"的代码
   都必须基于 `entry.lockId !== undefined` 判定，**禁止**回退到 `entry.id`。
2. **`id` 字段保持非空字符串**，不引入 `string | undefined`。这样所有日志 / 错误信息
   零改动，对外契约（错误消息格式、`id=` 前缀）保持稳定。
3. **`'__local__'` 仍只是 standalone 路径的展示占位**，不再被任何下游当作真实 id
   消费。即便用户 *碰巧* 传了 `id: '__local__'` 也不会和 standalone 路径撞 ——
   Registry 路径下 `lockId === '__local__'` 是真实 id，driver / authority 会按真实 id
   语义工作；standalone 路径下 `lockId === undefined`，两条路径在语义层完全分离。
4. **类型层强制**：`EntryFactory` 签名变成 `(id: string, lockId: string | undefined, ...)`,
   外部调用方即便忘记拆分也会触发 TS 编译错误，避免回归。

---

## 5. 测试用例索引

### 5.1 新增 `__test__/core/entry-standalone-driver-isolation.node.test.ts`

node 环境（`navigator.locks` / `BroadcastChannel` / `localStorage` 都不可用），
覆盖以下用例：

1. **无 id + `mode: 'web-locks'`**：`lockData(initial, { mode: 'web-locks' })`
   不抛"web-locks unavailable"错误（证明根本没尝试起 WebLocksDriver）；
   通过 stub `adapters.getLock` 不被调用 + 正常 acquire 间接验证 driver 是 LocalLockDriver
2. **无 id + `syncMode: 'storage-authority'`**：`lockData(initial, { syncMode: 'storage-authority' })`
   不会启用 authority；通过 stub `adapters.getAuthority` / `getChannel` /
   `getSessionStore` 验证全程零调用
3. **无 id + `adapters.getLock`**：用户提供的 `getLock` 被调用时，
   入参 `ctx.id === undefined`（而不是 `'__local__'`）
4. **无 id + driver acquire name**：用户的 `getLock` 拿到的 `name`
   来自 `buildAcquireName` fallback（`${LOCK_PREFIX}:__local__`），
   与 driver 构造期 `LockDriverDeps.name` 一致 —— 验证 §3.5 修复落地
5. **两个无 id 实例并发持锁互不干扰**：A.update / B.update 顺序穿插，
   不会因为"假共享锁名"被阻塞 / 抢占（核心：每个 standalone 实例自己独占的
   LocalLockDriver 实例，互不知晓）

### 5.2 新增 `__test__/core/entry-standalone-driver-isolation.browser.test.ts`

仅放需要浏览器能力的用例：

6. **回归保证**：有真实 id 的实例传 `mode: 'web-locks'` 仍按预期起 WebLocksDriver
   （证明拆分没有误伤正常路径；通过 navigator.locks API 副作用观察）

### 5.3 现有 `__test__/core/registry.node.test.ts` 需要适配新 factory 签名

grep 显示有以下 stub factory 写法 `EntryFactory<...> = (id, options, ctx) => ...` 需要更新：

- `buildFactory<T>(...)` 内的工厂构造（line 84 附近）
- 单测 inline factory：line 244 / 262 / 322 / 363 / 380 / 398 / 402

全部需要改成 `(id, lockId, options, ctx) => ...`，stub 行为不变（只多接收一个参数）。
建议在 `buildFactory` 处补一条 `expect(lockId).toBe(id)` 断言，确保 Registry 路径下
两者同值（防回归）。

`__test__/core/registry.node.test.ts:433` 的 `failingFactory: EntryFactory<...> = () => { throw ... }`
不解构入参，零修改即可继续工作（TS 允许函数实参少于签名）。

---

## 6. 兼容性

- `Entry` / `EntryFactory` 都是 internal type，无外部契约变更
- 公共 API（`lockData` / `LockDataActions` / `LockDataResult` / `LockDataOptions`）
  零变更
- 错误消息文案不变（仍是 `id=__local__` 在无 id 场景）—— 后续可在另外的小改动里
  把 standalone 错误消息改成 `id=<standalone>` 或类似；不在本次范围内
