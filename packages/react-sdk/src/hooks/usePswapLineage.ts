import { useCallback, useEffect, useRef, useState } from "react";
import type { PswapLineageRecord } from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import { useSyncStateStore } from "../store/MidenStore";
import type { PswapLineageResult } from "../types";

/**
 * Hook to fetch a single partial-swap (PSWAP) lineage by its stable order id.
 * Returns `null` if this client is not tracking the order. Refreshes after each
 * successful sync.
 *
 * @param orderId - Stable order id (decimal string or bigint). `number` is
 *   not accepted: a PSWAP order id is `u64`-shaped and routinely exceeds
 *   `Number.MAX_SAFE_INTEGER`, which a JS `number` cannot represent without
 *   silent precision loss.
 *
 * @example
 * ```tsx
 * function OrderStatus({ orderId }: { orderId: string }) {
 *   const { lineage, isLoading } = usePswapLineage(orderId);
 *   if (isLoading) return <div>Loading...</div>;
 *   if (!lineage) return <div>Not tracked</div>;
 *   return <div>State: {lineage.state()}</div>;
 * }
 * ```
 */
export function usePswapLineage(
  orderId: string | bigint | null | undefined
): PswapLineageResult {
  const { client, isReady } = useMiden();
  const { lastSyncTime } = useSyncStateStore();

  const [lineage, setLineage] = useState<PswapLineageRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const orderIdStr = orderId == null ? null : String(orderId);

  // Generation counter: an in-flight fetch skips setState once a newer fetch
  // or unmount bumps it — stops stale results from overwriting fresh data.
  const fetchGenRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!client || !isReady || orderIdStr == null) return;

    const gen = ++fetchGenRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const fetched = await client.getPswapLineage(orderIdStr);
      if (gen === fetchGenRef.current) setLineage(fetched ?? null);
    } catch (err) {
      if (gen === fetchGenRef.current)
        setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (gen === fetchGenRef.current) setIsLoading(false);
    }
  }, [client, isReady, orderIdStr]);

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

  return { lineage, isLoading, error, refetch };
}

export type UsePswapLineageResult = PswapLineageResult;
