interface Resolver<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

function withResolvers<T>(): Resolver<T> {
  return typeof Promise.withResolvers === 'function'
    ? Promise.withResolvers<T>()
    : (() => {
        const resolver = { promise: null, resolve: null, reject: null } as unknown as Resolver<any>;
        resolver.promise = new Promise((resolve, reject) => {
          resolver.resolve = resolve;
          resolver.reject = reject;
        });
        return resolver;
      })();
}

export type { Resolver };
export { withResolvers };
