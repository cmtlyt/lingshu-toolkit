import { useMemo, useRef } from 'react';
import { type CreateStorageOptions, createStorageHandler } from '@/shared/create-storage-handler';

export function useStorage<T extends Record<string, any>>(
  storageKey: string,
  options?: Partial<CreateStorageOptions>,
  initialData?: T,
) {
  const optionsRef = useRef({ initialData, options });

  return useMemo(() => {
    const { initialData: _initialData, options: _options } = optionsRef.current;
    return createStorageHandler<T>(storageKey, _initialData || ({} as T), _options);
  }, [storageKey]);
}
