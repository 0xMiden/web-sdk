import { useCallback, useState } from "react";
import { useMidenStore } from "./MidenStore";

/** Hide hook-local client data and errors once their cache generation ends. */
export function useCacheGenerationState<T>(initialValue: T) {
  const cacheGeneration = useMidenStore((state) => state.cacheGeneration);
  const [initial] = useState(() => initialValue);
  const [state, setState] = useState(() => ({
    value: initial,
    cacheGeneration,
  }));
  const setValue = useCallback((value: T, cacheGeneration: number) => {
    setState((state) =>
      state.value === value && state.cacheGeneration === cacheGeneration
        ? state
        : { value, cacheGeneration }
    );
  }, []);

  return [
    state.cacheGeneration === cacheGeneration ? state.value : initial,
    setValue,
  ] as const;
}
