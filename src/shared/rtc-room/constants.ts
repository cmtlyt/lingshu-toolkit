/**
 * rtc-room 常量定义
 *
 * 对应 RFC.md「附录A：完整接口索引 — 常量」
 */

/** join() 等待成员列表的默认超时时间（ms） */
const DEFAULT_JOIN_TIMEOUT = 10_000;

/** 错误消息前缀中使用的函数名 */
const ERROR_FN_NAME = 'rtcRoom';

export { DEFAULT_JOIN_TIMEOUT, ERROR_FN_NAME };
