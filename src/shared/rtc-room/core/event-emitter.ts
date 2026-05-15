/**
 * 房间级事件系统
 *
 * 直接复用 rtc-controller 的 event-emitter 实现，
 * 仅 re-export 以保持 rtc-room 内部的 import 路径一致
 */

export { createEventEmitter } from '@/shared/rtc-controller/core/event-emitter';
