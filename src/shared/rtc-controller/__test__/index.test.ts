/**
 * Node 环境入口导出验证
 *
 * 验证 index.ts 的公开导出是否完整且类型正确
 */

import { describe, expect, test } from 'vitest';
import {
  createRtcController,
  RtcChannelNotReadyError,
  RtcDisposedError,
  RtcInvalidStateError,
  RtcSignalingError,
  RtcTimeoutError,
} from '../index';

describe('rtcController 导出验证', () => {
  test('createRtcController 应该是一个函数', () => {
    expect(createRtcController).toBeTypeOf('function');
  });

  test('错误类应该全部导出', () => {
    expect(RtcChannelNotReadyError).toBeTypeOf('function');
    expect(RtcDisposedError).toBeTypeOf('function');
    expect(RtcInvalidStateError).toBeTypeOf('function');
    expect(RtcSignalingError).toBeTypeOf('function');
    expect(RtcTimeoutError).toBeTypeOf('function');
  });

  test('错误类实例化应该包含正确的 name', () => {
    expect(new RtcChannelNotReadyError().name).toBe('RtcChannelNotReadyError');
    expect(new RtcDisposedError().name).toBe('RtcDisposedError');
    expect(new RtcInvalidStateError().name).toBe('RtcInvalidStateError');
    expect(new RtcSignalingError().name).toBe('RtcSignalingError');
    expect(new RtcTimeoutError().name).toBe('RtcTimeoutError');
  });

  test('错误类应该继承 Error', () => {
    expect(new RtcChannelNotReadyError()).toBeInstanceOf(Error);
    expect(new RtcDisposedError()).toBeInstanceOf(Error);
    expect(new RtcInvalidStateError()).toBeInstanceOf(Error);
    expect(new RtcSignalingError()).toBeInstanceOf(Error);
    expect(new RtcTimeoutError()).toBeInstanceOf(Error);
  });

  test('错误类应该支持自定义 message 和 cause', () => {
    const cause = new Error('root cause');
    const error = new RtcSignalingError('custom message', { cause });
    expect(error.message).toBe('custom message');
    expect(error.cause).toBe(cause);
  });
});
