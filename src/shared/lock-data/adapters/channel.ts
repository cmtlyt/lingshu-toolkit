/**
 * 默认 ChannelAdapter 实现：基于原生 BroadcastChannel
 *
 * 职责：跨同源 Tab / Worker 的消息广播通道
 *   - postMessage：发送消息；已关闭时降级为 warn，不抛错
 *   - subscribe：订阅 message 事件；回调异常走 logger.error 隔离
 *   - close：幂等关闭，后续操作全部降级 noop
 *
 * 能力探测：`BroadcastChannel` 不可用（SSR / 老浏览器）时工厂返回 null，
 * 由聚合层决定降级路径
 *
 * 对应 RFC.md「接口定义」「默认实现」
 */

import { LOCK_PREFIX } from '../constants';
import type { ChannelAdapter, ChannelAdapterContext, LoggerAdapter } from '../types';

interface ChannelFactoryDeps {
  readonly logger: LoggerAdapter;
}

/**
 * 能力探测：BroadcastChannel 是否可实例化
 *
 * 仅判断构造器存在还不够，某些环境（如部分 Electron 版本 / 早期 Safari）
 * 构造器存在但实例化会抛错；此处用 try-catch 做真实构造探测
 */
function hasUsableBroadcastChannel(): boolean {
  const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (typeof Ctor !== 'function') {
    return false;
  }
  try {
    const probe = new Ctor(`${LOCK_PREFIX}:__probe__`);
    probe.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * 构建 BroadcastChannel 名称
 *
 * 规范：`${LOCK_PREFIX}:${id}:${channel}`
 * - channel === 'session'：session-probe / session-reply 协议通道
 * - channel === 'custom'：Phase 3 广播驱动等其他业务通道
 */
function buildChannelName(id: string, channel: ChannelAdapterContext['channel']): string {
  return `${LOCK_PREFIX}:${id}:${channel}`;
}

/**
 * 创建默认 ChannelAdapter
 *
 * @returns ChannelAdapter 实例；BroadcastChannel 不可用时返回 null
 */
function createDefaultChannelAdapter(ctx: ChannelAdapterContext, deps: ChannelFactoryDeps): ChannelAdapter | null {
  if (!hasUsableBroadcastChannel()) {
    deps.logger.warn(
      'BroadcastChannel is not available; default channel adapter is disabled. Cross-tab sync features may fall back to degraded mode.',
    );
    return null;
  }

  const name = buildChannelName(ctx.id, ctx.channel);
  const Ctor = (globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel;

  let channel: BroadcastChannel | null = new Ctor(name);
  let closed = false;

  return {
    postMessage(message: unknown): void {
      if (closed || channel === null) {
        // 关闭后的 post 视为 no-op 并 warn 一次（上层已不应再调用）
        deps.logger.warn('postMessage on closed ChannelAdapter is ignored.');
        return;
      }
      try {
        channel.postMessage(message);
      } catch (error) {
        // 常见：InvalidStateError（异步关闭时序）/ DataCloneError（消息含不可序列化内容）
        deps.logger.warn('BroadcastChannel.postMessage failed', error);
      }
    },

    subscribe(onMessage: (message: unknown) => void): () => void {
      if (closed || channel === null) {
        deps.logger.warn('subscribe on closed ChannelAdapter is ignored; returning noop unsubscriber.');
        return () => void 0;
      }

      const handler = (event: MessageEvent): void => {
        try {
          onMessage(event.data);
        } catch (error) {
          // 回调异常不得影响通道本身，也不得污染其他订阅者
          deps.logger.error('Channel subscribe callback threw', error);
        }
      };

      channel.addEventListener('message', handler);
      return () => {
        // channel 可能已被 close，此时 removeEventListener 在老实现里会抛
        // 但主流实现是幂等的 noop；无论如何用 try-catch 兜底保证解绑语义
        try {
          channel?.removeEventListener('message', handler);
        } catch {
          // 解绑失败无需 warn，调用方语义上已"不再关心"
        }
      };
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      try {
        channel?.close();
      } catch (error) {
        deps.logger.warn('BroadcastChannel.close failed', error);
      } finally {
        channel = null;
      }
    },
  };
}

export { buildChannelName, createDefaultChannelAdapter, hasUsableBroadcastChannel };
