export interface Actions {
  assert: <T extends boolean>(flag: T, msg?: string) => T;
  /**
   * 转换结果中的数值类型
   *
   * @warning 如果被 assert 处理为 false, 则不会应用转换
   */
  transform: <T>(value: T) => T;
}

export type Handler<M extends Record<PropertyKey, any>> =
  | Partial<{
      [K in keyof M]: (value: any, action: Actions, option: M) => false | (any & {});
    }>
  | (<K extends keyof M>(value: any, key: K, action: Actions, option: M) => false | (any & {}));

export interface ActionContext {
  errors: string[];
  transforms: [PropertyKey, any][];
  handledErrorKeys: Set<PropertyKey>;
}

export interface ActionHandlers {
  addError: (key: PropertyKey, msg?: string) => void;
  addTransform: (key: PropertyKey, value: any) => void;
}

export interface DataHandlerOptions<M extends Record<PropertyKey, any>> {
  strict?: boolean;
  errorHandler?: (error: ActionContext['errors']) => void;
  defaultValue?: M;
  unwrap?: boolean;
}

export interface TypeMap {
  notNullable: any & {};
  string: string;
  validString: string;
  number: number;
  validNumber: number;
  boolean: boolean;
  object: Record<PropertyKey, any>;
  array: any[];
  function: (...args: any[]) => any;
  symbol: symbol;
  enum: any & {};
}

export type TypeHandler = NonNullable<Exclude<Handler<any>, (...args: any[]) => any>[string]>;

export type TypeHandlerParams = Parameters<TypeHandler> extends [any, ...infer Rest] ? Rest : never;

export type ParseType<T extends string> = T extends keyof TypeMap ? TypeMap[T] : any;

export type TypeHandlerInfo<T extends string> = (
  value: ParseType<T>,
  ...args: TypeHandlerParams
) => ReturnType<TypeHandler>;

export type Fullback<T extends string> = T extends 'function'
  ? (_v: any) => ParseType<T>
  : ((_v: any) => ParseType<T>) | (ParseType<T> & {});
