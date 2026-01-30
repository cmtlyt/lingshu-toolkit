import { useEffect } from 'react';
import { $dt, $t, useValidData } from '../use-valid-data';

interface UseTitleOptions {
  restoreOnUnmount: boolean;
}

function setTitle(title?: string) {
  if (!title) {
    return;
  }
  document.title = title;
}

const validInfo = $dt({
  restoreOnUnmount: $t.boolean(true),
});

export function useTitle(title?: string, options: Partial<UseTitleOptions> = {}) {
  const { restoreOnUnmount } = useValidData(options as UseTitleOptions, validInfo);

  useEffect(() => {
    const originalTitle = document.title;
    setTitle(title);

    return () => {
      if (restoreOnUnmount) {
        setTitle(originalTitle);
      }
    };
  }, [title, restoreOnUnmount]);

  return setTitle;
}
