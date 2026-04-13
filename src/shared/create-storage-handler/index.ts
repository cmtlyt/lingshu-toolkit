import { $dt, $t, dataHandler } from '@/shared/data-handler';
import { logger } from '@/shared/logger';
import { throwError } from '@/shared/throw-error';
import { isNullOrUndef } from '@/shared/utils/verify';

interface CreateStorageOptions {
  storageType: 'local' | 'session' | 'memory';
  autoSaveInterval: number;
}

interface StorageHandler<T extends Record<string, any>> {
  get: <K extends keyof T | (string & {})>(key?: K) => string extends K ? T : T[K & keyof T];
  set: <K extends keyof T | (string & {})>(value: string extends K ? T : T[K & keyof T], key?: K) => void;
  clear: () => void;
}

const validInfo = $dt({
  storageKey: 'validString',
  storageType: $t.enum<CreateStorageOptions['storageType']>(['local', 'session', 'memory'], 'local'),
  autoSaveInterval: $t.number(0),
});

const memoryStorage = {
  data: {} as Record<string, any>,
  getItem(key: string): any {
    return this.data[key];
  },
  setItem(key: string, value: any): void {
    this.data[key] = value;
  },
  removeItem(key: string): void {
    delete this.data[key];
  },
};

function getStorage(storageType: CreateStorageOptions['storageType']): Storage {
  try {
    if (storageType === 'memory') {
      return memoryStorage as unknown as Storage;
    }
    return storageType === 'local' ? localStorage : sessionStorage;
  } catch {
    logger.warn('createStorage', 'Failed to access localStorage or sessionStorage, using memoryStorage instead.');
    return memoryStorage as unknown as Storage;
  }
}

const CLEAR_FLAG = Symbol('cleared');

function createStorageHandler<T extends Record<string, any>>(
  storageKey: string,
  initialData?: T,
  options: Partial<CreateStorageOptions> = {},
): StorageHandler<T> {
  const {
    storageKey: validStorageKey,
    storageType,
    autoSaveInterval,
  } = dataHandler({ storageKey, ...options }, validInfo, { unwrap: true });
  const storage = getStorage(storageType);
  const storageData = storage.getItem(validStorageKey);
  const context = {
    data: storageData ? JSON.parse(storageData) : initialData || {},
    timer: null as number | null,
  };
  const clearTimer = () => {
    if (context.timer !== null) {
      clearTimeout(context.timer);
      context.timer = null;
    }
  };

  return {
    get(key?): any {
      if (context.data === CLEAR_FLAG) {
        throwError('createStorageHandler', 'Storage has been cleared.');
      }
      if (isNullOrUndef(key)) {
        return context.data;
      }
      return context.data[key];
    },
    set(value, key?): void {
      if (context.data === CLEAR_FLAG) {
        throwError('createStorageHandler', 'Storage has been cleared.');
      }
      if (isNullOrUndef(key)) {
        context.data = value;
      } else {
        context.data[key] = value;
      }
      if (autoSaveInterval > 0) {
        clearTimer();
        context.timer = setTimeout(() => {
          storage.setItem(validStorageKey, JSON.stringify(context.data));
        }, autoSaveInterval);
      } else {
        storage.setItem(validStorageKey, JSON.stringify(context.data));
      }
    },
    clear(): void {
      clearTimer();
      context.data = CLEAR_FLAG;
      storage.removeItem(validStorageKey);
    },
  } as StorageHandler<T>;
}

export { type CreateStorageOptions, createStorageHandler, type StorageHandler };
