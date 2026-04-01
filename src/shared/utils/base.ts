export const noop = () => void 0;

export const identity = <T>(_v: T) => _v;

export function getType(_v: any): string {
  return Object.prototype.toString.call(_v).slice(8, -1).toLowerCase();
}
