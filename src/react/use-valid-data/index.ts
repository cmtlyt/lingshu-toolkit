import { useMemo, useRef } from 'react';
import { dataHandler } from '@/shared/data-handler';
import type { DataHandlerOptions, Handler } from '@/shared/data-handler/types';

export * from '@/shared/data-handler/tools';

export function useValidData<T extends Record<PropertyKey, any>>(
  data: T,
  verifyInfo: Handler<T>,
  options?: DataHandlerOptions<T>,
) {
  const verifyInfoRef = useRef(verifyInfo);
  const optionsRef = useRef(options);

  return useMemo(() => dataHandler(data, verifyInfoRef.current, optionsRef.current), [data]);
}
