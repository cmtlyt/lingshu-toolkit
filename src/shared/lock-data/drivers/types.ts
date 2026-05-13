/**
 * drivers 层的内部类型契约
 *
 * 对应 RFC.md「架构分层」与「能力检测与降级」章节：
 * - `LockDriver`：drivers 层统一抽象；Entry 持有 driver，所有 action 走 `driver.acquire`
 *   拿到一个 `LockHandle`；driver 是**按 id 进程内单例**的（由 InstanceRegistry 持有）
 * - `LockHandle`（已在 `../types` 中以 `LockDriverHandle` 名义向用户暴露）：单次持有
 *   的生命周期对象，`release` 还锁、`onRevokedByDriver` 桥接驱逐事件
 * - `LockDriverDeps`：driver 构造依赖；不同 driver 子集不同，工厂函数签名统一
 *
 * 本文件仅导出**内部类型**，不对外 re-export。
 */

import type { ResolvedLoggerAdapter } from '../adapters/logger';
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  LockDataAdapters,
  LockDriverContext,
  LockDriverHandle,
} from '../types';

/**
 * driver 构造依赖；由 `pickDriver` 从 `entry.adapters` 中分拣后传入
 *
 * 字段设计原则：
 * - `logger` 对所有 driver 必传；driver 内部统一用此 logger 输出 warn / error / debug
 * - `name` 已是拼好 `${LOCK_PREFIX}:${id}` 的完整锁作用域名；driver 无需关心前缀规则
 * - `getChannel` 仅 `BroadcastDriver` 需要；其他 driver 允许为 undefined
 * - `userGetLock` 仅 `CustomDriver` 需要；其他 driver 为 undefined
 *
 * **关于 `userGetLock` 的 `unknown` 泛型**：
 * `LockDataAdapters<T>` 的泛型参数 `_T` 在 `getLock` 签名中并不出现（getLock
 * 只接触锁调度上下文，不接触数据类型）；此处用 `unknown` 表示"本 driver 层对
 * 数据类型不可见"，等价于 `LockDataAdapters<any>['getLock']` 但无 any 污染
 */
interface LockDriverDeps {
  /** 已拼前缀的锁作用域名 `${LOCK_PREFIX}:${id}`；无 id 场景下为 `${LOCK_PREFIX}:__local__` 占位 */
  readonly name: string;
  /** lockData 的原始 id；CustomDriver / 日志输出时需要（未 scope 化） */
  readonly id: string | undefined;
  /** Resolved logger（三方法齐全，下游可直接调用无需 guard） */
  readonly logger: ResolvedLoggerAdapter;
  /** 工厂：提供广播通道（仅 BroadcastDriver 消费） */
  readonly getChannel?: (ctx: ChannelAdapterContext) => ChannelAdapter | null;
  /** 用户注入的自定义 `adapters.getLock`（仅 CustomDriver 消费） */
  readonly userGetLock?: LockDataAdapters<unknown>['getLock'];
}

/**
 * 锁驱动统一抽象
 *
 * 所有 driver 实现均为"进程内 + id 作用域"单例；由 InstanceRegistry 首次创建
 * Entry 时构造一次，Entry 销毁时调用 `destroy()` 清理内部长生命周期资源
 * （心跳定时器、订阅、BroadcastChannel 实例等）
 *
 * 并发语义：
 * - `acquire` 可被同一 driver 实例并发调用（例如同进程内两个 lockData 实例，均指向
 *   同一 id），driver 内部负责**串行化**（FIFO 排队 / WebLocks 原生排队 / token 协议）
 * - `force: true` 的 `acquire` 会让当前持有者的 `LockHandle.onRevokedByDriver` 以
 *   `'force'` 回调并立即释放；当前持有者后续 `release` 仍需可调用（幂等 no-op）
 * - `acquireTimeout` 在 `acquire` 内部处理；到期抛 `LockTimeoutError`
 * - `signal.aborted`（acquiring 阶段）抛 `LockAbortedError`
 */
interface LockDriver {
  /**
   * 抢锁；返回一个单次持有的 `LockHandle`
   *
   * 抛错语义：
   * - `LockTimeoutError`：acquireTimeout 到期
   * - `LockAbortedError`：ctx.signal aborted / driver 已 destroy
   * - 其他错误：driver 内部故障（logger.error 后原样透传）
   */
  readonly acquire: (ctx: LockDriverContext) => Promise<LockDriverHandle>;

  /**
   * Entry 引用计数归零 / dispose 时调用；清理 driver 内部长生命周期资源
   *
   * 幂等：重复调用 no-op；`destroy` 后再次 `acquire` 必抛 `LockAbortedError`
   */
  readonly destroy: () => void;
}

export type { LockDriver, LockDriverDeps };
