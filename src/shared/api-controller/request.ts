import { throwType } from '@/shared/throw-error';
import { tryCall } from '@/shared/try-call';
import { isFunction, isNullOrUndef } from '@/shared/utils/verify';
import type { RequestAPIConfig } from './types';
import { getBody, targetUrlParser, urlParamsParser } from './utils';

async function baseRequest<R, C extends RequestAPIConfig<any, R> = RequestAPIConfig<any, R>>(
  config: C,
  getResponse: (requestInfo: Request) => Promise<Response>,
): Promise<R> {
  const { baseUrl, url, method: _method, parser, data, tdto, tvo, onResponse, ...rest } = config;

  const targetUrl = targetUrlParser(url, baseUrl!);
  const method = _method?.toUpperCase() as RequestInit['method'];

  const requestInfo = tryCall(() => {
    if (isNullOrUndef(method) || method === 'GET' || method === 'HEAD') {
      const queryKeys = Object.keys(data || {});
      for (let i = 0; i < queryKeys.length; ++i) {
        targetUrl.searchParams.append(queryKeys[i], (data as any)[queryKeys[i]]);
      }
      return new Request(targetUrl, { ...rest, method });
    }
    const body = getBody(data, tdto);
    return new Request(targetUrl, { ...rest, method, body });
  });

  const responseInfo = await getResponse(requestInfo);

  const resResult = await tryCall(() => {
    if (onResponse) {
      return onResponse(responseInfo, config);
    }
    if (!parser) {
      return responseInfo.json();
    }
    if (parser === 'stream') {
      return responseInfo.body;
    }
    const responseHandler = (responseInfo as unknown as Record<string, () => Promise<any>>)[parser];
    if (isFunction(responseHandler)) {
      return Reflect.apply(responseHandler, responseInfo, []);
    }
    throwType('apiController.responseParser', 'Invalid parser');
  });

  return tvo ? tvo(resResult) : (resResult as R);
}

async function mockRequest<R, C extends RequestAPIConfig<any, R> = RequestAPIConfig<any, R>>(config: C): Promise<R> {
  const { onRequest, ...rest } = config;

  return baseRequest<R>(config, async (requestInfo) => {
    const reqResult = await (onRequest && onRequest(requestInfo, config));

    const responseBody = getBody(reqResult);
    return new Response(responseBody, { ...rest });
  });
}

async function networkRequest<R, C extends RequestAPIConfig<any, R> = RequestAPIConfig<any, R>>(config: C): Promise<R> {
  return baseRequest<R>(config, fetch);
}

/**
 * 请求方法
 *
 * @param config 请求配置
 */
export function request<R, C extends RequestAPIConfig<any, R> = RequestAPIConfig<any, R>>(config: C): Promise<R> {
  const url = urlParamsParser(config.url, config.params);

  const { requestMode, requestModeMap } = config;
  const customRequest = (requestModeMap || {})[requestMode || ''];
  if (customRequest) {
    return customRequest({ ...config, url });
  }

  if (requestMode === 'mock') {
    return mockRequest({ ...config, url });
  }
  return networkRequest({ ...config, url });
}
