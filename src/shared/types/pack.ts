/* c8 ignore start */
const __PACK__ = Symbol('__PACK__');
/* c8 ignore stop */

export type Pack<T> = { [__PACK__]: T };

export type Unpack<T extends Pack<any>> = T extends Pack<infer U> ? U : never;

export type SafeUnpack<T extends Pack<any>> = T extends Pack<infer U> ? U : T;

export type IsPack<T> = Pack<any> extends T ? true : false;

export type HasPack<T> = (T extends any[] ? HasPack<T[number]> : IsPack<T>) extends false ? false : true;
