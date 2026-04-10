import { type MaybeRefOrGetter, onScopeDispose, ref, toValue, watch } from 'vue';
import { $dt, $t, dataHandler } from '@/shared/data-handler';

interface UseTitleOptions {
  restoreOnUnmount: boolean;
}

function setTitle(title?: string) {
  if (!title || typeof document === 'undefined') {
    return;
  }
  const oldTitle = document.title;
  document.title = title;
  return oldTitle;
}

const validInfo = $dt({ restoreOnUnmount: $t.boolean(true) });

function useTitle(newTitle: MaybeRefOrGetter<string> = '', options: Partial<UseTitleOptions> = {}) {
  const { restoreOnUnmount } = dataHandler(options as UseTitleOptions, validInfo, { unwrap: true });
  const title = ref(toValue(newTitle));

  const originalTitle = setTitle(title.value);

  watch(title, setTitle, { flush: 'sync' });

  watch(
    () => toValue(newTitle),
    (value) => {
      title.value = value;
    },
  );

  if (restoreOnUnmount) {
    onScopeDispose(() => {
      setTitle(originalTitle);
    });
  }

  return title;
}

export { useTitle };
