/**
 * 事务式 Draft：锁持有期间对底层 data 的可写代理
 *
 * 实现要点（对应 RFC.md「事务式 Draft」「Draft Proxy 行为」）：
 * - set / deleteProperty 同时：① push 到 mutation log ② 原地写入 target ③ 在 snapshot 中首次记录 prevValue
 * - validity 置否（revoke / abort / recipe 结束）后任何写入立即抛 LockRevokedError
 * - 惰性子代理：get 到对象 / 数组时递归构造子 draft，共享同一 ctx，路径前缀累加
 * - rollback 按 snapshot 逆序 + prevValue 恢复 target，避免整树深拷贝
 *
 * ----------------------------------------------------------------
 * **JSON-only 契约**（重要）
 *
 * Draft 仅支持 JSON 安全类型：plain object / array / string / number（不含 NaN/Infinity）/
 * boolean / null。**禁止** Set / Map / Date / RegExp / class 实例 / function / symbol /
 * bigint / undefined / 循环引用 等。
 *
 * 历史版本曾对 Set / Map 提供 collection proxy 跟踪，但「`map.get(key)` 取出的对象引用
 * 直接深改」会绕过 proxy trap，事务的 commit / rollback 语义会被静默破坏。lock-data 的
 * 数据本身要参与跨 Tab 同步与持久化序列化，集合类型在 JSON 上下文里只会持续制造类似缺陷，
 * 因此从设计上移除支持，并在入口与每次写入处显式校验。
 * ----------------------------------------------------------------
 *
 * ----------------------------------------------------------------
 * MIGRATION NOTE（对应 RFC.md 决策 #32 「外部化前瞻」）：
 *   当前实现 self-contained，不对外导出。未来若出现第二个使用者（表单草稿 /
 *   乐观更新 / 编辑器临时操作等），可按 RFC 预留的通用化 API 骨架
 *   （shared/transactional-draft）抽离；lock-data 用薄适配层接回。
 * ----------------------------------------------------------------
 */

import { throwError } from '@/shared/throw-error';
import { ERROR_FN_NAME } from '../constants';
import { LockRevokedError } from '../errors';
import type { LockDataMutation } from '../types';

/** Draft 自身的有效性开关；置 false 后写入立即抛错 */
interface DraftValidity {
  isValid: boolean;
}

/**
 * snapshot 条目：仅记录普通属性的首次写入 prevValue，用于 `Reflect.set` /
 * `deleteProperty` 逆向恢复
 */
interface DraftSnapshotEntry {
  target: object;
  key: PropertyKey;
  existed: boolean;
  prevValue: unknown;
}

type DraftSnapshot = Map<string, DraftSnapshotEntry>;

interface DraftContext {
  readonly validity: DraftValidity;
  readonly mutations: LockDataMutation[];
  readonly snapshot: DraftSnapshot;
}

/**
 * 事务式 Draft 会话句柄
 *
 * **JSON-only 契约**：仅支持 plain object / array / string / number（不含 NaN/Infinity）/
 * boolean / null。传入或后续写入 Set / Map / Date / RegExp / class 实例 / function /
 * symbol / bigint / undefined / 循环引用 会抛 `TypeError`。
 */
interface DraftSession<T extends object> {
  readonly draft: T;
  readonly mutations: readonly LockDataMutation[];
  commit: () => readonly LockDataMutation[];
  rollback: () => void;
  dispose: () => void;
}

function isPlainAccessible(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * 判定某个对象是否为「plain object」：
 * - prototype 是 `Object.prototype`（普通字面量 / `new Object()`）
 * - prototype 是 `null`（`Object.create(null)`）
 *
 * 不使用 `instanceof Object`：跨 realm（iframe / worker）会失败
 *
 * 用 type predicate 收窄返回类型，匹配 biome `noMisleadingReturnType` 规则
 */
function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 把路径片段格式化为 `'a.b[0].c'` 风格的字符串，用于错误信息
 *
 * 顶层时返回 `'<root>'` 以避免空字符串歧义
 */
function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return '<root>';
  }
  let formatted = '';
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    if (typeof segment === 'number' || (typeof segment === 'string' && /^\d+$/u.test(segment))) {
      formatted += `[${String(segment)}]`;
      continue;
    }
    formatted += i === 0 ? String(segment) : `.${String(segment)}`;
  }
  return formatted;
}

/**
 * 描述非 JSON 值的具体类型，用于错误信息
 *
 * 例：`Set` / `Map` / `Date` / `class instance (Foo)` / `function` / `bigint` / `NaN`
 */
function describeNonJsonValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return 'NaN';
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? 'Infinity' : '-Infinity';
    }
  }
  const primitiveType = typeof value;
  if (primitiveType !== 'object') {
    // bigint / symbol / function
    return primitiveType;
  }
  if (value === null) {
    return 'null';
  }
  // toString tag 形如 `[object Map]` → `Map`
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (tag !== 'Object') {
    return tag;
  }
  const ctor = (value as object).constructor;
  if (ctor && ctor !== Object && typeof ctor.name === 'string' && ctor.name.length > 0) {
    return `class instance (${ctor.name})`;
  }
  return 'non-plain object';
}

/**
 * 校验值是否为 JSON 安全类型；遇到非法值 / 循环引用立即抛 `TypeError`
 *
 * 允许：string / number（不含 NaN/Infinity）/ boolean / null / plain object / array
 * 禁止：undefined / bigint / symbol / function / Set / Map / Date / RegExp / class 实例 /
 *       TypedArray / WeakMap / WeakSet / 循环引用 等
 *
 * `seen` 仅跟踪当前路径上访问过的容器（递归回溯时 `delete`），保证「同一兄弟节点的相同
 * 引用」不会被误判为环。
 */
function assertJsonSafe(value: unknown, path: readonly PropertyKey[], seen: WeakSet<object>): void {
  if (value === null) {
    return;
  }
  if (value === undefined) {
    throwError(
      ERROR_FN_NAME,
      `draft only supports JSON-safe values, got "undefined" at "${formatPath(path)}" (use "null" instead)`,
      TypeError,
    );
  }
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'boolean') {
    return;
  }
  if (valueType === 'number') {
    if (!Number.isFinite(value as number)) {
      throwError(
        ERROR_FN_NAME,
        `draft only supports JSON-safe values, got "${describeNonJsonValue(value)}" at "${formatPath(path)}"`,
        TypeError,
      );
    }
    return;
  }
  if (valueType !== 'object') {
    // bigint / symbol / function
    throwError(
      ERROR_FN_NAME,
      `draft only supports JSON-safe values, got "${describeNonJsonValue(value)}" at "${formatPath(path)}"`,
      TypeError,
    );
  }
  // 此处 value 必为非 null object
  const obj = value as object;
  if (seen.has(obj)) {
    throwError(ERROR_FN_NAME, `draft detected cyclic reference at "${formatPath(path)}"`, TypeError);
  }
  if (Array.isArray(obj)) {
    seen.add(obj);
    for (let i = 0; i < obj.length; i++) {
      assertJsonSafe((obj as unknown[])[i], [...path, i], seen);
    }
    seen.delete(obj);
    return;
  }
  if (!isPlainObject(obj)) {
    throwError(
      ERROR_FN_NAME,
      `draft only supports JSON-safe values (plain object / array / string / number / boolean / null), got "${describeNonJsonValue(obj)}" at "${formatPath(path)}"`,
      TypeError,
    );
  }
  seen.add(obj);
  // 仅校验自身可枚举字符串键（与 JSON.stringify 行为一致；symbol 键被 JSON 忽略此处直接拒绝）
  const symbolKeys = Object.getOwnPropertySymbols(obj);
  if (symbolKeys.length > 0) {
    throwError(
      ERROR_FN_NAME,
      `draft only supports JSON-safe values, got symbol-keyed property at "${formatPath(path)}"`,
      TypeError,
    );
  }
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    assertJsonSafe((obj as Record<string, unknown>)[key], [...path, key], seen);
  }
  seen.delete(obj);
}

/**
 * 为"首次属性写入"的路径记录 prevValue
 *
 * 使用 `${target-id}.${key}` 作为去重键：同一路径被多次覆写时只记录最早的 prevValue，
 * 保证 rollback 能恢复到 recipe 开始前的状态
 */
function capturePropertySnapshotOnce(
  snapshot: DraftSnapshot,
  target: object,
  key: PropertyKey,
  targetId: string,
): void {
  const snapshotKey = `${targetId}::${String(key)}`;
  if (snapshot.has(snapshotKey)) {
    return;
  }
  const existed = Object.hasOwn(target, key);
  const prevValue = existed ? Reflect.get(target, key) : undefined;
  snapshot.set(snapshotKey, { target, key, existed, prevValue });
}

function ensureWritable(validity: DraftValidity): void {
  if (!validity.isValid) {
    // `ErrorConstructor` 接口同时要求「可 new 调用」和「可直接调用」两种签名，
    // 而 class 语法定义的子类不支持无 new 直接调用，故在调用点做一次类型适配
    throwError(
      ERROR_FN_NAME,
      'draft is no longer valid (lock revoked / aborted)',
      LockRevokedError as unknown as ErrorConstructor,
    );
  }
}

function createDraftProxy<T extends object>(
  target: T,
  ctx: DraftContext,
  parentPath: readonly PropertyKey[],
  targetId: string,
): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver);
      if (!isPlainAccessible(value)) {
        return value;
      }
      // 为每一层子对象派生稳定 id，保证同一路径 get 到的子 draft 在 snapshot 中去重一致
      const childTargetId = `${targetId}::${String(key)}`;
      return createDraftProxy(value, ctx, [...parentPath, key], childTargetId);
    },
    set(obj, key, value) {
      ensureWritable(ctx.validity);
      // 入口已校验过 target，但 recipe 内的赋值 value 可能是任意类型，必须重新校验。
      // 在写入前抛错可保证 target / mutations / snapshot 不被污染（fail-fast）
      assertJsonSafe(value, [...parentPath, key], new WeakSet());
      capturePropertySnapshotOnce(ctx.snapshot, obj, key, targetId);
      ctx.mutations.push({ path: [...parentPath, key], op: 'set', value });
      return Reflect.set(obj, key, value);
    },
    deleteProperty(obj, key) {
      ensureWritable(ctx.validity);
      capturePropertySnapshotOnce(ctx.snapshot, obj, key, targetId);
      ctx.mutations.push({ path: [...parentPath, key], op: 'delete' });
      return Reflect.deleteProperty(obj, key);
    },
  });
}

/**
 * 按 snapshot 逆序恢复 target
 *
 * 逆序的意义：晚写入的路径可能依赖早写入的父节点存在；逆序能保证恢复顺序正确。
 * 按记录的 existed / prevValue 逐条写回或删除即可。
 */
function applyRollback(snapshot: DraftSnapshot): void {
  const entries = Array.from(snapshot.values()).reverse();
  // 数组遍历优先使用索引 for 循环（见 IMPLEMENTATION.md 开发守则「代码风格 - 循环形式」）
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.existed) {
      Reflect.set(entry.target, entry.key, entry.prevValue);
      continue;
    }
    Reflect.deleteProperty(entry.target, entry.key);
  }
}

function freezeMutations(mutations: LockDataMutation[]): readonly LockDataMutation[] {
  const frozen = mutations.map((mutation) => Object.freeze({ ...mutation, path: Object.freeze([...mutation.path]) }));
  return Object.freeze(frozen);
}

/**
 * 创建一个事务式 Draft 会话
 *
 * **JSON-only 契约**：`target` 及后续所有写入值必须是 JSON 安全类型 ——
 * plain object / array / string / number（不含 NaN/Infinity）/ boolean / null。
 * 传入 Set / Map / Date / RegExp / class 实例 / function / symbol / bigint /
 * undefined / 循环引用 等会立即抛 `TypeError`。
 *
 * 集合类容器（Set / Map）虽常用，但其内部对象引用读取会绕过 proxy trap 导致
 * 事务的 commit / rollback 语义被静默破坏；lock-data 的数据本身要参与跨 Tab
 * 同步与持久化序列化，故从设计上仅允许 JSON 安全类型。如果业务层确有 Set / Map
 * 语义需求，建议改用：`Set<T>` → `T[]`（去重逻辑放在 recipe 内）；
 * `Map<K, V>` → `Record<string, V>` 或 `{ key: K; value: V }[]`。
 *
 * @param target - 待包装的可变对象，必须是 JSON 安全的 plain object 或 array
 * @throws {TypeError} target 包含非 JSON 安全类型 / 循环引用 时抛出
 */
function createDraftSession<T extends object>(target: T): DraftSession<T> {
  // 入口校验：fail-fast 拒绝非 JSON 数据，避免后续操作产生不可回滚的副作用
  assertJsonSafe(target, [], new WeakSet());
  const ctx: DraftContext = {
    validity: { isValid: true },
    mutations: [],
    snapshot: new Map(),
  };
  const draft = createDraftProxy(target, ctx, [], 'root');

  const commit = (): readonly LockDataMutation[] => {
    ensureWritable(ctx.validity);
    ctx.validity.isValid = false;
    return freezeMutations(ctx.mutations);
  };

  const rollback = (): void => {
    applyRollback(ctx.snapshot);
    ctx.validity.isValid = false;
    ctx.mutations.length = 0;
    ctx.snapshot.clear();
  };

  const dispose = (): void => {
    ctx.validity.isValid = false;
  };

  return {
    draft,
    get mutations() {
      return ctx.mutations as readonly LockDataMutation[];
    },
    commit,
    rollback,
    dispose,
  };
}

export type { DraftSession };
export { createDraftSession };
