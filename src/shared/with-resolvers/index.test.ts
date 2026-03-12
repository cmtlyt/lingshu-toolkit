import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { withResolvers } from './index';

describe('withResolvers', () => {
  describe('原生 Promise.withResolvers 支持', () => {
    test('应该导出函数', () => {
      expect(withResolvers).toBeTypeOf('function');
    });

    test('应该返回包含 promise、resolve 和 reject 的对象', () => {
      const resolver = withResolvers<void>();

      expect(resolver).toHaveProperty('promise');
      expect(resolver).toHaveProperty('resolve');
      expect(resolver).toHaveProperty('reject');

      expect(resolver.promise).toBeInstanceOf(Promise);
      expect(resolver.resolve).toBeTypeOf('function');
      expect(resolver.reject).toBeTypeOf('function');
    });

    test('resolve 应该正确解析 promise', async () => {
      const resolver = withResolvers<string>();
      const expectedValue = 'test value';

      resolver.resolve(expectedValue);

      await expect(resolver.promise).resolves.toBe(expectedValue);
    });

    test('reject 应该正确拒绝 promise', async () => {
      const resolver = withResolvers<string>();
      const expectedError = new Error('test error');

      resolver.reject(expectedError);

      await expect(resolver.promise).rejects.toThrow('test error');
    });

    test('reject 可以接受任意原因', async () => {
      const resolver = withResolvers<void>();
      const rejectionReason = 'custom reason';

      resolver.reject(rejectionReason);

      await expect(resolver.promise).rejects.toEqual(rejectionReason);
    });

    test('支持泛型类型推断', async () => {
      interface TestType {
        id: number;
        name: string;
      }

      const resolver = withResolvers<TestType>();
      const expectedValue: TestType = { id: 1, name: 'test' };

      resolver.resolve(expectedValue);

      await expect(resolver.promise).resolves.toEqual(expectedValue);
    });

    test('可以多次调用 resolve 但只有第一次生效', async () => {
      const resolver = withResolvers<number>();
      const firstValue = 1;
      const secondValue = 2;

      resolver.resolve(firstValue);
      resolver.resolve(secondValue);

      await expect(resolver.promise).resolves.toBe(firstValue);
    });

    test('可以多次调用 reject 但只有第一次生效', async () => {
      const resolver = withResolvers<void>();
      const firstError = new Error('first error');
      const secondError = new Error('second error');

      resolver.reject(firstError);
      resolver.reject(secondError);

      await expect(resolver.promise).rejects.toThrow('first error');
    });

    test('resolve 后调用 reject 应该无效', async () => {
      const resolver = withResolvers<string>();

      resolver.resolve('resolved');
      resolver.reject(new Error('rejected'));

      await expect(resolver.promise).resolves.toBe('resolved');
    });

    test('reject 后调用 resolve 应该无效', async () => {
      const resolver = withResolvers<string>();

      resolver.reject(new Error('rejected'));
      resolver.resolve('resolved');

      await expect(resolver.promise).rejects.toThrow('rejected');
    });

    test('支持 void 类型', async () => {
      const resolver = withResolvers<void>();

      resolver.resolve();

      await expect(resolver.promise).resolves.toBeUndefined();
    });

    test('支持 undefined 类型', async () => {
      const resolver = withResolvers<undefined>();

      resolver.resolve(undefined);

      await expect(resolver.promise).resolves.toBeUndefined();
    });

    test('支持 null 类型', async () => {
      const resolver = withResolvers<null>();

      resolver.resolve(null);

      await expect(resolver.promise).resolves.toBeNull();
    });

    test('支持复杂对象类型', async () => {
      interface ComplexObject {
        nested: {
          value: number;
        };
        array: string[];
      }

      const resolver = withResolvers<ComplexObject>();
      const complexValue: ComplexObject = {
        nested: { value: 42 },
        array: ['a', 'b', 'c'],
      };

      resolver.resolve(complexValue);

      await expect(resolver.promise).resolves.toEqual(complexValue);
    });

    test('支持数组类型', async () => {
      const resolver = withResolvers<number[]>();
      const arrayValue = [1, 2, 3, 4, 5];

      resolver.resolve(arrayValue);

      await expect(resolver.promise).resolves.toEqual(arrayValue);
    });

    test('可以与 async/await 配合使用', async () => {
      const resolver = withResolvers<number>();

      setTimeout(() => resolver.resolve(42), 10);

      const result = await resolver.promise;
      expect(result).toBe(42);
    });

    test('可以在 promise 链中使用', async () => {
      const resolver = withResolvers<number>();

      resolver.resolve(10);

      const result = await resolver.promise.then((value) => value * 2);
      expect(result).toBe(20);
    });

    test('可以与 Promise.all 配合使用', async () => {
      const resolver1 = withResolvers<number>();
      const resolver2 = withResolvers<number>();
      const resolver3 = withResolvers<number>();

      setTimeout(() => resolver1.resolve(1), 10);
      setTimeout(() => resolver2.resolve(2), 10);
      setTimeout(() => resolver3.resolve(3), 10);

      const results = await Promise.all([resolver1.promise, resolver2.promise, resolver3.promise]);
      expect(results).toEqual([1, 2, 3]);
    });

    test('可以与 Promise.race 配合使用', async () => {
      const resolver1 = withResolvers<number>();
      const resolver2 = withResolvers<number>();

      setTimeout(() => resolver1.resolve(1), 10);
      setTimeout(() => resolver2.resolve(2), 20);

      const result = await Promise.race([resolver1.promise, resolver2.promise]);
      expect(result).toBe(1);
    });

    test('可以与 Promise.allSettled 配合使用', async () => {
      const resolver1 = withResolvers<number>();
      const resolver2 = withResolvers<number>();

      resolver1.resolve(1);
      resolver2.reject(new Error('error'));

      const results = await Promise.allSettled([resolver1.promise, resolver2.promise]);

      expect(results[0].status).toBe('fulfilled');
      if (results[0].status === 'fulfilled') {
        expect(results[0].value).toBe(1);
      }

      expect(results[1].status).toBe('rejected');
      if (results[1].status === 'rejected') {
        expect(results[1].reason.message).toBe('error');
      }
    });

    test('可以在 try-catch 中使用', async () => {
      const resolver = withResolvers<number>();

      try {
        resolver.reject(new Error('caught error'));
        await resolver.promise;
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toBe('caught error');
      }
    });

    test('支持函数类型', async () => {
      type FunctionType = (x: number) => string;
      const resolver = withResolvers<FunctionType>();
      const fn: FunctionType = (x) => `value: ${x}`;

      resolver.resolve(fn);

      const result = await resolver.promise;
      expect(result(42)).toBe('value: 42');
    });
  });

  describe('降级分支 (Promise.withResolvers 不可用)', () => {
    let originalWithResolvers: typeof Promise.withResolvers | undefined;

    beforeEach(() => {
      // 保存原始的 Promise.withResolvers
      originalWithResolvers = Promise.withResolvers;
      // 模拟 Promise.withResolvers 不存在
      (Promise as Partial<typeof Promise>).withResolvers = undefined;
    });

    afterEach(() => {
      // 恢复原始的 Promise.withResolvers
      if (originalWithResolvers) {
        Promise.withResolvers = originalWithResolvers;
      }
    });

    test('降级分支应该正常工作', async () => {
      const resolver = withResolvers<string>();

      expect(resolver).toHaveProperty('promise');
      expect(resolver).toHaveProperty('resolve');
      expect(resolver).toHaveProperty('reject');

      resolver.resolve('polyfill test');

      await expect(resolver.promise).resolves.toBe('polyfill test');
    });

    test('降级分支的 resolve 应该正确解析 promise', async () => {
      const resolver = withResolvers<number>();
      resolver.resolve(42);

      await expect(resolver.promise).resolves.toBe(42);
    });

    test('降级分支的 reject 应该正确拒绝 promise', async () => {
      const resolver = withResolvers<void>();
      const error = new Error('polyfill error');
      resolver.reject(error);

      await expect(resolver.promise).rejects.toThrow('polyfill error');
    });

    test('降级分支支持泛型类型', async () => {
      interface TestType {
        value: string;
      }

      const resolver = withResolvers<TestType>();
      resolver.resolve({ value: 'test' });

      await expect(resolver.promise).resolves.toEqual({ value: 'test' });
    });

    test('降级分支可以与 async/await 配合使用', async () => {
      const resolver = withResolvers<string>();

      setTimeout(() => resolver.resolve('async test'), 10);

      const result = await resolver.promise;
      expect(result).toBe('async test');
    });

    test('降级分支可以在 promise 链中使用', async () => {
      const resolver = withResolvers<number>();
      resolver.resolve(10);

      const result = await resolver.promise.then((value) => value * 3);
      expect(result).toBe(30);
    });

    test('降级分支可以与 Promise.all 配合使用', async () => {
      const resolver1 = withResolvers<number>();
      const resolver2 = withResolvers<number>();

      resolver1.resolve(1);
      resolver2.resolve(2);

      const results = await Promise.all([resolver1.promise, resolver2.promise]);
      expect(results).toEqual([1, 2]);
    });

    test('降级分支可以与 Promise.race 配合使用', async () => {
      const resolver1 = withResolvers<number>();
      const resolver2 = withResolvers<number>();

      setTimeout(() => resolver1.resolve(1), 10);
      setTimeout(() => resolver2.resolve(2), 20);

      const result = await Promise.race([resolver1.promise, resolver2.promise]);
      expect(result).toBe(1);
    });

    test('降级分支可以与 Promise.allSettled 配合使用', async () => {
      const resolver1 = withResolvers<number>();
      const resolver2 = withResolvers<number>();

      resolver1.resolve(1);
      resolver2.reject(new Error('error'));

      const results = await Promise.allSettled([resolver1.promise, resolver2.promise]);

      expect(results[0].status).toBe('fulfilled');
      if (results[0].status === 'fulfilled') {
        expect(results[0].value).toBe(1);
      }

      expect(results[1].status).toBe('rejected');
      if (results[1].status === 'rejected') {
        expect(results[1].reason.message).toBe('error');
      }
    });

    test('降级分支多次调用 resolve 只有第一次生效', async () => {
      const resolver = withResolvers<number>();
      resolver.resolve(1);
      resolver.resolve(2);

      await expect(resolver.promise).resolves.toBe(1);
    });

    test('降级分支多次调用 reject 只有第一次生效', async () => {
      const resolver = withResolvers<void>();
      resolver.reject(new Error('first'));
      resolver.reject(new Error('second'));

      await expect(resolver.promise).rejects.toThrow('first');
    });

    test('降级分支 resolve 后调用 reject 无效', async () => {
      const resolver = withResolvers<string>();
      resolver.resolve('resolved');
      resolver.reject(new Error('rejected'));

      await expect(resolver.promise).resolves.toBe('resolved');
    });

    test('降级分支 reject 后调用 resolve 无效', async () => {
      const resolver = withResolvers<string>();
      resolver.reject(new Error('rejected'));
      resolver.resolve('resolved');

      await expect(resolver.promise).rejects.toThrow('rejected');
    });
  });
});
