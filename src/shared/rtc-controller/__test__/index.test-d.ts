/**
 * 类型契约测试
 *
 * 验证泛型推断、AllEvents 合并、emit 仅允许 UserEvents 等类型约束
 */

import { describe, expectTypeOf, test } from 'vitest';
import { createRtcController } from '../index';
import type {
  AllEvents,
  BuiltinEvents,
  EventHandler,
  RtcControllerOptions,
  RtcPhase,
  SignalingAdapter,
  SignalingMessage,
} from '../types';

describe('类型契约', () => {
  test('RtcPhase 应该是 7 个状态的联合类型', () => {
    expectTypeOf<RtcPhase>().toEqualTypeOf<
      'idle' | 'signaling' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
    >();
  });

  test('SignalingMessage 应该是 offer/answer/ice-candidate 的联合类型', () => {
    expectTypeOf<SignalingMessage>().toEqualTypeOf<
      | { type: 'offer'; sdp: string }
      | { type: 'answer'; sdp: string }
      | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
    >();
  });

  test('SignalingAdapter 应该包含 send/onMessage 方法', () => {
    expectTypeOf<SignalingAdapter>().toHaveProperty('send');
    expectTypeOf<SignalingAdapter>().toHaveProperty('onMessage');
  });

  test('EventHandler payload 为 void 时应该是无参函数', () => {
    expectTypeOf<EventHandler<void>>().toEqualTypeOf<() => void>();
  });

  test('EventHandler payload 非 void 时应该携带 payload 参数', () => {
    expectTypeOf<EventHandler<{ name: string }>>().toEqualTypeOf<(payload: { name: string }) => void>();
  });

  test('AllEvents 应该合并 BuiltinEvents 和 UserEvents', () => {
    interface MyEvents {
      greeting: { message: string };
      farewell: undefined;
    }
    type Merged = AllEvents<MyEvents>;

    // 应该包含内置事件
    expectTypeOf<Merged>().toHaveProperty('connected');
    expectTypeOf<Merged>().toHaveProperty('phase-change');
    expectTypeOf<Merged>().toHaveProperty('error');

    // 应该包含用户事件
    expectTypeOf<Merged>().toHaveProperty('greeting');
    expectTypeOf<Merged>().toHaveProperty('farewell');
  });

  test('AllEvents 中内置事件应该优先于同名用户事件', () => {
    interface ConflictEvents {
      connected: { fake: true };
    }
    type Merged = AllEvents<ConflictEvents>;

    // connected 应该保持 BuiltinEvents 的类型（undefined），而非用户定义的 { fake: true }
    expectTypeOf<Merged['connected']>().toEqualTypeOf<BuiltinEvents['connected']>();
  });

  test('RtcController 无泛型参数时应该只能监听内置事件', () => {
    const mockSignaling: SignalingAdapter = {
      send: () => {},
      onMessage: () => () => {},
    };
    const controller = createRtcController({ signaling: mockSignaling });

    // 内置事件应该可以监听
    expectTypeOf(controller.on).toBeCallableWith('connected', () => {});
    expectTypeOf(controller.on).toBeCallableWith('phase-change', () => {});
    expectTypeOf(controller.on).toBeCallableWith('error', () => {});
  });

  test('RtcController 有泛型参数时应该能监听自定义事件和内置事件', () => {
    interface MyEvents {
      greeting: { message: string };
    }
    const mockSignaling: SignalingAdapter = {
      send: () => {},
      onMessage: () => () => {},
    };
    const controller = createRtcController<MyEvents>({ signaling: mockSignaling });

    // 自定义事件和内置事件都应该可以监听
    expectTypeOf(controller.on).toBeCallableWith('greeting', () => {});
    expectTypeOf(controller.on).toBeCallableWith('connected', () => {});
  });

  test('RtcController.emit 应该只允许用户自定义事件', () => {
    interface MyEvents {
      greeting: { message: string };
    }
    const mockSignaling: SignalingAdapter = {
      send: () => {},
      onMessage: () => () => {},
    };
    const controller = createRtcController<MyEvents>({ signaling: mockSignaling });

    // emit 的第一个参数应该是 UserEvents 的 key
    expectTypeOf(controller.emit).parameter(0).toMatchTypeOf<'greeting'>();
  });

  test('RtcController.phase 应该是只读的 RtcPhase', () => {
    const mockSignaling: SignalingAdapter = {
      send: () => {},
      onMessage: () => () => {},
    };
    const controller = createRtcController({ signaling: mockSignaling });
    expectTypeOf(controller.phase).toEqualTypeOf<RtcPhase>();
  });

  test('RtcController.peerConnection 应该是 RTCPeerConnection | null', () => {
    const mockSignaling: SignalingAdapter = {
      send: () => {},
      onMessage: () => () => {},
    };
    const controller = createRtcController({ signaling: mockSignaling });
    expectTypeOf(controller.peerConnection).toEqualTypeOf<RTCPeerConnection | null>();
  });

  test('RtcControllerOptions.signaling 应该是必填项', () => {
    expectTypeOf<RtcControllerOptions>().toHaveProperty('signaling');
  });

  test('RtcControllerOptions.signal 应该是可选的 AbortSignal', () => {
    expectTypeOf<RtcControllerOptions['signal']>().toEqualTypeOf<AbortSignal | undefined>();
  });

  test('on 返回值应该是取消订阅函数', () => {
    const mockSignaling: SignalingAdapter = {
      send: () => {},
      onMessage: () => () => {},
    };
    const controller = createRtcController({ signaling: mockSignaling });
    const off = controller.on('connected', () => {});
    expectTypeOf(off).toEqualTypeOf<() => void>();
  });
});
