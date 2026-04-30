import { describe, expect, test } from 'vitest';
import {
  InvalidOptionsError,
  LockAbortedError,
  LockDisposedError,
  LockRevokedError,
  LockTimeoutError,
  lockData,
  NEVER_TIMEOUT,
  ReadonlyMutationError,
} from './index';

describe('lockData 主入口 / 公开契约', () => {
  describe('常量导出', () => {
    test('NEVER_TIMEOUT 是 symbol 且描述包含签名', () => {
      expect(typeof NEVER_TIMEOUT).toBe('symbol');
      expect(NEVER_TIMEOUT.toString()).toContain('lockData');
      expect(NEVER_TIMEOUT.toString()).toContain('NEVER_TIMEOUT');
    });
  });

  describe('错误类导出', () => {
    test('6 个错误类均可 new 且 instanceof Error', () => {
      // 全部错误类应同时继承 Error 并暴露正确的 name，便于业务侧在 catch 分支上做类型区分
      const errorClasses = [
        { ErrorClass: InvalidOptionsError, name: 'InvalidOptionsError' },
        { ErrorClass: LockAbortedError, name: 'LockAbortedError' },
        { ErrorClass: LockDisposedError, name: 'LockDisposedError' },
        { ErrorClass: LockRevokedError, name: 'LockRevokedError' },
        { ErrorClass: LockTimeoutError, name: 'LockTimeoutError' },
        { ErrorClass: ReadonlyMutationError, name: 'ReadonlyMutationError' },
      ];
      for (const { ErrorClass, name } of errorClasses) {
        const instance = new ErrorClass('test message');
        expect(instance).toBeInstanceOf(Error);
        expect(instance).toBeInstanceOf(ErrorClass);
        expect(instance.name).toBe(name);
        expect(instance.message).toBe('test message');
      }
    });
  });

  describe('lockData 分支 A（同步初始化）', () => {
    test('无 options：返回元组（非 Promise），view 可读，actions 是对象', async () => {
      const result = lockData({ count: 0, label: 'init' });
      // 分支 A 必须是同步返回：类型和运行时都不是 Promise
      expect(result).not.toBeInstanceOf(Promise);

      const [view, actions] = result;
      expect(view.count).toBe(0);
      expect(view.label).toBe('init');
      expect(actions).toBeTypeOf('object');
      expect(actions.update).toBeTypeOf('function');
      expect(actions.replace).toBeTypeOf('function');
      expect(actions.dispose).toBeTypeOf('function');

      await actions.dispose();
    });

    test('view 为深只读视图：直接写入抛 ReadonlyMutationError', async () => {
      const [view, actions] = lockData({ count: 0 });
      // RFC L138 契约：ReadonlyView<T> 禁止直接写入
      expect(() => {
        (view as { count: number }).count = 999;
      }).toThrow(ReadonlyMutationError);

      await actions.dispose();
    });

    test('actions.update 可提交事务：view 读取到新值', async () => {
      const [view, actions] = lockData({ count: 0 });
      await actions.update((draft) => {
        draft.count = 42;
      });
      expect(view.count).toBe(42);

      await actions.dispose();
    });

    test('actions.dispose 可 await 且幂等', async () => {
      const [, actions] = lockData({ value: 1 });
      await actions.dispose();
      // 二次 dispose 应静默返回，不抛错
      await expect(actions.dispose()).resolves.toBeUndefined();
    });
  });

  describe('lockData 类型导出（编译期契约）', () => {
    test('lockData 是函数', () => {
      expect(lockData).toBeTypeOf('function');
    });
  });
});
