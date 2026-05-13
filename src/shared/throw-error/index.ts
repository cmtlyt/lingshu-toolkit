interface ErrorOptions {
  /** 原始错误（ES2022 Error.cause），便于错误链追踪 */
  cause?: unknown;
}

function createError(fnName: string, message: string, ErrorClass?: ErrorConstructor, options?: ErrorOptions): Error;
function createError(fnName: string, message: string, options?: ErrorOptions): Error;
function createError(
  fnName: string,
  message: string,
  ErrorClassOrOptions: ErrorConstructor | ErrorOptions = Error,
  options?: ErrorOptions,
): Error {
  const isErrorClass = typeof ErrorClassOrOptions === 'function';
  const ErrorClass = isErrorClass ? ErrorClassOrOptions : Error;
  const resolvedOptions = isErrorClass ? options : ErrorClassOrOptions;
  const finalMessage = `[@cmtlyt/lingshu-toolkit#${fnName}]: ${message}`;
  return resolvedOptions && 'cause' in resolvedOptions
    ? new ErrorClass(finalMessage, { cause: resolvedOptions.cause })
    : new ErrorClass(finalMessage);
}

function throwError(fnName: string, message: string, ErrorClass?: ErrorConstructor, options?: ErrorOptions): never;
function throwError(fnName: string, message: string, options?: ErrorOptions): never;
function throwError(
  fnName: string,
  message: string,
  ErrorClassOrOptions: ErrorConstructor | ErrorOptions = Error,
  options?: ErrorOptions,
): never {
  throw createError(fnName, message, ErrorClassOrOptions as ErrorConstructor, options);
}

function throwType(fnName: string, message: string, options?: ErrorOptions): never {
  throwError(fnName, message, TypeError, options);
}

export type { ErrorOptions };
export { createError, throwError, throwType };
