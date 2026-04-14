import { useEffect, useRef } from 'react';
import { $t, dataHandler } from '@/shared/data-handler';

function useMount(callback: () => any) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    dataHandler({ fn: callbackRef.current }, { fn: $t.function() }, { strict: true });
    callbackRef.current();
  }, []);
}

export { useMount };
