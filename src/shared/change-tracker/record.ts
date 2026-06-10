import { throwError } from '@/shared/throw-error';
import { deepClone } from './helpers';
import { createDeepProxy } from './proxy-engine';
import type { Patch, PatchEmitter, RecorderInstance, TrackerOptions } from './types';

export function recordTransaction<T extends object>(
  baseObject: T,
  changeFn: (draft: T) => void,
  options?: TrackerOptions,
): Patch[] {
  const draft = deepClone(baseObject);
  const patches: Patch[] = [];
  const emit: PatchEmitter = (patch) => patches.push(patch);
  const proxy = createDeepProxy(draft, [], emit, options?.types);

  changeFn(proxy);

  return patches;
}

export function createRecorder<T extends object>(baseObject: T, options?: TrackerOptions): RecorderInstance<T> {
  let disposed = false;
  let patches: Patch[] = [];

  const emit: PatchEmitter = (patch) => patches.push(patch);
  const proxy = createDeepProxy(baseObject, [], emit, options?.types);

  const guardedProxy = new Proxy(proxy, {
    get(target, prop, receiver) {
      if (disposed && prop !== 'toString' && prop !== 'valueOf' && prop !== Symbol.toPrimitive) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot access proxy after dispose().');
      }
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (disposed) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot modify proxy after dispose().');
      }
      return Reflect.set(target, prop, value);
    },
    deleteProperty(target, prop) {
      if (disposed) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot modify proxy after dispose().');
      }
      return Reflect.deleteProperty(target, prop);
    },
  });

  return {
    proxy: guardedProxy,
    flush(): Patch[] {
      if (disposed) {
        throwError('createRecorder', 'Recorder has been disposed. Cannot flush after dispose().');
      }
      const flushed = patches;
      patches = [];
      return flushed;
    },
    dispose(): void {
      disposed = true;
      patches = [];
    },
  };
}
