export type PatchOp = 'set' | 'delete' | 'splice';

export interface Patch {
  path: (string | number)[];
  op: PatchOp;
  value?: unknown;
  index?: number;
  deleteCount?: number;
  items?: unknown[];
  type?: string;
  timestamp: number;
}

export interface CustomTypeConfig<T = unknown> {
  type: string;
  is: (value: unknown) => value is T;
  serialize: (value: T) => unknown;
  deserialize: (raw: unknown) => T;
}

export interface TrackerOptions {
  types?: CustomTypeConfig<any>[];
}

export interface ReplayOptions extends TrackerOptions {
  mutate?: boolean;
}

export interface RecorderInstance<T extends object> {
  proxy: T;
  flush: () => Patch[];
  dispose: () => void;
}

export type PatchEmitter = (patch: Patch) => void;
