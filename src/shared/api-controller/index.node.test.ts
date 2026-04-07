import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { Equal } from '@/shared/types';
import { createApi, createApiWithMap, defineApi, defineApiMap, request } from './index';

describe('apiController', () => {
  const server = setupServer(
    http.get('https://api.example.com/user', (req) => {
      const url = new URL(req.request.url);
      return HttpResponse.json({ id: url.searchParams.get('id'), name: 'John Doe' });
    }),
    http.get('https://api.example.com/user/:id', (req) => {
      const { id } = req.params;
      return HttpResponse.json({ id, name: 'John Doe' });
    }),
    http.get('https://api.example.com/api/user/:id/custom-name/:name', (req) => {
      const { id, name } = req.params;
      return HttpResponse.json({ id, name });
    }),
    http.post('https://api.example.com/user', async (req) => {
      const { id } = (await req.request.json()) as { id: string };
      return HttpResponse.json({ id, name: 'John Doe' });
    }),
    http.get('https://api.example.com/user/list', () => HttpResponse.json([{ id: '1', name: 'John Doe' }])),
  );

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });

  afterAll(() => {
    server.close();
  });

  afterEach(() => {
    server.resetHandlers();
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

  const mockApi = createApiWithMap(mockApiMapConfig, { baseUrl: 'https://api.example.com', requestMode: 'mock' });

  const getUserInfoApi = createApi(getUserInfoApiConfig, { baseUrl: 'https://api.example.com' });
  const getUserInfoApiCustom = createApi(getUserInfoApiConfig, { baseUrl: 'https://api.example.com' }, true);

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
      baseUrl: 'https://api.example.com',
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

    const from$api = createApi(mockApi.user.getInfo.$, { baseUrl: 'https://api.example.com' });
    expect(await from$api({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });

    const from$userApiMap = createApiWithMap(mockApi.user.$, { baseUrl: 'https://api.example.com' });
    expect(await from$userApiMap.getInfo({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });
  });

  test('from $$ property get default config', async () => {
    expect(mockApi.user.getInfo.$$).toStrictEqual(mockApi.user.getInfo.$$);
    expect(mockApi.user.getInfo.$$).toEqual({ baseUrl: 'https://api.example.com', requestMode: 'mock' });
    expect(mockApi.$$).toStrictEqual(mockApi.user.$$);
    expect(mockApi.$$).toStrictEqual(mockApi.user.getInfo.$$);

    const from$apiAnd$$defaultFormMap = createApi(mockApi.user.getInfo.$, mockApi.$$);
    expect(await from$apiAnd$$defaultFormMap({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });

    const from$apiAnd$$defaultFromApi = createApi(mockApi.user.getInfo.$, getUserInfoApi.$$);
    expect(await from$apiAnd$$defaultFromApi({ id: '1' })).toEqual({ id: '1', name: 'John Doe', age: 18 });
  });

  test('updateBaseUrl', async () => {
    const { ...mockDefaultConfig } = mockApi.$$;

    const updateApiMap = createApiWithMap(mockApi.user.$, mockDefaultConfig);
    expect(updateApiMap.$$).toStrictEqual(updateApiMap.$$r);
    expect(updateApiMap.$$).toStrictEqual(mockDefaultConfig);
    expect(updateApiMap.$$.baseUrl).toBe('https://api.example.com');
    updateApiMap.$updateBaseUrl('https://api.example.com/api');
    expect(updateApiMap.$$.baseUrl).toBe('https://api.example.com/api');

    const updateApi = createApi(
      defineApi({ ...mockApi.user.getInfo.$, url: '/user/:id/custom-name/:name', tdto: null }),
      void 0,
      true,
    );
    updateApi.$updateBaseUrl('https://api.example.com/api');
    expect(updateApi.$$).toBeUndefined();
    expect(updateApi.$$).not.toBe(updateApi.$$r);
    expect(updateApi.$$r.baseUrl).toBe('https://api.example.com/api');
    expect(await updateApi(null, { params: { id: '1', name: 'test' } })).toEqual({ id: '1', name: 'test', age: 18 });

    const updateApiMapNotDefault = createApiWithMap(mockApi.user.$);
    updateApiMapNotDefault.$updateBaseUrl('https://api.example.com/api');
    expect(updateApiMapNotDefault.$$).toBeUndefined();
    expect(updateApiMapNotDefault.$$).not.toBe(updateApiMapNotDefault.$$r);
    expect(updateApiMapNotDefault.$$r.baseUrl).toBe('https://api.example.com/api');
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
        baseUrl: 'https://api.example.com',
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
      { baseUrl: 'https://api.example.com', method: 'POST', requestMode: 'mock' },
    )({ id: '1' });
    expect(resTdto).toEqual({ id: 1 });

    await expect(
      // @ts-expect-error
      mockApi.user.getInfoCustom(() => void 0, { method: 'POST', onRequest: null, onResponse: null, tvo: null }),
    ).rejects.toThrowError();
    // ^ node 环境中无法获取到 location 所以这个请求会失败

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
      { baseUrl: 'https://api.example.com', requestMode: 'mock', tvo: () => 1, parser: 'stream' },
    )();
    expect(emptyUrlRes).toBe(1);

    await expect(
      createApi({ url: '' }, { requestMode: 'mock', tvo: () => 1, parser: 'stream' })(),
    ).rejects.toThrowError();

    await expect(
      createApi(
        { url: '' },
        { baseUrl: 'https://api.example.com', requestMode: 'mock', tvo: () => 1, parser: 'ccc' },
      )(),
    ).rejects.toThrowError();
  });

  test('param url', async () => {
    // 输出 warn
    expect(() => createApi({ url: '/user/:id' })).toThrowError(TypeError);
    const paramApi = createApi(defineApi({ url: 'https://api.example.com/user/:id' }), {}, true);

    // @ts-expect-error
    expect(() => paramApi(null)).toThrowError(TypeError);

    expect(await paramApi(null, { params: { id: '1' } })).toEqual({ id: '1', name: 'John Doe' });

    const paramsApi = createApi(defineApi({ url: 'https://api.example.com/api/user/:id/custom-name/:name' }), {}, true);

    // @ts-expect-error
    expect(() => paramsApi(null, { params: { id: '1' } })).toThrowError(TypeError);
    expect(await paramsApi(null, { params: { id: '1', name: 'test' } })).toEqual({ id: '1', name: 'test' });

    const paramApiMap = createApiWithMap(
      defineApiMap({
        user: { getInfo: { url: '/user/:id' } },
        getCustomNameUser: { url: '/api/user/:id/custom-name/:name' },
      }),
      { baseUrl: 'https://api.example.com' },
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
    const paramApi = createApi(defineApi({ url: 'https://api.example.com/user/:id' }), {}, true);

    // 数字 0 应该被接受为有效参数
    const result = await paramApi(null, { params: { id: 0 } });
    expect(result).toEqual({ id: '0', name: 'John Doe' });
  });

  test('获取非实例属性', () => {
    const api = createApi(defineApi({ url: 'https://api.example.com/user/:id' }), {}, true);
    // @ts-expect-error
    expect(api.url).toBeUndefined();
  });

  test('完整 URL 支持', async () => {
    // 测试完整的绝对 URL 不需要 baseUrl
    // 验证 targetUrlParser 中的完整 URL 检测逻辑
    const fullUrlApi = createApi(
      defineApi({
        url: 'https://api.example.com/full-path/user',
      }),
      {},
      true,
    );

    // 验证可以正常创建 API，即使没有 baseUrl
    expect(fullUrlApi).toBeInstanceOf(Function);
  });

  test('路径拼接优化', async () => {
    // 测试 baseUrl 以 / 结尾的情况，验证路径拼接不会产生重复斜杠
    const api1 = createApi(
      defineApi({
        url: '/user',
      }),
      { baseUrl: 'https://api.example.com/api/' },
      true,
    );

    expect(api1).toBeInstanceOf(Function);

    // 测试 baseUrl 不以 / 结尾的情况
    const api2 = createApi(
      defineApi({
        url: '/user',
      }),
      { baseUrl: 'https://api.example.com/api' },
      true,
    );

    expect(api2).toBeInstanceOf(Function);

    // 测试相对路径
    const api3 = createApi(
      defineApi({
        url: 'user',
      }),
      { baseUrl: 'https://api.example.com/api' },
      true,
    );

    expect(api3).toBeInstanceOf(Function);
  });
  test('URL 参数编码', async () => {
    // 添加一个处理特殊字符的 mock handler
    server.use(
      http.get('https://api.example.com/user/:id', (req) => {
        const { id } = req.params;
        return HttpResponse.json({ id, name: 'John Doe' });
      }),
    );

    const paramApi = createApi(
      defineApi({
        url: 'https://api.example.com/user/:id',
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
    server.use(
      http.get('https://api.example.com/user/:id', (req) => {
        const { id } = req.params;
        return HttpResponse.json({ id, name: 'John Doe' });
      }),
    );

    const paramApi = createApi(
      defineApi({
        url: 'https://api.example.com/user/:id',
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
});
