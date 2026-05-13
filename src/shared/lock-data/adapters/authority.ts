/**
 * 默认 AuthorityAdapter 实现：基于 localStorage
 *
 * 职责：作为跨 Tab 权威副本的存储与订阅通道
 *   - read：同步读取当前 raw value
 *   - write：写入 raw value，捕获 QuotaExceededError 降级为 warn（允许继续运行，
 *            下次 commit 再次尝试；lock-data 的后续 authority 层会依 rev 去重）
 *   - remove：删除当前 key
 *   - subscribe：订阅跨 Tab 的 `storage` 事件，仅响应同 key 且 storageArea === localStorage 的变更
 *
 * 能力探测：localStorage 不可用（SSR / 浏览器隐私模式 / 禁用三方 cookie）时工厂返回 null，
 * 由聚合层（pickDefaultAdapters）决定是否降级或抛 InvalidOptionsError
 *
 * 对应 RFC.md「接口定义」「默认实现」
 */

import { LOCK_PREFIX } from '../constants';
import type { AuthorityAdapter, AuthorityAdapterContext, LoggerAdapter } from '../types';

interface AuthorityFactoryDeps {
  /** 由聚合层传入；用于降级 / 异常路径的统一日志 */
  readonly logger: LoggerAdapter;
}

/**
 * 能力探测：localStorage 是否可实际读写
 *
 * 仅判断 `typeof localStorage === 'object'` 不够，Safari 隐私模式下 localStorage 存在
 * 但写入会抛 QuotaExceededError；此处用写-删探测法确保真的可用
 */
function hasUsableLocalStorage(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
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
 * 构建 localStorage 权威副本的完整 key
 *
 * 规范：`${LOCK_PREFIX}:${id}:latest`
 */
function buildAuthorityKey(id: string): string {
  return `${LOCK_PREFIX}:${id}:latest`;
}

/**
 * 创建默认 AuthorityAdapter
 *
 * @returns AuthorityAdapter 实例；localStorage 不可用时返回 null
 */
function createDefaultAuthorityAdapter(
  ctx: AuthorityAdapterContext,
  deps: AuthorityFactoryDeps,
): AuthorityAdapter | null {
  if (!hasUsableLocalStorage()) {
    deps.logger.warn(
      'localStorage is not available; default authority adapter is disabled. syncMode="storage-authority" will fall back to local-only semantics.',
    );
    return null;
  }

  const key = buildAuthorityKey(ctx.id);
  // 再次获取 storage 引用；前置探测保证一定存在
  const storage = (globalThis as { localStorage: Storage }).localStorage;

  return {
    read(): string | null {
      try {
        return storage.getItem(key);
      } catch (error) {
        // 读失败极罕见（例如运行中 storage 被 revoke），按 "无数据" 处理
        deps.logger.warn('Failed to read authority snapshot from localStorage', error);
        return null;
      }
    },

    write(raw: string): void {
      try {
        storage.setItem(key, raw);
      } catch (error) {
        // 最常见触发：QuotaExceededError / SecurityError
        // lock-data 的 authority 层会依 rev 去重，此处降级不影响数据一致性
        deps.logger.warn(
          'Failed to write authority snapshot to localStorage (likely QuotaExceededError); remote Tabs will not see this commit until next successful write.',
          error,
        );
      }
    },

    remove(): void {
      try {
        storage.removeItem(key);
      } catch (error) {
        deps.logger.warn('Failed to remove authority snapshot from localStorage', error);
      }
    },

    subscribe(onExternalUpdate: (newValue: string | null) => void): () => void {
      const handler = (event: StorageEvent): void => {
        // 过滤：仅响应 localStorage 的同 key 变更
        // storageArea 可能在某些实现（非同源 iframe 事件代理）里为 null，此处严格比对
        if (event.storageArea !== storage) {
          return;
        }
        if (event.key !== key) {
          return;
        }
        try {
          onExternalUpdate(event.newValue);
        } catch (error) {
          // 回调异常不得影响事件系统本身；聚合层 fanout 的异常隔离由上层负责
          deps.logger.error('Authority subscribe callback threw', error);
        }
      };

      const target = globalThis as {
        addEventListener?: (type: 'storage', handler: (event: StorageEvent) => void) => void;
        removeEventListener?: (type: 'storage', handler: (event: StorageEvent) => void) => void;
      };

      if (typeof target.addEventListener !== 'function') {
        // 能力探测已过，但 window / globalThis 不支持事件绑定（极端定制环境）
        // 返回 noop 解绑，保持接口契约
        deps.logger.warn('globalThis.addEventListener is not available; authority subscribe is noop.');
        return () => void 0;
      }

      target.addEventListener('storage', handler);
      return () => {
        target.removeEventListener?.('storage', handler);
      };
    },
  };
}

export { buildAuthorityKey, createDefaultAuthorityAdapter, hasUsableLocalStorage };
