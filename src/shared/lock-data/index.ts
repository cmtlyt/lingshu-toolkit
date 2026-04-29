import { throwError } from '@/shared/throw-error';
import { ERROR_FN_NAME } from './constants';
import { LockDisposedError } from './errors';

/**
 * lockData 入口
 *
 * ⚠️ 当前 Phase 状态（见 IMPLEMENTATION.md）：
 * - Phase 1（基础件）✅：constants / types / errors / ReadonlyView / Draft / signal
 * - Phase 2~5 ❌：adapters / drivers / authority / registry / actions 尚未实现
 *
 * 完整的 `lockData` 入口依赖 Phase 2~5 全链路，目前不可用。
 * 本函数在被调用时**显式抛错**（而非静默返回空骨架），以保证：
 *   1. 下游不会拿到"看似可用实则空壳"的 actions，避免静默 bug
 *   2. 编译期类型为 `never`，任何赋值 / 解构都会在 TS 层被阻止
 *
 * 如需使用 Phase 1 已完成的基础件（错误类 / 只读视图 / 事务 Draft），
 * 请直接从对应子模块 import，不要通过本入口
 */
function lockData(): never {
  // `ErrorConstructor` 接口同时要求「可 new 调用」和「可直接调用」两种签名，
  // 而 class 语法定义的子类不支持无 new 直接调用，故在调用点做一次类型适配
  throwError(
    ERROR_FN_NAME,
    'lockData entry requires Phase 2-5 (adapters / drivers / authority / registry / actions) to be implemented. See src/shared/lock-data/IMPLEMENTATION.md for progress.',
    LockDisposedError as unknown as ErrorConstructor,
  );
}

// ==== Phase 1 稳定导出：基础件能力 ====
// 仅暴露 Phase 1 已实现且契约稳定的能力；Phase 2~5 的类型（LockDataOptions /
// LockDataActions / AuthorityAdapter 等）暂不外露，避免用户在尚未实现的 API 上
// 产生"看似可用"的心智模型

export { NEVER_TIMEOUT } from './constants';
export {
  InvalidOptionsError,
  LockAbortedError,
  LockDisposedError,
  LockRevokedError,
  LockTimeoutError,
  ReadonlyMutationError,
} from './errors';
export type { LockDataMutation, LockDataMutationOp } from './types';
export { lockData };
