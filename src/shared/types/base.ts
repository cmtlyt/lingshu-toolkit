export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export type NonUnion<T> = Equal<[T] extends [never] ? never : T[], T extends any ? T[] : never>;

export type UnionToIntersection<U> = [U] extends [never]
  ? never
  : (U extends any ? (_v: U) => void : never) extends (_v: infer I) => void
    ? I
    : never;

export type IsPrimitive<T> = T extends number | string | boolean | symbol | bigint | null | undefined ? true : false;

export type IsBasicType<T> = T extends number | string | boolean | symbol | bigint ? true : false;

export type Printify<T> = T extends any[] ? T : [T] extends [never] ? T : { [K in keyof T]: T[K] };
