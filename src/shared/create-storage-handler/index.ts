import { $dt, $t, dataHandler } from '@/shared/data-handler';
import { logger } from '@/shared/logger';

export interface CreateStorageOptions {
  storageType: 'local' | 'session' | 'memory';
  autoSaveInterval: number;
}

export interface StorageHandler<T extends Record<string, any>> {
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
  getItem(key: string) {
    return this.data[key];
  },
  setItem(key: string, value: any) {
    this.data[key] = value;
  },
  removeItem(key: string) {
    delete this.data[key];
  },
};

function getStorage(storageType: CreateStorageOptions['storageType']) {
  try {
    if (storageType === 'memory') {
      return memoryStorage;
    }
    return storageType === 'local' ? localStorage : sessionStorage;
  } catch {
    logger.warn('createStorage', 'Failed to access localStorage or sessionStorage, using memoryStorage instead.');
    return memoryStorage;
  }
}

export function createStorageHandler<T extends Record<string, any>>(
  storageKey: string,
  initialData?: T,
  options: Partial<CreateStorageOptions> = {},
) {
  const {
    storageKey: validStorageKey,
    storageType,
    autoSaveInterval,
  } = dataHandler({ storageKey, ...options }, validInfo, { unwrap: true });
  const storage = getStorage(storageType);
  const storageData = storage.getItem(validStorageKey);
  const context = {
    data: storageData ? JSON.parse(storageData) : initialData || {},
  };

  return {
    get(key?) {
      if (key == null) {
        return context.data;
      }
      return context.data[key];
    },
    set(value, key?) {
      if (key == null) {
        context.data = value;
      } else {
        context.data[key] = value;
      }
      if (autoSaveInterval > 0) {
        setTimeout(() => {
          storage.setItem(validStorageKey, JSON.stringify(context.data));
        }, autoSaveInterval);
      } else {
        storage.setItem(validStorageKey, JSON.stringify(context.data));
      }
    },
    clear() {
      context.data = null;
      storage.removeItem(validStorageKey);
    },
  } as StorageHandler<T>;
}
