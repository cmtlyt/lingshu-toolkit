/**
 * 深只读代理：用户从 lockData 拿到的第一个返回值
 *
 * 实现要点（对应 RFC.md「只读代理实现要点」）：
 * - WeakMap<object, Proxy> 缓存：保证同一对象多次访问拿到同一代理，引用比较有效
 * - 惰性递归：仅在 get 到对象时才按需包裹，避免初始化时深度遍历大对象
 * - 写拦截：set / deleteProperty / defineProperty 统一抛 ReadonlyMutationError
 * - Set / Map 的 mutation 方法（add / set / delete / clear）拦截后抛错，
 *   非 mutation 方法（has / get / size / keys / values / entries / forEach / 迭代器）
 *   绕过 Proxy 直接绑定到原始 target，避免 "Illegal invocation"
 * - 原地更新：`actions.update` commit 后底层 target 已被原地修改，
 *   因此只读视图对同一路径再次读取可自动看到最新值，不需要重建 Proxy
 */

import { throwError } from '@/shared/throw-error';
import { getType } from '@/shared/utils/base';
import { ERROR_FN_NAME } from '../constants';
import { ReadonlyMutationError } from '../errors';

const READONLY_CACHE = new WeakMap<object, object>();

/** Set 与 Map 共同的 mutation 方法：任一方法被调用都会改变容器内容 */
const SET_MUTATION_METHODS = new Set<PropertyKey>(['add', 'delete', 'clear']);
const MAP_MUTATION_METHODS = new Set<PropertyKey>(['set', 'delete', 'clear']);

function isPlainAccessible(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function rejectMutation(): never {
  // `ErrorConstructor` 接口同时要求「可 new 调用」和「可直接调用」两种签名，
  // 而 class 语法定义的子类不支持无 new 直接调用，故在调用点做一次类型适配
  throwError(ERROR_FN_NAME, 'cannot mutate readonly view', ReadonlyMutationError as unknown as ErrorConstructor);
}

/**
 * 获取对 Set / Map 的方法读取结果：
 * - mutation 方法：返回一个立即抛错的函数，阻止 `view.tags.add('x')` 这类绕道写入
 * - 非 mutation 方法：bind 到原始 target，防止 `receiver` 为 Proxy 导致 `Illegal invocation`
 * - 非函数成员（如 `size`）：直接返回原值
 *
 * 返回 `null` 表示"非 Set/Map 上的特殊处理"，上层按常规 get 逻辑处理
 */
function pickCollectionMutationKeys(target: object): Set<PropertyKey> | null {
  // 用 `Object.prototype.toString` 判定而非 `instanceof`：
  // 后者在跨 realm（iframe / worker）或原型链被污染时不可靠
  const type = getType(target);
  if (type === 'set') {
    return SET_MUTATION_METHODS;
  }
  if (type === 'map') {
    return MAP_MUTATION_METHODS;
  }
  return null;
}

function resolveCollectionMember(target: object, key: PropertyKey, value: unknown): unknown {
  const mutationKeys = pickCollectionMutationKeys(target);
  if (mutationKeys === null) {
    return null;
  }
  if (mutationKeys.has(key)) {
    return rejectMutation;
  }
  if (typeof value === 'function') {
    return value.bind(target);
  }
  return value;
}

const READONLY_HANDLER: ProxyHandler<object> = {
  get(target, key, receiver) {
    // Set / Map 的访问器属性（如 `size`）必须以原始容器作为 getter 的 this，
    // 否则触发 `incompatible receiver`；因此对容器类型先取值后特殊处理，
    // 且取值时不传 receiver，让 getter 的 this 绑定到 target 本身
    const targetType = getType(target);
    const isCollection = targetType === 'set' || targetType === 'map';
    if (isCollection) {
      const collectionValue = Reflect.get(target, key);
      const collectionMember = resolveCollectionMember(target, key, collectionValue);
      return collectionMember;
    }
    const value = Reflect.get(target, key, receiver);
    if (isPlainAccessible(value)) {
      return createReadonlyView(value);
    }
    return value;
  },
  set: rejectMutation,
  deleteProperty: rejectMutation,
  defineProperty: rejectMutation,
  setPrototypeOf: rejectMutation,
};

function createReadonlyView<T extends object>(target: T): T {
  const cached = READONLY_CACHE.get(target);
  if (cached !== undefined) {
    return cached as T;
  }
  const proxy = new Proxy(target, READONLY_HANDLER) as T;
  READONLY_CACHE.set(target, proxy);
  return proxy;
}

export { createReadonlyView };
