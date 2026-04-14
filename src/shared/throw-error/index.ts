function createError(fnName: string, message: string, ErrorClass = Error): Error {
  return new ErrorClass(`[@cmtlyt/lingshu-toolkit#${fnName}]: ${message}`);
}

function throwError(fnName: string, message: string, ErrorClass = Error): never {
  throw createError(fnName, message, ErrorClass);
}

function throwType(fnName: string, message: string): never {
  throwError(fnName, message, TypeError);
}

export { createError, throwError, throwType };
