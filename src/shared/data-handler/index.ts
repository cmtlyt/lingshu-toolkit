import { throwType } from '@/shared/throw-error';
import type { Equal, Printify } from '@/shared/types';
import type { Transform2Type } from './tools';
import type { ActionContext, ActionHandlers, Actions, DataHandlerOptions, Handler } from './types';

function createActions() {
  const ctx: ActionContext = {
    errors: [],
    transforms: [],
    handledErrorKeys: new Set(),
  };

  const handler: ActionHandlers = {
    addError(key, msg = `${String(key)} is not valid`) {
      if (ctx.handledErrorKeys.has(key)) {
        return;
      }
      ctx.handledErrorKeys.add(key);
      ctx.errors.push(msg);
    },
    addTransform(key, value) {
      ctx.transforms.push([key, value]);
    },
  };

  return [
    ctx,
    handler,
    (key: PropertyKey) =>
      ({
        assert: (flag, msg = `${String(key)} is not valid`) => {
          if (!flag) {
            handler.addError(key, msg);
          }
          return flag;
        },
        transform: (value) => {
          if (!ctx.handledErrorKeys.has(key)) {
            handler.addTransform(key, value);
          }
          return value;
        },
      }) satisfies Actions,
  ] as const;
}

function transformApply(data: Record<PropertyKey, any>, transforms: [PropertyKey, any][]) {
  if (!transforms.length) {
    return;
  }
  for (let i = 0, [key, value] = transforms[i]; i < transforms.length; [key, value] = transforms[++i] || []) {
    data[key] = value;
  }
}

function handleProcess(
  data: Record<PropertyKey, any>,
  keys: PropertyKey[],
  handleFn: Handler<any> & ((...args: any[]) => any),
  getActions: (key: PropertyKey) => Actions,
  actionHandlers: ActionHandlers,
) {
  for (let i = 0, key = keys[i]; i < keys.length; key = keys[++i]) {
    const flag = handleFn(data[key], key as PropertyKey, getActions(key), data);
    if (flag === false) {
      actionHandlers.addError(key);
    }
  }
}

function errorProcess(errors: string[], errorHandler?: (error: string[]) => void, strict?: boolean) {
  if (!errors.length) {
    return;
  }
  if (errorHandler) {
    errorHandler(errors);
  } else if (strict) {
    throwType('dataHandler', errors.join('\n'));
  }
}

function filterData(data: Record<PropertyKey, any>, ctx: ActionContext, defaultValue: Record<PropertyKey, any> = {}) {
  ctx.handledErrorKeys.forEach((key) => {
    data[key] = defaultValue[key];
  });
}

type MergeResult<BaseResult extends Record<PropertyKey, any>, HandlerResult extends Handler<any>> = Printify<
  HandlerResult extends (...args: any[]) => any
    ? BaseResult
    : BaseResult & {
        [K in keyof HandlerResult]: Equal<HandlerResult[K], any> extends true
          ? Required<BaseResult>[K]
          : HandlerResult[K];
      }
>;

export function dataHandler<
  M extends Record<PropertyKey, any>,
  H extends Handler<M> = Handler<M>,
  O extends DataHandlerOptions<M> = DataHandlerOptions<M>,
>(
  data: M & Partial<O['defaultValue']>,
  handler: H,
  options?: O,
): O['unwrap'] extends true
  ? MergeResult<M & O['defaultValue'], Transform2Type<H>>
  : { result: MergeResult<M & O['defaultValue'], Transform2Type<H>>; errors: string[] } {
  if (!handler) {
    throwType('dataHandler', 'handler is required');
  }
  const { strict = false, errorHandler, defaultValue, unwrap = false } = options || {};
  const handlerIsFunction = typeof handler === 'function';
  const handleFn = handlerIsFunction
    ? handler
    : (value: any, key: PropertyKey, ...args: [Actions, M]) => handler[key]!(value, ...args);

  const tempData: Record<PropertyKey, any> = { ...defaultValue, ...data };

  const keys = handlerIsFunction ? Reflect.ownKeys(data) : Reflect.ownKeys(handler);
  const [ctx, actionHandler, getActions] = createActions();

  handleProcess(tempData, keys, handleFn as any, getActions, actionHandler);

  errorProcess(ctx.errors, errorHandler, strict);

  transformApply(tempData, ctx.transforms);

  filterData(tempData, ctx, defaultValue);

  return (unwrap ? tempData : { result: tempData, errors: ctx.errors }) as any;
}

export * from './tools';
