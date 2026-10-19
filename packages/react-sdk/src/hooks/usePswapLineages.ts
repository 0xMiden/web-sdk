import { useCallback, useEffect, useRef, useState } from "react";
import type { PswapLineageRecord } from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import { useMidenStore, useSyncStateStore } from "../store/MidenStore";
import { captureClientReadGuard } from "../store/clientReadGuard";
import { useCacheGenerationState } from "../store/useCacheGenerationState";
import type { PswapLineagesResult } from "../types";

/**
 * Hook to list every partial-swap (PSWAP) lineage tracked by this client.
 *
 * A lineage records how a PSWAP note has been filled round by round, from the
 * original note through each remainder to the current tip. The list refreshes
 * after each successful sync.
 *
 * @example
 * ```tsx
 * function LineageList() {
 *   const { lineages, isLoading } = usePswapLineages();
 *   if (isLoading) return <div>Loading...</div>;
 *   return (
 *     <ul>
 *       {lineages.map((l) => (
 *         <li key={l.orderId()}>
 *           {l.orderId()} — {l.remainingOffered().toString()} remaining
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function usePswapLineages(): PswapLineagesResult {
  const { client, isReady } = useMiden();
  const { lastSyncTime } = useSyncStateStore();

  const [lineages, setLineages] = useCacheGenerationState<PswapLineageRecord[]>(
    []
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useCacheGenerationState<Error | null>(null);

  // Generation counter: an in-flight fetch skips setState once a newer fetch
  // or unmount bumps it — stops stale results from overwriting fresh data.
  const fetchGenRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!client || !isReady) return;

    const isCurrent = captureClientReadGuard(client);
    if (!isCurrent()) return;

    const { cacheGeneration } = useMidenStore.getState();
    const gen = ++fetchGenRef.current;
    setIsLoading(true);
    setError(null, cacheGeneration);

    try {
      const fetched = await client.getPswapLineages();
      if (isCurrent() && gen === fetchGenRef.current)
        setLineages(fetched, cacheGeneration);
    } catch (err) {
      if (isCurrent() && gen === fetchGenRef.current)
        setError(
          err instanceof Error ? err : new Error(String(err)),
          cacheGeneration
        );
    } finally {
      if (gen === fetchGenRef.current) setIsLoading(false);
    }
  }, [client, isReady]);

  useEffect(() => {
    if (!isReady) return;
    refetch();
    return () => {
      fetchGenRef.current++;
    };
  }, [isReady, refetch]);

  useEffect(() => {
    if (!isReady || !lastSyncTime) return;
    refetch();
    return () => {
      fetchGenRef.current++;
    };
  }, [isReady, lastSyncTime, refetch]);

  return { lineages, isLoading, error, refetch };
}

export type UsePswapLineagesResult = PswapLineagesResult;
