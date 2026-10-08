import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountId, type PswapLineageRecord } from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import { useSyncStateStore } from "../store/MidenStore";
import type { AccountRef, PswapLineagesResult } from "../types";
import { parseAccountId } from "../utils/accountParsing";

/**
 * Hook to list the partial-swap (PSWAP) lineages created by a specific local
 * account. Refreshes after each successful sync.
 *
 * @param account - Creator account (hex, bech32, `Account`, or `AccountId`).
 *
 * @example
 * ```tsx
 * function MyLineages({ accountId }: { accountId: string }) {
 *   const { lineages, isLoading } = usePswapLineagesFor(accountId);
 *   if (isLoading) return <div>Loading...</div>;
 *   return <div>{lineages.length} open orders</div>;
 * }
 * ```
 */
export function usePswapLineagesFor(
  account: AccountRef | null | undefined
): PswapLineagesResult {
  const { client, isReady } = useMiden();
  const { lastSyncTime } = useSyncStateStore();

  const [lineages, setLineages] = useState<PswapLineageRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Generation counter: an in-flight fetch skips setState once a newer fetch
  // or unmount bumps it — stops stale results from overwriting fresh data.
  const fetchGenRef = useRef(0);

  // Normalize to a stable hex key so re-created Account/AccountId instances
  // don't churn `account` identity and refetch every parent render.
  const accountKey = useMemo<string | null>(() => {
    if (account == null) return null;
    try {
      return parseAccountId(account).toString();
    } catch {
      return null;
    }
  }, [account]);

  const refetch = useCallback(async () => {
    if (!client || !isReady || accountKey == null) return;

    const gen = ++fetchGenRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const accountIdObj = AccountId.fromHex(accountKey);
      const fetched = await client.getPswapLineagesFor(accountIdObj);
      if (gen === fetchGenRef.current) setLineages(fetched);
    } catch (err) {
      if (gen === fetchGenRef.current)
        setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (gen === fetchGenRef.current) setIsLoading(false);
    }
  }, [client, isReady, accountKey]);

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

export type UsePswapLineagesForResult = PswapLineagesResult;
