/**
 * adapters 聚合入口：pickDefaultAdapters
 *
 * 职责：把 `options.adapters` 的用户自定义项与默认实现合并，产出"已解析"形态
 * 供 Phase 3+ 消费。合并策略：用户提供 > 默认实现 > null。
 *
 * 输入形态（用户向）：工厂函数（getXxx(ctx) => Adapter | null）+ 实例（logger）
 * 输出形态（内部向）：工厂保留工厂形态（延迟到使用时调用），但工厂内部自动做"用户工厂返回
 *           null 时降级到默认工厂"的合并；实例直接用解析好的值
 *
 * 设计要点：
 * 1. logger 无 id 作用域 —— 直接解析为实例，内部 adapter 构造时可复用同一个 logger，
 *    保证所有降级日志走用户注入的 logger
 * 2. getAuthority / getChannel / getSessionStore 保留工厂形态，因为 id / channel 语义
 *    要在调用点才确定
 * 3. getLock 直接透传（由 Phase 3 drivers 层解释）
 *
 * wrapper 方案契约（与旧 clone 适配器的根本差异）：
 * - 历史版本曾通过 `adapters.clone`（structuredClone / 用户自定义）做深拷贝；
 *   wrapper 方案下统一改为 `JSON.parse(JSON.stringify(...))`（详见 utils/json-safe.ts），
 *   配合 JSON-only 数据契约（顶层数组禁止 + 非 JSON-safe 类型 fail-fast）确保隔离正确性
 * - 不再支持自定义 clone：用户若需保留 Set / Map / Date 等，应在业务层自行序列化为 JSON 形态
 *
 * 对应 RFC.md「设计原则」：用户提供 > 默认实现 > null
 */

import { isNull } from '@/shared/utils';
import type {
  AuthorityAdapter,
  AuthorityAdapterContext,
  ChannelAdapter,
  ChannelAdapterContext,
  LockDataAdapters,
  SessionStoreAdapter,
  SessionStoreAdapterContext,
} from '../types';
import { createDefaultAuthorityAdapter } from './authority';
import { createDefaultChannelAdapter } from './channel';
import { type ResolvedLoggerAdapter, resolveLoggerAdapter } from './logger';
import { createDefaultSessionStoreAdapter } from './session-store';

/**
 * 解析后的适配器集合
 *
 * 所有字段均为"可直接调用"形态：
 * - logger：实例
 * - getAuthority / getChannel / getSessionStore：工厂（返回 null 时表示能力不可用）
 * - getLock：原样透传；Phase 3 的 pickDriver 决定是否使用
 */
interface ResolvedAdapters<T> {
  readonly logger: ResolvedLoggerAdapter;
  readonly getAuthority: (ctx: AuthorityAdapterContext) => AuthorityAdapter | null;
  readonly getChannel: (ctx: ChannelAdapterContext) => ChannelAdapter | null;
  readonly getSessionStore: (ctx: SessionStoreAdapterContext) => SessionStoreAdapter | null;
  readonly getLock: LockDataAdapters<T>['getLock'];
}

/**
 * 合并用户自定义 adapters 与默认实现
 *
 * 合并语义：
 * - logger：`userAdapters.logger` 优先；未提供时用默认 logger
 * - getAuthority：用户工厂存在 → 先调用；返回非 null 直接用；返回 null 时 fallback 到默认工厂
 *   用户未提供 → 直接用默认工厂
 *   默认工厂也返回 null 时表示能力不可用
 * - getChannel / getSessionStore：同 getAuthority
 * - getLock：透传（聚合层不关心其行为）
 *
 * @param userAdapters 用户传入的 `options.adapters`；未传视为空
 */
function pickDefaultAdapters<T>(userAdapters?: LockDataAdapters<T>): ResolvedAdapters<T> {
  // 参数兜底优先 || —— userAdapters 只可能是 undefined / 对象
  const user = userAdapters || {};

  // logger 优先解析 —— 其他 adapter 工厂内部会使用已解析的 logger
  // logger 走 resolveLoggerAdapter 做"用户覆盖 + 默认补全"的字段级混合，
  // 保证下游链路拿到的 logger 三方法（warn / error / debug）齐全
  const logger = resolveLoggerAdapter(user.logger);

  const userGetAuthority = user.getAuthority;
  const getAuthority = (ctx: AuthorityAdapterContext): AuthorityAdapter | null => {
    if (userGetAuthority) {
      const userResult = userGetAuthority(ctx);
      if (!isNull(userResult)) {
        return userResult;
      }
      // 用户工厂显式返回 null（表示当前 ctx 不支持），继续走默认工厂
    }
    return createDefaultAuthorityAdapter(ctx, { logger });
  };

  const userGetChannel = user.getChannel;
  const getChannel = (ctx: ChannelAdapterContext): ChannelAdapter | null => {
    if (userGetChannel) {
      const userResult = userGetChannel(ctx);
      if (!isNull(userResult)) {
        return userResult;
      }
    }
    return createDefaultChannelAdapter(ctx, { logger });
  };

  const userGetSessionStore = user.getSessionStore;
  const getSessionStore = (ctx: SessionStoreAdapterContext): SessionStoreAdapter | null => {
    if (userGetSessionStore) {
      const userResult = userGetSessionStore(ctx);
      if (!isNull(userResult)) {
        return userResult;
      }
    }
    return createDefaultSessionStoreAdapter(ctx, { logger });
  };

  return {
    logger,
    getAuthority,
    getChannel,
    getSessionStore,
    getLock: user.getLock,
  };
}

export type { ResolvedAdapters };
export { pickDefaultAdapters };
