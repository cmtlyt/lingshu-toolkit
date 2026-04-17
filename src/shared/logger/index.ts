type Logger = {
  [K in keyof Omit<Console, 'table'> as Console[K] extends (...args: any[]) => any ? K : never]: Console[K] extends (
    ...args: [any, ...infer AS]
  ) => infer R
    ? (fnName: string, ...args: AS) => R
    : never;
};

declare global {
  var $$lingshu$$: Partial<{
    disableLogger: boolean;
  }>;
}

export const logger = new Proxy(console, {
  get(target, prop, receiver) {
    if ((globalThis.$$lingshu$$ || {}).disableLogger) {
      return () => void 0;
    }
    const oldLog = Reflect.get(target, prop, receiver).bind(console);
    return (fnName: string, ...args: any) => {
      oldLog(`[@cmtlyt/lingshu-toolkit#${fnName}]:`, ...args);
    };
  },
}) as unknown as Logger;
