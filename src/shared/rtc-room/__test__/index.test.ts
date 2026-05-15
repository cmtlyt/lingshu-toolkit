/**
 * Node 环境入口导出验证
 *
 * 验证 index.ts 的公开导出是否完整且类型正确
 */

import { describe, expect, test } from 'vitest';
import {
  createRtcRoom,
  RoomDisposedError,
  RoomInvalidStateError,
  RoomPeerNotFoundError,
  RoomSignalingError,
  RoomTimeoutError,
} from '../index';

describe('rtcRoom 导出验证', () => {
  test('createRtcRoom 应该是一个函数', () => {
    expect(createRtcRoom).toBeTypeOf('function');
  });

  test('错误类应该全部导出', () => {
    expect(RoomDisposedError).toBeTypeOf('function');
    expect(RoomInvalidStateError).toBeTypeOf('function');
    expect(RoomPeerNotFoundError).toBeTypeOf('function');
    expect(RoomSignalingError).toBeTypeOf('function');
    expect(RoomTimeoutError).toBeTypeOf('function');
  });

  test('错误类实例化应该包含正确的 name', () => {
    expect(new RoomDisposedError().name).toBe('RoomDisposedError');
    expect(new RoomInvalidStateError().name).toBe('RoomInvalidStateError');
    expect(new RoomPeerNotFoundError().name).toBe('RoomPeerNotFoundError');
    expect(new RoomSignalingError().name).toBe('RoomSignalingError');
    expect(new RoomTimeoutError().name).toBe('RoomTimeoutError');
  });

  test('错误类应该继承 Error', () => {
    expect(new RoomDisposedError()).toBeInstanceOf(Error);
    expect(new RoomInvalidStateError()).toBeInstanceOf(Error);
    expect(new RoomPeerNotFoundError()).toBeInstanceOf(Error);
    expect(new RoomSignalingError()).toBeInstanceOf(Error);
    expect(new RoomTimeoutError()).toBeInstanceOf(Error);
  });

  test('错误类应该支持自定义 message 和 cause', () => {
    const cause = new Error('root cause');
    const error = new RoomSignalingError('custom message', { cause });
    expect(error.message).toBe('custom message');
    expect(error.cause).toBe(cause);
  });
});
