import type { WasmWebClient as WebClient } from "@miden-sdk/miden-sdk";
import { useMidenStore } from "./MidenStore";

/** Taken when a client read starts: true while the store still holds that client and cache generation. */
export function captureClientReadGuard(client: WebClient): () => boolean {
  const { cacheGeneration } = useMidenStore.getState();
  return () => {
    const store = useMidenStore.getState();
    return store.client === client && store.cacheGeneration === cacheGeneration;
  };
}
