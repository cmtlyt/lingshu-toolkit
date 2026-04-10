import { useMemo } from 'react';
import { useToggle } from '@/react/use-toggle';

function useBoolean(defaultValue = false) {
  const [state, { toggle, set }] = useToggle(Boolean(defaultValue));

  // biome-ignore lint/correctness/useExhaustiveDependencies: toggle action is pure
  const actions = useMemo(() => {
    return {
      toggle,
      setTrue: () => set(true),
      setFalse: () => set(false),
      // biome-ignore lint/nursery/noUselessTypeConversion: 用户输入可能为非布尔类型
      set: (value: boolean) => set(Boolean(value)),
    };
  }, []);

  return [state, actions] as const;
}

export { useBoolean };
