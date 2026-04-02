import type { AnyFunc } from '@/shared/types/base';

export interface AllxOptions {
  allSettled?: boolean;
}

export type AllxTaskValue<T> = T extends AnyFunc ? Awaited<ReturnType<T>> : Awaited<T>;

export interface AllxContext<M extends Record<PropertyKey, AnyFunc>> {
  $: { [P in keyof M]: Promise<AllxTaskValue<M[P]>> };
}

export type AllxResult<M extends Record<PropertyKey, AnyFunc>, O extends AllxOptions = AllxOptions> = {
  [P in keyof M]: O['allSettled'] extends true ? PromiseSettledResult<Awaited<ReturnType<M[P]>>> : AllxTaskValue<M[P]>;
};
