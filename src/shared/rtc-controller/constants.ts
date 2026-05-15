/**
 * rtcController 常量定义
 *
 * 对应 RFC.md「附录A：完整接口索引 — 常量」
 */

/** 数据通道事件消息的标记字段，用于区分事件消息和原始数据 */
const RTC_EVENT_MARKER = '__rtc_event__' as const;

/** 默认数据通道 label */
const DEFAULT_DATA_CHANNEL_LABEL = 'lingshu-rtc';

/** connect() / reconnect() 等待 ICE 连接建立的默认超时时间（ms） */
const DEFAULT_CONNECT_TIMEOUT = 30_000;

/** 默认数据通道配置 */
const DEFAULT_DATA_CHANNEL_OPTIONS: RTCDataChannelInit = { ordered: true };

/** 错误消息前缀中使用的函数名 */
const ERROR_FN_NAME = 'rtcController';

export {
  DEFAULT_CONNECT_TIMEOUT,
  DEFAULT_DATA_CHANNEL_LABEL,
  DEFAULT_DATA_CHANNEL_OPTIONS,
  ERROR_FN_NAME,
  RTC_EVENT_MARKER,
};
