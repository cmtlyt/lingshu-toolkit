import { logger } from '@/shared/logger';
import { throwError, throwType } from '@/shared/throw-error';
import { getType, isPlainNumber, isString } from '@/shared/utils';
import type { APIConfig, APIInstance, APIMap, DefaultAPIConfig } from './types';

/// request utils start

const ABSOLUTE_URL_REG = /^[a-z][a-z\d+\-.]*:/im;

export function isAbsUrl(url?: string) {
  if (!url) {
    return false;
  }
  return ABSOLUTE_URL_REG.test(url);
}

export function targetUrlParser(_url: string, _baseUrl: string | undefined) {
  if (isAbsUrl(_url)) {
    return new URL(_url);
  }
  const locationOrigin = (globalThis.location || {}).origin;
  const tempBaseUrl = _baseUrl || locationOrigin;
  let url = _url;
  let baseUrl: string | URL | undefined = tempBaseUrl;
  if (tempBaseUrl) {
    baseUrl = new URL(tempBaseUrl);
    const basePath = baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/$/, '');
    const relativePath = _url.startsWith('/') ? _url : `/${_url}`;
    url = `${basePath}${relativePath}`;
  }
  return new URL(url || '/', baseUrl);
}

export function urlParamsParser(url: string, params: Record<string, string> | undefined) {
  if (!url.includes('/:')) {
    return url;
  }
  if (!params) {
    throwType(
      'apiController.parseParams',
      'url 中存在 params 参数, params 配置不能为空, 请使用 custom 方法调用并传递 params 配置',
    );
  }
  const urlSplit = url.split('/');
  const emptyKeys: string[] = [];
  for (let i = 1; i < urlSplit.length; ++i) {
    if (urlSplit[i][0] !== ':') {
      continue;
    }
    const param = urlSplit[i].slice(1);
    const originValue = params[param];
    if (!(isPlainNumber(originValue) || originValue)) {
      emptyKeys.push(param);
      continue;
    }
    const paramValue = encodeURIComponent(String(originValue));
    urlSplit[i] = paramValue;
  }
  if (emptyKeys.length) {
    throwType('apiController.parseParams', `params 配置中缺少 [${emptyKeys.join(', ')}] 参数`);
  }
  return urlSplit.join('/');
}

export function getBody(data: any, tdto?: APIConfig['tdto']) {
  const _body = tdto ? tdto(data) : data;
  const bodyType = getType(_body);
  switch (bodyType) {
    case 'object':
    case 'array':
    case 'number':
    case 'boolean':
    case 'function':
      return JSON.stringify(_body);
    default:
      return _body;
  }
}

/// request utils end

/// create-api utils start

export function instanceMemberGetter(prop: string, instanceObj: Record<string, any>) {
  return instanceObj[prop];
}

export function createInstance(
  apiMap: APIConfig | APIMap,
  realDefaultConfig: DefaultAPIConfig,
  defaultConfig?: DefaultAPIConfig,
) {
  return {
    $: apiMap,
    $$: defaultConfig as any,
    $$r: realDefaultConfig,
    $updateBaseUrl(baseUrl) {
      if (isAbsUrl(baseUrl)) {
        realDefaultConfig.baseUrl = baseUrl;
      } else {
        const { origin } = globalThis.location || {};
        if (!origin) {
          throwError('apiController.$updateBaseUrl', 'location.origin is undefined');
        }
        const normalizedPath = (baseUrl || '/').startsWith('/') ? baseUrl || '' : `/${baseUrl}`;
        realDefaultConfig.baseUrl = `${origin}${normalizedPath}`;
      }
    },
  } satisfies APIInstance<any, any>;
}

export function getInstanceMemberOrApi(
  target: APIMap,
  prop: string,
  receiver: any,
  instanceObj: APIInstance<any, any>,
) {
  if (Reflect.getOwnPropertyDescriptor(instanceObj, prop)) {
    return { instanceMember: instanceMemberGetter(prop, instanceObj) };
  }
  const hasExactProp = isString(prop) && Reflect.has(target, prop);
  const isCustom = isString(prop) && prop.endsWith('Custom') && !hasExactProp;
  const name = isCustom ? prop.slice(0, -'Custom'.length) : prop;
  if (!Reflect.getOwnPropertyDescriptor(target, name)) {
    return void 0;
  }
  const api = Reflect.get(target, name, receiver);
  // 如果是自定义模式就必须是叶子节点
  if (isCustom && !isString((api as APIConfig).url)) {
    return void 0;
  }
  return { api, isCustom };
}

export function apiNamesCheck(_apiMap: APIMap, isDeep = false) {
  const apiNames = Reflect.ownKeys(_apiMap) as string[];
  const warnNames: string[] = [];
  for (let i = 0; i < apiNames.length; i++) {
    const name = apiNames[i];
    if (name.endsWith('Custom')) {
      warnNames.push(name);
    }
    if (!isString(_apiMap[name].url)) {
      warnNames.push(...apiNamesCheck(_apiMap[name] as APIMap, true));
    }
  }
  if (!isDeep && warnNames.length > 0) {
    logger.warn(
      'apiController.createApiWithMap',
      'api 命名不应该使用 Custom 结尾, 因为这是一个内部实现的方法',
      warnNames,
    );
  }
  return warnNames;
}

/// create-api utils end
