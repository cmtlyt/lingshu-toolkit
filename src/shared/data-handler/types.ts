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
      [K in keyof M]: (value: M[K], action: Actions, option: M) => false | (any & {});
    }>
  | (<K extends keyof M>(value: M[K], key: K, action: Actions, option: M) => false | (any & {}));

export interface ActionContext {
  errors: string[];
  transforms: [PropertyKey, any][];
  handledErrorKeys: Set<PropertyKey>;
}

export interface ActionHandlers {
  addError(key: PropertyKey, msg?: string): void;
  addTransform(key: PropertyKey, value: any): void;
}

export interface DataHandlerOptions<M extends Record<PropertyKey, any>> {
  strict?: boolean;
  errorHandler?: (error: ActionContext['errors']) => void;
  defaultValue?: M;
  unwrap?: boolean;
}
