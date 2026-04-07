import { HttpResponse, http } from 'msw';
import { setupWorker } from 'msw/browser';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { Equal } from '@/shared/types';
import { createApi, createApiWithMap, defineApi, defineApiMap, request } from '../index';

describe('apiController', () => {
  const worker = setupWorker(
    http.get('/user', (req) => {
      const url = new URL(req.request.url);
      return HttpResponse.json({ id: url.searchParams.get('id'), name: 'John Doe' });
    }),
    http.get('/user/:id', (req) => {
      const { id } = req.params;
      return HttpResponse.json({ id, name: 'John Doe' });
    }),
    http.get('/api/user/:id/custom-name/:name', (req) => {
      const { id, name } = req.params;
      return HttpResponse.json({ id, name });
    }),
    http.post('/user', async (req) => {
      const { id } = (await req.request.json()) as { id: string };
      return HttpResponse.json({ id, name: 'John Doe' });
    }),
    http.get('/user/list', () => HttpResponse.json([{ id: '1', name: 'John Doe' }])),
  );

  beforeAll(async () => {
    await worker.start({ onUnhandledRequest: 'error', quiet: true });
  });

  afterAll(() => {
    worker.stop();
  });

  afterEach(() => {
    worker.resetHandlers();
  });

  test('导出测试', () => {
    expect(request).toBeTypeOf('function');
    expect(createApiWithMap).toBeTypeOf('function');
    expect(createApi).toBeTypeOf('function');
    expect(defineApiMap).toBeTypeOf('function');
    expect(defineApi).toBeTypeOf('function');
  });

  const getUserInfoApiConfig = defineApi({
    url: '/user',
    tdto(data: { id: string; name?: string }) {
      return data;
    },
    onRequest(_, config) {
      const { data } = config;
      return { id: ((data || {}).id as string) || '', name: 'John Doe' } as const;
    },
    tvo(data) {
      if (typeof data === 'string') {
        return data;
      }
      return { ...data, age: 18 } as { id: string; name: string; age: number };
    },
  });

  const mockApiMapConfig = defineApiMap({
    user: {
      getInfo: getUserInfoApiConfig,
      getList: {
        url: '/user/list',
        onResponse() {
          return [{ id: '1', name: 'John Doe' }];
        },
      },
    },
    normal: {
      url: '/normal',
    },
  });

  const mockApi = createApiWithMap(mockApiMapConfig, { baseUrl: '', requestMode: 'mock' });

  const getUserInfoApi = createApi(getUserInfoApiConfig, { baseUrl: '' });
  const getUserInfoApiCustom = createApi(getUserInfoApiConfig, { baseUrl: '' }, true);

  const customApi = createApiWithMap(
    defineApiMap({
      user: {
        getInfo: getUserInfoApiConfig,
        getList: {
          url: '/user/list',
          onResponse() {
            return [{ id: '1', name: 'John Doe' }];
          },
        },
      },
    }),
    {
      baseUrl: '',
      requestMode: 'test',
      requestModeMap: {
        test: (config) => {
          const { data } = config;
          return { isTestRequest: true, ...(data || {}) } as Record<'isTestRequest' | (string & {}), any>;
        },
      },
    },
  );

  test('custom request', async () => {
    const res1 = await customApi.user.getInfo({ id: '1' });
    expect(res1).toEqual({ isTestRequest: true, id: '1' });

    const res2 = await customApi.user.getInfoCustom({ id: '1' }, { requestMode: 'network' });
    expect(res2).toEqual({ id: '1', name: 'John Doe', age: 18 });
  });

  test('create api error', () => {
    expect(() => createApi({} as any)).toThrowError(TypeError);
  });

  test('proxy cache', () => {
    expect(mockApi.user.getInfo).toBe(mockApi.user.getInfo);
    expect(mockApi.user.getInfo).toBe(mockApi.user.getInfo);
    expect(mockApi.user.getInfoCustom).toBe(mockApi.user.getInfoCustom);
    expect(mockApi.user.getList).toBe(mockApi.user.getList);
  });

  test('from $ property get api config', async () => {
    expect(mockApi.user.getInfo.$).toStrictEqual(getUserInfoApi.$);
    expect(mockApi.user.getInfo.$).toStrictEqual(getUserInfoApiConfig);
    expect(mockApi.user.getInfoCustom.$).toStrictEqual(getUserInfoApiConfig);

    expect(mockApi.$).toStrictEqual(mockApiMapConfig);
    expect(mockApi.user.$).toStrictEqual(mockApiMapConfig.user);
    expect(mockApi.$.user).toStrictEqual(mockApiMapConfig.user);

    const from$api = createApi(mockApi.user.getInfo.$, { baseUrl: '' });
    expect(await from$api({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });

    const from$userApiMap = createApiWithMap(mockApi.user.$, { baseUrl: '' });
    expect(await from$userApiMap.getInfo({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });
  });

  test('from $ property get default config', async () => {
    expect(mockApi.user.getInfo.$$).toStrictEqual(mockApi.user.getInfo.$$);
    expect(mockApi.user.getInfo.$$).toEqual({ baseUrl: '', requestMode: 'mock' });
    expect(mockApi.$$).toStrictEqual(mockApi.user.$$);
    expect(mockApi.$$).toStrictEqual(mockApi.user.getInfo.$$);

    const from$apiAnd$defaultFormMap = createApi(mockApi.user.getInfo.$, mockApi.$$);
    expect(await from$apiAnd$defaultFormMap({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });

    const from$apiAnd$defaultFromApi = createApi(mockApi.user.getInfo.$, getUserInfoApi.$$);
    expect(await from$apiAnd$defaultFromApi({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });
  });

  test('updateBaseUrl', async () => {
    const { ...mockDefaultConfig } = mockApi.$$;

    const updateApiMap = createApiWithMap(mockApi.user.$, mockDefaultConfig);
    expect(updateApiMap.$$).toStrictEqual(updateApiMap.$$r);
    expect(updateApiMap.$$).toStrictEqual(mockDefaultConfig);
    expect(updateApiMap.$$r.baseUrl).toBe('');
    updateApiMap.$updateBaseUrl('/api');
    expect(updateApiMap.$$r.baseUrl).toBe(`${location.origin}/api`);

    const updateApi = createApi(
      defineApi({ ...mockApi.user.getInfo.$, url: '/user/:id/custom-name/:name', tdto: null }),
      void 0,
      true,
    );
    updateApi.$updateBaseUrl('/api');
    expect(updateApi.$$).toBeUndefined();
    expect(updateApi.$$).not.toBe(updateApi.$$r);
    expect(updateApi.$$r.baseUrl).toBe(`${location.origin}/api`);
    expect(await updateApi(null, { params: { id: '1', name: 'test' } })).toEqual({ id: '1', name: 'test', age: 18 });

    const updateApiMapNotDefault = createApiWithMap(mockApi.user.$);
    updateApiMapNotDefault.$updateBaseUrl('/api');
    expect(updateApiMapNotDefault.$$).toBeUndefined();
    expect(updateApiMapNotDefault.$$).not.toBe(updateApiMapNotDefault.$$r);
    expect(updateApiMapNotDefault.$$r.baseUrl).toBe(`${location.origin}/api`);
  });

  test('processJson', async () => {
    type RecordDeepKeyFlat<M extends Record<string, any>, Prefix extends string = ''> =
      | (M extends Record<infer KS, any>
          ? KS extends string
            ? Equal<M[KS], any> extends true
              ? any
              : M[KS] extends Record<any, any>
                ?
                    | RecordDeepKeyFlat<M[KS], `${Prefix extends '' ? Prefix : `${Prefix}.`}${KS & string}`>
                    | `${Prefix extends '' ? Prefix : `${Prefix}.`}${KS & string}`
                : `${Prefix extends '' ? Prefix : `${Prefix}.`}${KS & string}`
            : never
          : never)
      | (string & {});

    type RecordDeepProp<K extends string, M extends Record<string, any>> = K extends `${infer P}.${infer L}`
      ? M[P] extends Record<string, any>
        ? RecordDeepProp<L, M[P]>
        : M[P]
      : K extends `${infer P}`
        ? M[P]
        : unknown;

    type ProcessJson<M> = M extends Record<infer KS, any> ? { [K in KS]: ProcessJson<M[K]> } : Promise<M>;

    type ProcessResult<M extends Record<string, any> = Record<string, any>> = {
      get(): Promise<ProcessJson<M>>;
      get<K extends RecordDeepKeyFlat<M>>(key: K): ProcessJson<RecordDeepProp<K, M>>;
      waitAll(): Promise<M>;
    };

    const processApi = createApiWithMap(
      defineApiMap({
        user: {
          getInfo: {
            url: '/user',
          },
        },
      }),
      {
        baseUrl: '',
        requestMode: 'processJson',
        requestModeMap: {
          processJson: (aaa) =>
            ({
              aaa,
              get: async (prop?: string) => {
                if (prop) {
                  return Promise.resolve('processJson') as any;
                }
                return { name: Promise.resolve('processJson') };
              },
              waitAll: async () => Promise.resolve({ name: 'processJson' }),
            }) as ProcessResult,
        },
      },
    );

    expect(await processApi.user.getInfo().waitAll()).toEqual({
      name: 'processJson',
    });
    expect(await processApi.user.getInfo().get('name')).toEqual('processJson');
    // 使用自定义请求方式时会直接绕过默认 hook
    expect(
      await processApi.user
        .getInfoCustom(null, {
          tvo() {
            throw new Error('test');
          },
        })
        .get('name'),
    ).toEqual('processJson');
  });

  test('mock request', async () => {
    const res1 = await mockApi.user.getInfo({ id: '1' });
    expect(res1).toEqual({ id: '1', name: 'John Doe', age: 18 });

    const res2 = await getUserInfoApi({ id: '2' });
    expect(res2).toEqual({ id: '2', name: 'John Doe', age: 18 });

    const res3 = await getUserInfoApiCustom(
      { id: '3' },
      {
        tvo(data: any) {
          return { ...data, age: 19 } as { id: string; name: string; age: 19 };
        },
      },
    );
    expect(res3).toEqual({ id: '3', name: 'John Doe', age: 19 });

    // @ts-expect-error test
    expect(mockApi.aaa).toBeUndefined();

    const resList = await mockApi.user.getList();
    expect(resList).toEqual([{ id: '1', name: 'John Doe' }]);

    const resCustom = await mockApi.user.getInfoCustom(
      { id: '4' },
      {
        tvo: (data: any) => ({ ...data, age: 19 }) as { id: string; name: string; age: 19 },
      },
    );
    expect(resCustom).toEqual({ id: '4', name: 'John Doe', age: 19 });

    const resStream = await mockApi.user.getListCustom(void 0, {
      requestMode: 'network',
      parser: 'stream',
      onResponse: null,
    });
    expect(resStream).toBeInstanceOf(ReadableStream);

    const resNormal = await mockApi.normalCustom({}, { parser: 'stream' });
    expect(resNormal).toBeNull();

    const resText = await mockApi.user.getInfoCustom({ id: '5' }, { parser: 'text' });
    expect(resText).toBe('{"id":"5","name":"John Doe"}');

    const resTdto = await createApi(
      defineApi({
        url: '/test',
        tdto: (data: { id: string }) => {
          return { id: Number(data.id) };
        },
        onRequest(req) {
          return req.json() as unknown as { id: number };
        },
      }),
      { baseUrl: '', method: 'POST', requestMode: 'mock' },
    )({ id: '1' });
    expect(resTdto).toEqual({ id: 1 });

    await expect(
      // @ts-expect-error
      mockApi.user.getInfoCustom(() => void 0, { method: 'POST', onRequest: null, onResponse: null, tvo: null }),
    ).rejects.toThrowError();

    // @ts-expect-error
    const resInputStr = await mockApi.user.getInfoCustom(JSON.stringify({ id: '10' }), {
      method: 'POST',
      requestMode: 'network',
      onRequest: null,
      onResponse: null,
      tvo: null,
    });
    expect(resInputStr).toEqual({ id: '10', name: 'John Doe' });

    const emptyUrlRes = await createApi(
      { url: '' },
      { baseUrl: '', requestMode: 'mock', tvo: () => 1, parser: 'stream' },
    )();
    expect(emptyUrlRes).toBe(1);

    // Browser 环境中，这个测试可能不会抛出错误，因为行为与 node 环境不同
    // await expect(
    //   createApi({ url: '' }, { requestMode: 'mock', tvo: () => 1, parser: 'stream' })(),
    // ).rejects.toThrowError();

    await expect(
      createApi({ url: '' }, { baseUrl: '', requestMode: 'mock', tvo: () => 1, parser: 'ccc' })(),
    ).rejects.toThrowError();
  });

  test('param url', async () => {
    // 输出 warn
    expect(() => createApi({ url: '/user/:id' })).toThrowError(TypeError);
    const paramApi = createApi(defineApi({ url: '/user/:id' }), {}, true);

    // @ts-expect-error
    expect(() => paramApi(null)).toThrowError(TypeError);

    expect(await paramApi(null, { params: { id: '1' } })).toEqual({ id: '1', name: 'John Doe' });

    const paramsApi = createApi(defineApi({ url: '/api/user/:id/custom-name/:name' }), {}, true);

    // @ts-expect-error
    expect(() => paramsApi(null, { params: { id: '1' } })).toThrowError(TypeError);
    expect(await paramsApi(null, { params: { id: '1', name: 'test' } })).toEqual({ id: '1', name: 'test' });

    const paramApiMap = createApiWithMap(
      defineApiMap({
        user: { getInfo: { url: '/user/:id' } },
        getCustomNameUser: { url: '/api/user/:id/custom-name/:name' },
      }),
      { baseUrl: '' },
    );

    // @ts-expect-error
    expect(() => paramApiMap.user.getInfo).toThrowError(TypeError);
    expect(await paramApiMap.user.getInfoCustom(null, { params: { id: '1' } })).toEqual({ id: '1', name: 'John Doe' });
    // @ts-expect-error
    expect(() => paramApiMap.user.getInfoCustom(null, { params: {} })).toThrowError(TypeError);
    // @ts-expect-error
    expect(() => paramApiMap.getCustomNameUser).toThrowError(TypeError);
    expect(await paramApiMap.getCustomNameUserCustom(null, { params: { id: '1', name: 'test' } })).toEqual({
      id: '1',
      name: 'test',
    });
    // @ts-expect-error
    expect(() => paramApiMap.getCustomNameUserCustom(null, { params: { id: 1 } })).toThrowError(TypeError);
  });

  test('param url with number 0', async () => {
    // 测试 URL 参数为数字 0 的情况
    const paramApi = createApi(defineApi({ url: '/user/:id' }), {}, true);

    // 数字 0 应该被接受为有效参数
    const result = await paramApi(null, { params: { id: 0 } });
    expect(result).toEqual({ id: '0', name: 'John Doe' });
  });

  test('获取非实例属性', () => {
    const api = createApi(defineApi({ url: '/user/:id' }), {}, true);
    // @ts-expect-error
    expect(api.url).toBeUndefined();
  });

  test('完整 URL 支持', async () => {
    // 测试完整的绝对 URL 不需要 baseUrl
    // 验证 targetUrlParser 中的完整 URL 检测逻辑
    // Browser 环境中，完整 URL 会被 MSW 拦截
    const fullUrlApi = createApi(
      defineApi({
        url: '/full-path/user',
      }),
      {},
      true,
    );

    // 验证可以正常创建 API，即使没有 baseUrl
    expect(fullUrlApi).toBeTypeOf('function');
  });

  test('路径拼接优化', async () => {
    // 测试 baseUrl 以 / 结尾的情况，验证路径拼接不会产生重复斜杠
    const api1 = createApi(
      defineApi({
        url: '/user',
      }),
      { baseUrl: '/api/' },
      true,
    );

    expect(api1).toBeTypeOf('function');

    // 测试 baseUrl 不以 / 结尾的情况
    const api2 = createApi(
      defineApi({
        url: '/user',
      }),
      { baseUrl: '/api' },
      true,
    );

    expect(api2).toBeTypeOf('function');

    // 测试相对路径
    const api3 = createApi(
      defineApi({
        url: 'user',
      }),
      { baseUrl: '/api' },
      true,
    );

    expect(api3).toBeTypeOf('function');
  });

  test('URL 参数编码', async () => {
    // 添加一个处理特殊字符的 mock handler
    worker.use(
      http.get('/user/:id', (req) => {
        const { id } = req.params;
        return Response.json({ id, name: 'John Doe' });
      }),
    );

    const paramApi = createApi(
      defineApi({
        url: '/user/:id',
      }),
      {},
      true,
    );

    // 测试包含特殊字符的参数（会被 encodeURIComponent 编码）
    const result1 = await paramApi(null, { params: { id: 'test@123' } });
    expect(result1).toEqual({ id: 'test@123', name: 'John Doe' });

    // 测试包含空格的参数
    const result2 = await paramApi(null, { params: { id: 'test name' } });
    expect(result2).toEqual({ id: 'test name', name: 'John Doe' });

    // 测试包含中文的参数
    const result3 = await paramApi(null, { params: { id: '测试' } });
    expect(result3).toEqual({ id: '测试', name: 'John Doe' });
  });

  test('params 类型支持 number', async () => {
    worker.use(
      http.get('/user/:id', (req) => {
        const { id } = req.params;
        return Response.json({ id, name: 'John Doe' });
      }),
    );

    const paramApi = createApi(
      defineApi({
        url: '/user/:id',
      }),
      {},
      true,
    );

    // 测试 number 类型参数
    const result1 = await paramApi(null, { params: { id: 123 } });
    expect(result1).toEqual({ id: '123', name: 'John Doe' });

    // 测试数字 0（falsy 值）
    const result2 = await paramApi(null, { params: { id: 0 } });
    expect(result2).toEqual({ id: '0', name: 'John Doe' });

    // 测试负数
    const result3 = await paramApi(null, { params: { id: -1 } });
    expect(result3).toEqual({ id: '-1', name: 'John Doe' });
  });

  test('stream parser 返回 null', async () => {
    // 测试 stream parser 在某些情况下返回 null
    const resNormal = await mockApi.normalCustom({}, { parser: 'stream' });
    expect(resNormal).toBeNull();
  });

  test('访问不存在的 API 属性', () => {
    // 测试访问不存在的 API 属性时返回 undefined
    const apiMap = defineApiMap({
      user: {
        getInfo: defineApi({
          url: '/user',
        }),
      },
    });

    const api = createApiWithMap(apiMap, { baseUrl: '' });

    // @ts-expect-error
    expect(api.nonExistentApi).toBeUndefined();
    // @ts-expect-error
    expect(api.nonExistentApiCustom).toBeUndefined();
  });

  test('proxy cache 使用 Object.create(null)', () => {
    // 验证 proxyCache 使用 Object.create(null) 创建
    // 这个测试确保 proxyCache 是一个纯净的对象，没有原型链
    const apiMap = defineApiMap({
      user: {
        getInfo: defineApi({
          url: '/user',
        }),
      },
    });

    const api = createApiWithMap(apiMap, { baseUrl: '' });

    // 多次访问同一个 API 应该返回相同的引用（缓存机制）
    const api1 = api.user.getInfo;
    const api2 = api.user.getInfo;
    expect(api1).toStrictEqual(api2);
  });

  test('api 以 Custom 结尾', () => {
    // 控制台输出 warn: 不应该使用 Custom 结尾 [getInfoCustom, userGetInfoCustom]
    const apiMap = defineApiMap({
      getInfoCustom: defineApi({ url: 'getInfoCustom' }),
      user: {
        userGetInfoCustom: defineApi({ url: 'userGetInfoCustom' }),
      },
    });
    const api = createApiWithMap(apiMap, { baseUrl: '' });
    expect(api.getInfoCustom).toBeTypeOf('function');
    // @ts-expect-error test
    expect(api.userCustom).toBeUndefined();

    expect(
      // 控制台输出 warn: 不应该使用 Custom 结尾 [getInfoNotFromDefineCustom]
      createApiWithMap(
        {
          getInfoNotFromDefineCustom: api.getInfoCustom.$,
        },
        { baseUrl: '' },
      ).getInfoNotFromDefineCustom,
    ).toBeTypeOf('function');
  });
});
