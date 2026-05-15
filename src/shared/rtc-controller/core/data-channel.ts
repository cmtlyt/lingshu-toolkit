/**
 * DataChannel 管理
 *
 * 对应 RFC.md「数据通道与自定义事件」章节
 *
 * 职责：
 * - DataChannel 事件注册（onopen / onclose / onmessage）
 * - 事件协议编解码（DataChannelEventMessage：__rtc_event__ 标记检测）
 * - __onUserEvent 钩子调用（供 rtc-room 拦截自定义事件）
 * - 自定义事件与内置事件命名冲突的运行时检测
 */

import { isString } from '@/shared/utils';
import { RTC_EVENT_MARKER } from '../constants';
import type { BuiltinEvents, DataChannelEventMessage, EventMap } from '../types';
import type { ControllerContext } from './controller-context';

/** 内置事件名集合，用于运行时冲突检测 */
const BUILTIN_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  'phase-change',
  'connected',
  'disconnected',
  'failed',
  'closed',
  'track',
  'track-removed',
  'data-channel-ready',
  'data-channel-closed',
  'ice-state-change',
  'ice-gathering-complete',
  'signaling-state-change',
  'raw-message',
  'error',
] satisfies Array<keyof BuiltinEvents>);

/** 判断消息是否为事件协议消息 */
function isEventMessage(data: unknown): data is DataChannelEventMessage {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return obj[RTC_EVENT_MARKER] === true && isString(obj.event);
}

/** 尝试将 DataChannel 原始数据解析为 JSON，失败返回 null */
function parseEventData(data: unknown): unknown {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** 分发已解析的事件消息：冲突检测 → 钩子回调 → 事件分发 */
function dispatchParsedEvent<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  message: DataChannelEventMessage,
): void {
  const { event: eventName, payload } = message;

  if (BUILTIN_EVENT_NAMES.has(eventName)) {
    ctx.logger.warn(`custom event "${eventName}" conflicts with builtin event, ignored`);
    return;
  }

  if (ctx.onUserEventHook) {
    const consumed = ctx.onUserEventHook(eventName, payload);
    if (consumed === true) {
      return;
    }
  }

  ctx.emitter.dispatch(eventName as keyof BuiltinEvents, payload);
}

/**
 * 为 RTCDataChannel 注册事件，桥接到控制器事件分发
 *
 * - onopen → data-channel-ready 事件
 * - onclose → data-channel-closed 事件
 * - onmessage → 事件协议解码 / raw-message 分发
 */
function wireDataChannelEvents<UserEvents extends EventMap>(
  ctx: ControllerContext<UserEvents>,
  channel: RTCDataChannel,
): void {
  channel.onopen = () => {
    ctx.channels.set(channel.label, channel);
    ctx.emitter.dispatch('data-channel-ready', { channel, label: channel.label });
  };

  channel.onclose = () => {
    ctx.channels.delete(channel.label);
    ctx.emitter.dispatch('data-channel-closed', { label: channel.label });
  };

  channel.onmessage = (event: MessageEvent) => {
    const parsed = parseEventData(event.data);
    if (!isEventMessage(parsed)) {
      ctx.emitter.dispatch('raw-message', { data: event.data, channel });
      return;
    }
    dispatchParsedEvent(ctx, parsed);
  };
}

/**
 * 编码自定义事件为 DataChannelEventMessage JSON 字符串
 */
function encodeEventMessage(event: string, payload: unknown): string {
  const message: DataChannelEventMessage = {
    [RTC_EVENT_MARKER]: true,
    event,
    payload,
  };
  return JSON.stringify(message);
}

export {
  BUILTIN_EVENT_NAMES,
  dispatchParsedEvent,
  encodeEventMessage,
  isEventMessage,
  parseEventData,
  wireDataChannelEvents,
};
