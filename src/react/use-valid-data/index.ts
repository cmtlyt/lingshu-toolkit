import { useMemo, useRef } from 'react';
import { dataHandler } from '@/shared/data-handler';
import type { DataHandlerOptions, Handler } from '@/shared/data-handler/types';

export * from '@/shared/data-handler/tools';

export function useValidData<
  T extends Record<PropertyKey, any>,
  O extends DataHandlerOptions<T> = DataHandlerOptions<T> & { unwrap: true },
>(data: T, verifyInfo: Handler<T>, options?: O) {
  const verifyInfoRef = useRef(verifyInfo);
  const optionsRef = useRef(options);

  return useMemo(
    () => dataHandler<T, O>(data, verifyInfoRef.current, { unwrap: true, ...optionsRef.current } as O),
    [data],
  );
}
