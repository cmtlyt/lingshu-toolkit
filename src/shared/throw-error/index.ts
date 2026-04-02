export function createError(fnName: string, message: string, ErrorClass = Error): Error {
  return new ErrorClass(`[@cmtlyt/lingshu-toolkit#${fnName}]: ${message}`);
}

export function throwError(fnName: string, message: string, ErrorClass = Error): never {
  throw createError(fnName, message, ErrorClass);
}

export function throwType(fnName: string, message: string): never {
  throwError(fnName, message, TypeError);
}
