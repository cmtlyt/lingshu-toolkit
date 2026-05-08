/**
 * lock-data 模块的 JSON 安全校验工具
 *
 * 设计动机：wrapper 方案下所有进入 `entry.dataRef.current` 的值都必须是 JSON 安全的，
 * 否则 `JSON.parse(JSON.stringify(...))` 会静默丢失 Set / Map / Date / class instance / undefined 等
 *
 * 边界一致：
 * - getValue resolve 后入口走 `assertJsonSafe(awaited, ...)` fail-fast
 * - actions.replace(next) 入口走 `assertJsonSafe(next, ...)` fail-fast
 * - draft.ts 的写入路径同样复用本模块的 assertJsonSafe（共享同一份语义）
 *
 * 顶层数组在类型层（`LockDataValueShape<T>`）已被排除为 `never`；运行时通过
 * `assertNotTopLevelArray` 双重 fail-fast 拦截类型擦除路径下的误用
 *
 * 对应 fixes/api-getvalue-only-redesign.md §14.4 / RFC.md「JSON 安全契约」章节
 */

import { throwError } from '@/shared/throw-error';
import { ERROR_FN_NAME } from '../constants';
import { InvalidOptionsError } from '../errors';

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
 * 校验值是否为 JSON 安全类型；遇到非法值 / 循环引用立即抛 `TypeError`
 *
 * 允许：string / number（不含 NaN/Infinity）/ boolean / null / plain object / array
 * 禁止：undefined / bigint / symbol / function / Set / Map / Date / RegExp / class 实例 /
 *       TypedArray / WeakMap / WeakSet / 循环引用 等
 *
 * `seen` 仅跟踪当前路径上访问过的容器（递归回溯时 `delete`），保证「同一兄弟节点的相同
 * 引用」不会被误判为环
 *
 * @param subject 错误信息中的来源描述（如 `'getValue() result'` / `'actions.replace(next)'` / `'draft'`）
 */
function assertJsonSafe(value: unknown, path: readonly PropertyKey[], seen: WeakSet<object>, subject: string): void {
  if (value === null) {
    return;
  }
  if (value === undefined) {
    throwError(
      ERROR_FN_NAME,
      `${subject} only supports JSON-safe values, got "undefined" at "${formatPath(path)}" (use "null" instead)`,
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
        `${subject} only supports JSON-safe values, got "${describeNonJsonValue(value)}" at "${formatPath(path)}"`,
        TypeError,
      );
    }
    return;
  }
  if (valueType !== 'object') {
    // bigint / symbol / function
    throwError(
      ERROR_FN_NAME,
      `${subject} only supports JSON-safe values, got "${describeNonJsonValue(value)}" at "${formatPath(path)}"`,
      TypeError,
    );
  }
  // 此处 value 必为非 null object
  const obj = value as object;
  if (seen.has(obj)) {
    throwError(ERROR_FN_NAME, `${subject} detected cyclic reference at "${formatPath(path)}"`, TypeError);
  }
  if (Array.isArray(obj)) {
    seen.add(obj);
    for (let i = 0; i < obj.length; i++) {
      assertJsonSafe((obj as unknown[])[i], [...path, i], seen, subject);
    }
    seen.delete(obj);
    return;
  }
  if (!isPlainObject(obj)) {
    throwError(
      ERROR_FN_NAME,
      `${subject} only supports JSON-safe values (plain object / array / string / number / boolean / null), got "${describeNonJsonValue(obj)}" at "${formatPath(path)}"`,
      TypeError,
    );
  }
  seen.add(obj);
  // 仅校验自身可枚举字符串键（与 JSON.stringify 行为一致；symbol 键被 JSON 忽略此处直接拒绝）
  const symbolKeys = Object.getOwnPropertySymbols(obj);
  if (symbolKeys.length > 0) {
    throwError(
      ERROR_FN_NAME,
      `${subject} only supports JSON-safe values, got symbol-keyed property at "${formatPath(path)}"`,
      TypeError,
    );
  }
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    assertJsonSafe((obj as Record<string, unknown>)[key], [...path, key], seen, subject);
  }
  seen.delete(obj);
}

/**
 * 顶层数组运行时拒绝（fail-fast）
 *
 * 类型层已通过 `LockDataValueShape<T> = T extends readonly unknown[] ? never : T` 排除，
 * 本函数仅作类型擦除路径下的最后一道防线 —— 抛 `InvalidOptionsError`
 *
 * @param value 待检查的值
 * @param subject 错误信息中的来源描述（如 `'getValue() result'` / `'actions.replace(next)'`）
 */
function assertNotTopLevelArray(value: unknown, subject: string): void {
  if (Array.isArray(value)) {
    throwError(
      ERROR_FN_NAME,
      `${subject} must not return an array; lockData rejects top-level arrays (wrap in object {} instead)`,
      InvalidOptionsError as unknown as ErrorConstructor,
    );
  }
}

/**
 * JSON 拷贝隔离：把任意 JSON 安全的值深拷贝为全新引用
 *
 * 调用方必须保证 input 已通过 `assertJsonSafe` —— 本函数不做校验，直接 `JSON.parse(JSON.stringify(...))`
 *
 * 用途：
 * - `entry.dataRef.current = cloneByJson(getValue 返回值)`：getValue 与内部状态隔离
 * - `entry.dataRef.current = cloneByJson(committedNext)`：commit 与 draft 隔离
 * - `actions.snapshot() = cloneByJson(entry.dataRef.current)`：调用方与内部状态隔离
 * - `commitEvent.snapshot = cloneByJson(entry.dataRef.current)`：listener 与内部状态隔离
 */
function cloneByJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 入口便捷封装：组合 `assertNotTopLevelArray` + `assertJsonSafe`
 *
 * 用于 getValue / actions.replace 等"外部入参"边界的统一 fail-fast：
 * 1. 顶层数组判定（双重 fail-fast 的运行时一道）
 * 2. 整体 JSON 安全校验
 *
 * 同步链路抛 `InvalidOptionsError`（顶层数组）/ `TypeError`（其他非 JSON-safe），
 * 调用方拿到错误后应原样向上抛
 */
function assertJsonSafeInput(value: unknown, subject: string): void {
  assertNotTopLevelArray(value, subject);
  assertJsonSafe(value, [], new WeakSet<object>(), subject);
}

export { assertJsonSafe, assertJsonSafeInput, assertNotTopLevelArray, cloneByJson };
