/**
 * 深只读代理：用户从 lockData 拿到的第一个返回值
 *
 * 实现要点（wrapper Proxy 方案，对应 RFC.md「ReadonlyView<T>」+「引用稳定契约」章节）：
 *
 * - **wrapper Proxy**：顶层 view 是 `new Proxy(dataRef, ROOT_HANDLER)`，target 为
 *   稳定 `dataRef = { current: T }` 引用；handler 把所有 trap 重定向到 `dataRef.current`
 *   - 引用稳定：`dataRef` 引用在 Entry 生命周期内永不变更
 *   - 跟随重新赋值：commit / `applyRemote` / 异步 getValue resolve 时 `dataRef.current` 重新赋值，
 *     view 上后续读取自动看到最新值，无需重建 Proxy
 *
 * - **嵌套递归**：get 到对象类型的属性时，惰性创建嵌套 readonly Proxy
 *   - 嵌套节点直接代理 `T` 类型的子对象（不需要 wrapper 间接层）
 *   - WeakMap<object, Proxy> 缓存：同一子对象多次访问拿到同一代理，引用比较有效
 *
 * - **写拦截**：set / deleteProperty / defineProperty / setPrototypeOf 统一抛 `ReadonlyMutationError`
 *
 * - **JSON-safe 契约**：本期 lockData 强制数据为 JSON 安全（getValue / replace 入口由
 *   `assertJsonSafe` 校验），故 readonly-view 不再处理 Set / Map / Date / class instance
 *   等非 JSON 类型；仅需处理 plain object / array
 *
 * - **顶层数组禁止**：`dataRef.current` 在类型层（`LockDataValueShape<T>`）+ 运行时
 *   （`assertNotTopLevelArray`）双重排除顶层数组，wrapper 方案下 `Object.keys` /
 *   `JSON.stringify` 等不变量冲突自然消失
 *
 * - **判型一致性瑕疵**：`Object.isFrozen(view)` 返回 `false`（因为 target 是 wrapper
 *   对象不是 frozen 的），但用户对 view 任何写入操作都会被 trap 拒绝抛 `ReadonlyMutationError`。
 *   这是 wrapper 方案的轻微语义瑕疵，判定只读应通过约定（"由 lockData 返回的 view 必只读"）
 */

import { throwError } from '@/shared/throw-error';
import { isObject, isUndef } from '@/shared/utils';
import { ERROR_FN_NAME } from '../constants';
import { ReadonlyMutationError } from '../errors';

const READONLY_CACHE = new WeakMap<object, object>();

function rejectMutation(): never {
  // `ErrorConstructor` 接口同时要求「可 new 调用」和「可直接调用」两种签名，
  // 而 class 语法定义的子类不支持无 new 直接调用，故在调用点做一次类型适配
  throwError(ERROR_FN_NAME, 'cannot mutate readonly view', ReadonlyMutationError as unknown as ErrorConstructor);
}

/**
 * 嵌套节点 handler：递归代理 plain object / array 子节点
 *
 * 不再处理 Set / Map / Date / class instance（JSON-safe 契约已在入口拒绝）
 */
const NESTED_HANDLER: ProxyHandler<object> = {
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (isObject(value)) {
      return createNestedView(value);
    }
    return value;
  },
  set: rejectMutation,
  deleteProperty: rejectMutation,
  defineProperty: rejectMutation,
  setPrototypeOf: rejectMutation,
};

function createNestedView<T extends object>(target: T): T {
  const cached = READONLY_CACHE.get(target);
  if (!isUndef(cached)) {
    return cached as T;
  }
  const proxy = new Proxy(target, NESTED_HANDLER) as T;
  READONLY_CACHE.set(target, proxy);
  return proxy;
}

/**
 * wrapper 引用：每个 Entry 持有一个稳定的 `{ current: T }`，view Proxy 以此为 target
 *
 * - `current` 在 commit / `applyRemote` / 异步 getValue resolve 时重新赋值
 * - view Proxy 通过 ROOT_HANDLER 把所有 trap 重定向到 `current`
 */
interface DataRef<T extends object> {
  current: T;
}

/**
 * 顶层 view 的 handler：所有 trap 重定向到 `dataRef.current`
 *
 * 注意：顶层 trap 拿到的 `target` 是 `dataRef` wrapper（不是 `T`），
 * 所以必须先解 `dataRef.current` 再做实际的属性操作 / 类型判定
 */
const ROOT_HANDLER: ProxyHandler<DataRef<object>> = {
  get(target, key) {
    // 不传 receiver 给底层：避免 receiver 是 wrapper Proxy 触发的 invariant 检查
    // 所有读取以 `dataRef.current` 为来源，与 commit 后的最新值同步
    const value = Reflect.get(target.current, key);
    if (isObject(value)) {
      return createNestedView(value);
    }
    return value;
  },
  set: rejectMutation,
  deleteProperty: rejectMutation,
  defineProperty: rejectMutation,
  setPrototypeOf: rejectMutation,
  // has / ownKeys / getOwnPropertyDescriptor 委托到 current，让 `'a' in view` /
  // `Object.keys(view)` / `JSON.stringify(view)` 等内置语义按"看到最新值"工作
  has: (target, key) => Reflect.has(target.current, key),
  ownKeys: (target) => Reflect.ownKeys(target.current),
  getOwnPropertyDescriptor: (target, key) => {
    const desc = Reflect.getOwnPropertyDescriptor(target.current, key);
    if (isUndef(desc)) {
      return;
    }
    // 对外声明 readonly：Proxy invariant 要求 wrapper 上的 own property 必须 configurable，
    // 这里把 writable=false / configurable=true 透出，避免 `Object.keys` / 解构等触发不变量错误
    return { ...desc, writable: false, configurable: true };
  },
  getPrototypeOf: (target) => Reflect.getPrototypeOf(target.current),
};

/**
 * 创建顶层 readonly view（wrapper Proxy）
 *
 * @param dataRef 稳定的 `{ current: T }` 引用；commit / applyRemote / 异步 resolve 时
 *                重新赋值 `dataRef.current`，view 自动看到最新值
 *
 * 缓存：同一 `dataRef` 多次创建 view 拿到同一代理（基于 WeakMap<dataRef, Proxy>）
 */
function createReadonlyView<T extends object>(dataRef: DataRef<T>): T {
  const cached = READONLY_CACHE.get(dataRef);
  if (!isUndef(cached)) {
    return cached as T;
  }
  const proxy = new Proxy(dataRef as DataRef<object>, ROOT_HANDLER) as unknown as T;
  READONLY_CACHE.set(dataRef, proxy);
  return proxy;
}

export type { DataRef };
export { createReadonlyView };
