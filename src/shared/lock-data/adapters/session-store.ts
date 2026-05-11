/**
 * 默认 SessionStoreAdapter 实现：基于 sessionStorage
 *
 * 职责：同会话组（同 Tab 及其直系派生 Tab）内存 epoch 快照
 *   - read：同步读取当前 raw value
 *   - write：写入 raw value；QuotaExceededError 等失败降级 warn
 *
 * 能力探测：sessionStorage 不可用（SSR / 浏览器隐私模式 / 禁用 storage）时
 *           工厂返回 null，由聚合层决定降级路径（session -> persistent）
 *
 * 对应 RFC.md「接口定义」「默认实现」
 */

import { LOCK_PREFIX } from '../constants';
import type { LoggerAdapter, SessionStoreAdapter, SessionStoreAdapterContext } from '../types';

interface SessionStoreFactoryDeps {
  readonly logger: LoggerAdapter;
}

/**
 * 能力探测：sessionStorage 是否可实际读写
 *
 * 与 authority 的 localStorage 探测同构：仅判断 `typeof sessionStorage`
 * 不够，Safari 隐私模式下 setItem 会抛 QuotaExceededError；
 * 采用写-删探测法确保真的可用
 */
function hasUsableSessionStorage(): boolean {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!storage) {
      return false;
    }
    const probeKey = `${LOCK_PREFIX}:__probe__`;
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构建 sessionStorage 的完整 key
 *
 * 规范：`${LOCK_PREFIX}:${id}:epoch`
 */
function buildSessionStoreKey(id: string): string {
  return `${LOCK_PREFIX}:${id}:epoch`;
}

/**
 * 创建默认 SessionStoreAdapter
 *
 * @returns SessionStoreAdapter 实例；sessionStorage 不可用时返回 null
 */
function createDefaultSessionStoreAdapter(
  ctx: SessionStoreAdapterContext,
  deps: SessionStoreFactoryDeps,
): SessionStoreAdapter | null {
  if (!hasUsableSessionStorage()) {
    deps.logger.warn(
      'sessionStorage is not available; default session store adapter is disabled. persistence="session" will fall back to "persistent".',
    );
    return null;
  }

  const key = buildSessionStoreKey(ctx.id);
  const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;

  return {
    read(): string | null {
      try {
        return storage.getItem(key);
      } catch (error) {
        deps.logger.warn('Failed to read session store from sessionStorage', error);
        return null;
      }
    },

    write(value: string): void {
      try {
        storage.setItem(key, value);
      } catch (error) {
        // 典型触发：QuotaExceededError / SecurityError
        // epoch 丢失会导致下一次启动视为新会话（走 session-probe 协议），
        // 不会造成数据丢失，故此处仅 warn 降级
        deps.logger.warn('Failed to write session store to sessionStorage; epoch may be reset on next startup.', error);
      }
    },
  };
}

export { buildSessionStoreKey, createDefaultSessionStoreAdapter, hasUsableSessionStorage };
