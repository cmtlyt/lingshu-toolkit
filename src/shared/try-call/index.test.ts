import { describe, expect, test, vi } from 'vitest';
import { tryCall, tryCallFunc } from './index';

describe('tryCall', () => {
  test('导出检查', () => {
    expect(typeof tryCall).toBe('function');
    expect(typeof tryCallFunc).toBe('function');
  });

  test('tryCall 基本使用', async () => {
    expect(tryCall(() => 1)).toBe(1);
    expect(await tryCall(async () => 1)).toBe(1);
    expect(() =>
      tryCall(() => {
        throw new Error('error');
      }),
    ).toThrowError(Error);
    expect(
      tryCall(
        () => {
          throw new Error('error');
        },
        () => 2,
      ),
    ).toBe(2);
    expect(
      await tryCall(
        async () => {
          throw new Error('error');
        },
        () => 3,
      ),
    ).toBe(3);
    await expect(
      tryCall(async () => {
        throw new Error('error');
      }),
    ).rejects.toThrowError(Error);
    expect(
      tryCall(
        () => 1,
        null,
        (r) => {
          expect(r).toBe(1);
        },
      ),
    ).toBe(1);
    expect(
      tryCall(
        () => {
          throw new Error('error');
        },
        () => 2,
        (r) => {
          expect(r).toBe(2);
        },
      ),
    ).toBe(2);
  });

  test('tryCallFunc 基本使用', async () => {
    const fn = tryCallFunc(() => 1);
    expect(fn()).toBe(1);
    expect(fn()).toBe(1);
    const fn2 = tryCallFunc(async () => 1);
    expect(await fn2()).toBe(1);
    const fn3 = tryCallFunc(
      () => {
        throw new Error('error');
      },
      () => 2,
    );
    expect(fn3()).toBe(2);
    const fn4 = tryCallFunc(
      async () => {
        throw new Error('error');
      },
      () => 3,
    );
    expect(await fn4()).toBe(3);
    const fn5 = tryCallFunc(async () => {
      throw new Error('error');
    });
    await expect(fn5()).rejects.toThrowError(Error);
    const fn6 = tryCallFunc(() => {
      throw new Error('error');
    });
    expect(() => fn6()).toThrowError(Error);
    const fn_ = tryCallFunc((_a: number, b: number) => {
      if (_a % b) {
        throw new Error('error');
      }
      return _a / b;
    });
    expect(fn_(1, 1)).toBe(1);
    expect(fn_(1, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(() => fn_(1, 2)).toThrowError(Error);
    expect(
      tryCallFunc(
        () => 1,
        null,
        (r) => {
          expect(r).toBe(1);
        },
      )(),
    ).toBe(1);
    expect(
      tryCallFunc(
        () => {
          throw new Error('error');
        },
        () => 2,
        (r) => {
          expect(r).toBe(2);
        },
      )(),
    ).toBe(2);

    const a = {
      num: 1,
      foo: tryCallFunc(
        function (this: any) {
          if (this.num++ % 2) {
            throw new Error('error');
          }
          return this.num;
        },
        () => 0,
      ),
    };
    expect(a.foo()).toBe(0);
    expect(a.foo()).toBe(3);
    expect(a.foo.call({ num: 10 })).toBe(11);
  });

  test('边缘情况', () => {
    // @ts-expect-error test
    expect(() => tryCall(undefined)).toThrowError(TypeError);
    // @ts-expect-error test
    expect(() => tryCallFunc(undefined)).toThrowError(TypeError);
  });

  test('报错不处理 finally 应该接受错误参数', () => {
    // 报错但是不处理
    const testList: any[] = [];
    expect(() =>
      tryCall(
        () => {
          throw new Error('error');
        },
        undefined,
        (r) => {
          testList.push(r);
        },
      ),
    ).toThrowError(Error);
    expect(testList[0]).toBeInstanceOf(Error);
  });

  test('执行顺序', () => {
    const testList: any[] = [];
    expect(
      tryCall(
        () => {
          testList.push(1);
        },
        () => {
          testList.push('error');
        },
        (r) => {
          testList.push(r);
        },
      ),
    ).toBeUndefined();
    expect(testList.length).toBe(2);
    expect(testList).toEqual([1, undefined]);
    testList.length = 0;
    // 报错
    expect(
      tryCall(
        () => {
          testList.push(1);
          throw 'test';
        },
        (err) => {
          testList.push('error');
          return err;
        },
        (r) => {
          testList.push(r);
        },
      ),
    ).toBe('test');
    expect(testList.length).toBe(3);
    expect(testList).toEqual([1, 'error', 'test']);
    testList.length = 0;
  });

  test('onError 中报错', () => {
    expect(() =>
      tryCall(
        () => {
          throw new Error('error');
        },
        () => {
          throw new Error('error2');
        },
      ),
    ).toThrowError('error2');
  });

  test('onFinal 中报错', () => {
    expect(() =>
      tryCall(
        () => {
          throw new Error('error');
        },
        undefined,
        () => {
          throw new Error('error2');
        },
      ),
    ).toThrowError('error2');
  });

  test('全报错', () => {
    const errorList: any = [];
    expect(() =>
      tryCall(
        () => {
          throw new Error('error');
        },
        () => {
          throw new Error('error2');
        },
        (r) => {
          errorList.push(r.message);
          throw new Error('error3');
        },
      ),
    ).toThrowError('error3');
    expect(errorList).toEqual(['error2']);
  });

  test('全事件 this 一致', () => {
    const testList: any[] = new Array(3).fill(null);
    const testThis = { num: 1 };
    expect(
      tryCallFunc(
        function (this: any) {
          testList[0] = this;
          throw new Error('error');
        },
        function (this: any) {
          testList[1] = this;
        },
        function (this: any) {
          testList[2] = this;
        },
      ).call(testThis),
    ).toBeUndefined();
    expect(testList[0]).toStrictEqual(testThis);
    expect(testList[1]).toStrictEqual(testThis);
    expect(testList[2]).toStrictEqual(testThis);
  });

  test('延迟报错', async () => {
    vi.useFakeTimers();
    await expect(
      tryCall(
        async () => {
          await vi.advanceTimersByTimeAsync(10);
          throw new Error('error');
        },
        (err) => err.message,
      ),
    ).resolves.toBe('error');
    vi.useRealTimers();
  });
});
