/**
 * 事务式 Draft：锁持有期间对底层 data 的可写代理
 *
 * 实现要点（对应 RFC.md「事务式 Draft」「Draft Proxy 行为」）：
 * - set / deleteProperty 同时：① push 到 mutation log ② 原地写入 target ③ 在 snapshot 中首次记录 prevValue
 * - validity 置否（revoke / abort / recipe 结束）后任何写入立即抛 LockRevokedError
 * - 惰性子代理：get 到对象时递归构造子 draft，共享同一 ctx，路径前缀累加
 * - rollback 按 mutation log 逆序 + snapshot prevValue 恢复 target，避免整树深拷贝
 *
 * ----------------------------------------------------------------
 * MIGRATION NOTE（对应 RFC.md 决策 #32 「外部化前瞻」）：
 *   当前实现 self-contained，不对外导出。未来若出现第二个使用者（表单草稿 /
 *   乐观更新 / 编辑器临时操作等），可按 RFC 预留的通用化 API 骨架
 *   （shared/transactional-draft）抽离；lock-data 用薄适配层接回。
 * ----------------------------------------------------------------
 */

import { throwError } from '@/shared/throw-error';
import { getType } from '@/shared/utils/base';
import { ERROR_FN_NAME } from '../constants';
import { LockRevokedError } from '../errors';
import type { LockDataMutation } from '../types';

/** Draft 自身的有效性开关；置 false 后写入立即抛错 */
interface DraftValidity {
  isValid: boolean;
}

/**
 * snapshot 条目：
 * - `kind: 'property'`：普通属性的首次写入记录 prevValue，用于 `Reflect.set` / `deleteProperty` 逆向恢复
 * - `kind: 'collection'`：Set / Map 首次 mutate 时对整个容器做**浅克隆**；rollback 时整体清空再灌回来
 *   （对 Set/Map 做"最小路径 diff"成本远高于整体克隆，且 Set 无法稳定寻址被 add 的 item）
 */
type DraftSnapshotEntry =
  | { kind: 'property'; target: object; key: PropertyKey; existed: boolean; prevValue: unknown }
  | { kind: 'collection'; target: Set<unknown> | Map<unknown, unknown>; clone: Set<unknown> | Map<unknown, unknown> };

type DraftSnapshot = Map<string, DraftSnapshotEntry>;

interface DraftContext {
  readonly validity: DraftValidity;
  readonly mutations: LockDataMutation[];
  readonly snapshot: DraftSnapshot;
}

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

/** Set / Map 共同的 mutation 方法名集合 */
const SET_MUTATION_METHODS = new Set<PropertyKey>(['add', 'delete', 'clear']);
const MAP_MUTATION_METHODS = new Set<PropertyKey>(['set', 'delete', 'clear']);

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
  snapshot.set(snapshotKey, { kind: 'property', target, key, existed, prevValue });
}

/**
 * 为"首次 Set/Map mutation"整体克隆容器
 *
 * 为什么整体克隆而非最小 diff：
 * - Set 的 add(item) 无法稳定寻址（item 可能是对象引用），diff 后 rollback 难以去重
 * - Map 的 set 覆盖旧值时需要记录 prevValue，delete 需要记录被删除的 key，累积成本不低于整体克隆
 * - 实际使用场景里 Set/Map 多为中小规模（tags / ids / 字段映射），浅克隆成本可接受
 */
function captureCollectionSnapshotOnce(
  snapshot: DraftSnapshot,
  target: Set<unknown> | Map<unknown, unknown>,
  targetId: string,
): void {
  const snapshotKey = `${targetId}::@@collection`;
  if (snapshot.has(snapshotKey)) {
    return;
  }
  const clone = target instanceof Set ? new Set(target) : new Map(target);
  snapshot.set(snapshotKey, { kind: 'collection', target, clone });
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

/** 把 Set / Map 判定与对应 mutation 方法集合抽成一个原子结果 */
interface CollectionInfo {
  readonly isSet: boolean;
  readonly mutationKeys: Set<PropertyKey>;
}

function detectCollection(target: object): CollectionInfo | null {
  // 用 `Object.prototype.toString` 判定而非 `instanceof`：
  // 后者在跨 realm（iframe / worker）或原型链被污染时不可靠
  const type = getType(target);
  if (type === 'set') {
    return { isSet: true, mutationKeys: SET_MUTATION_METHODS };
  }
  if (type === 'map') {
    return { isSet: false, mutationKeys: MAP_MUTATION_METHODS };
  }
  return null;
}

/**
 * 为 Set / Map 的方法读取做特殊处理：
 * - mutation 方法：返回一个包装函数，验证 validity → 抓 snapshot → push mutation → 调用原方法
 * - 非 mutation 方法：bind 到原始 target，避免 Proxy 导致的 "Illegal invocation"
 * - 非函数成员（如 `size`）：直接返回原值
 *
 * 返回 `null` 表示"target 不是 Set/Map"，上层继续按对象语义处理
 *
 * 参数聚合为 `access` 是为了避免函数签名超过 biome `max-params` 限制（5 个）
 */
interface CollectionAccess {
  readonly target: object;
  readonly key: PropertyKey;
  readonly value: unknown;
  readonly ctx: DraftContext;
  readonly parentPath: readonly PropertyKey[];
  readonly targetId: string;
}

function resolveCollectionMember(access: CollectionAccess): unknown {
  const { target, key, value, ctx, parentPath, targetId } = access;
  const info = detectCollection(target);
  if (info === null) {
    return null;
  }
  if (!info.mutationKeys.has(key)) {
    return typeof value === 'function' ? value.bind(target) : value;
  }
  // 为每种 mutation 方法返回对应的包装函数
  return (...args: unknown[]): unknown => {
    ensureWritable(ctx.validity);
    captureCollectionSnapshotOnce(ctx.snapshot, target as Set<unknown> | Map<unknown, unknown>, targetId);
    const mutation = buildCollectionMutation(info.isSet, key, args, parentPath);
    ctx.mutations.push(mutation);
    return (value as (...inner: unknown[]) => unknown).apply(target, args);
  };
}

/** 把一次 Set/Map 方法调用翻译成对应的 `LockDataMutation` */
function buildCollectionMutation(
  isSet: boolean,
  methodKey: PropertyKey,
  args: readonly unknown[],
  parentPath: readonly PropertyKey[],
): LockDataMutation {
  const path: readonly PropertyKey[] = [...parentPath];
  if (methodKey === 'clear') {
    return { path, op: isSet ? 'set-clear' : 'map-clear' };
  }
  if (isSet) {
    // Set.add(item) / Set.delete(item)
    return { path, op: methodKey === 'add' ? 'set-add' : 'set-delete', value: args[0] };
  }
  // Map.set(key, value) / Map.delete(key)
  return {
    path,
    op: methodKey === 'set' ? 'map-set' : 'map-delete',
    value: methodKey === 'set' ? [args[0], args[1]] : args[0],
  };
}

function createDraftProxy<T extends object>(
  target: T,
  ctx: DraftContext,
  parentPath: readonly PropertyKey[],
  targetId: string,
): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      // Set / Map 的访问器属性（如 `size`）必须以原始容器作为 getter 的 this，
      // 否则触发 `incompatible receiver`；故容器类型优先取值 + 不传 receiver
      const objType = getType(obj);
      const isCollection = objType === 'set' || objType === 'map';
      if (isCollection) {
        const collectionValue = Reflect.get(obj, key);
        return resolveCollectionMember({ target: obj, key, value: collectionValue, ctx, parentPath, targetId });
      }
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
 * - `'property'`：按记录的 existed / prevValue 逐条写回或删除
 * - `'collection'`：对 Set / Map 整体清空后灌回 clone 的全部元素
 */
function applyRollback(snapshot: DraftSnapshot): void {
  const entries = Array.from(snapshot.values()).reverse();
  // 数组遍历优先使用索引 for 循环（见 IMPLEMENTATION.md 开发守则「代码风格 - 循环形式」）
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.kind === 'property') {
      if (entry.existed) {
        Reflect.set(entry.target, entry.key, entry.prevValue);
      } else {
        Reflect.deleteProperty(entry.target, entry.key);
      }
      continue;
    }
    restoreCollection(entry.target, entry.clone);
  }
}

function restoreCollection(
  target: Set<unknown> | Map<unknown, unknown>,
  clone: Set<unknown> | Map<unknown, unknown>,
): void {
  target.clear();
  // 用 `Object.prototype.toString` 判定而非 `instanceof`：
  // 后者在跨 realm（iframe / worker）或原型链被污染时不可靠
  const targetType = getType(target);
  // Set / Map 没有索引访问，只能使用 for...of（语言特性必需，见开发守则「代码风格 - 循环形式」例外）
  if (targetType === 'set' && getType(clone) === 'set') {
    for (const item of clone as Set<unknown>) {
      (target as Set<unknown>).add(item);
    }
    return;
  }
  if (targetType === 'map' && getType(clone) === 'map') {
    for (const [key, value] of clone as Map<unknown, unknown>) {
      (target as Map<unknown, unknown>).set(key, value);
    }
  }
}

function freezeMutations(mutations: LockDataMutation[]): readonly LockDataMutation[] {
  const frozen = mutations.map((mutation) => Object.freeze({ ...mutation, path: Object.freeze([...mutation.path]) }));
  return Object.freeze(frozen);
}

function createDraftSession<T extends object>(target: T): DraftSession<T> {
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
