import { describe, expect, test } from 'vitest';
import {
  InvalidOptionsError,
  LockAbortedError,
  LockDisposedError,
  LockRevokedError,
  LockTimeoutError,
  ReadonlyMutationError,
} from '@/shared/lock-data/errors';

describe('lock-data 错误类型', () => {
  test('运行时故障类错误继承 Error 并携带正确 name', () => {
    const cases = [
      { Ctor: LockTimeoutError, name: 'LockTimeoutError' },
      { Ctor: LockRevokedError, name: 'LockRevokedError' },
      { Ctor: LockDisposedError, name: 'LockDisposedError' },
      { Ctor: LockAbortedError, name: 'LockAbortedError' },
    ];

    // 数组遍历优先使用索引 for 循环（见 IMPLEMENTATION.md 开发守则「代码风格 - 循环形式」）
    for (let i = 0; i < cases.length; i++) {
      const { Ctor, name } = cases[i];
      const err = new Ctor('msg');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.message).toBe('msg');
    }
  });

  test('参数误用类错误继承 TypeError', () => {
    const readonlyErr = new ReadonlyMutationError('ro');
    expect(readonlyErr).toBeInstanceOf(TypeError);
    expect(readonlyErr.name).toBe('ReadonlyMutationError');

    const invalidErr = new InvalidOptionsError('bad');
    expect(invalidErr).toBeInstanceOf(TypeError);
    expect(invalidErr.name).toBe('InvalidOptionsError');
  });

  test('错误类可配合 shared/throw-error 的 cause 选项传递原始错误', () => {
    // 错误类本身只接受 message 单参，便于与 ErrorConstructor 兼容；
    // cause 传递由 shared/throw-error#createError 负责注入，详见 errors 子模块注释
    const cause = new Error('original');
    const err = new LockDisposedError('msg');
    err.cause = cause;
    expect(err.cause).toBe(cause);
  });
});
