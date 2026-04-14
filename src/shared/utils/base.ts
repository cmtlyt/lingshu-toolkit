export const noop = (): void => void 0;

export const identity = <T>(_v: T): T => _v;

export function getType(_v: any): string {
  return Object.prototype.toString.call(_v).slice(8, -1).toLowerCase();
}
