/**
 * 房间状态机
 *
 * 对应 RFC.md「RoomPhase状态机」章节
 *
 * 合法流转：idle → joining → joined → leaving → left
 *           left → idle（重新 join 时重置）
 *           任意状态 → disposed
 */

import { throwError } from '@/shared/throw-error';
import { ERROR_FN_NAME } from '../constants';
import { RoomDisposedError } from '../errors/room-disposed-error';
import { RoomInvalidStateError } from '../errors/room-invalid-state-error';
import type { RoomPhase } from '../types';
import type { createEventEmitter } from './event-emitter';

interface RoomStateContext {
  phase: RoomPhase;
  readonly dispatch: ReturnType<typeof createEventEmitter>['dispatch'];
}

/** 更新 phase 并分发 room-phase-change 事件 */
function setPhase(ctx: RoomStateContext, newPhase: RoomPhase): void {
  const prevPhase = ctx.phase;
  ctx.phase = newPhase;
  ctx.dispatch('room-phase-change', { phase: newPhase, prevPhase });
}

/** 断言当前 phase 在允许范围内，否则抛 RoomInvalidStateError */
function assertPhase(ctx: RoomStateContext, caller: string, ...allowedPhases: RoomPhase[]): void {
  if (!allowedPhases.includes(ctx.phase)) {
    throwError(
      ERROR_FN_NAME,
      `cannot call ${caller}() in phase "${ctx.phase}", expected one of: ${allowedPhases.join(', ')}`,
      RoomInvalidStateError as unknown as ErrorConstructor,
    );
  }
}

/** 断言未被 dispose，否则抛 RoomDisposedError */
function assertNotDisposed(ctx: RoomStateContext, caller: string): void {
  if (ctx.phase === 'disposed') {
    throwError(
      ERROR_FN_NAME,
      `cannot call ${caller}() after dispose`,
      RoomDisposedError as unknown as ErrorConstructor,
    );
  }
}

/** 断言已 joined，否则抛 RoomInvalidStateError */
function assertJoined(ctx: RoomStateContext, caller: string): void {
  if (ctx.phase !== 'joined') {
    throwError(
      ERROR_FN_NAME,
      `cannot call ${caller}() when not joined, current phase: "${ctx.phase}"`,
      RoomInvalidStateError as unknown as ErrorConstructor,
    );
  }
}

export type { RoomStateContext };
export { assertJoined, assertNotDisposed, assertPhase, setPhase };
