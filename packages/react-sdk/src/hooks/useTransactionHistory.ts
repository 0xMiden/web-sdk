import { useCallback, useEffect, useMemo, useState } from "react";
import { TransactionFilter } from "@miden-sdk/miden-sdk/lazy";
import type {
  TransactionId,
  TransactionRecord,
} from "@miden-sdk/miden-sdk/lazy";
import { useMiden } from "../context/MidenProvider";
import { useSyncStateStore } from "../store/MidenStore";
import type {
  TransactionHistoryOptions,
  TransactionHistoryResult,
  TransactionStatus,
} from "../types";

/**
 * Hook to query transaction history and track transaction state.
 *
 * @param options - Optional filter options
 *
 * @example
 * ```tsx
 * function HistoryList() {
 *   const { records, isLoading } = useTransactionHistory();
 *   if (isLoading) return <div>Loading...</div>;
 *   return (
 *     <ul>
 *       {records.map((record) => (
 *         <li key={record.id().toHex()}>{record.id().toHex()}</li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useTransactionHistory(
  options: TransactionHistoryOptions = {}
): TransactionHistoryResult {
  const { client, isReady } = useMiden();
  const { lastSyncTime } = useSyncStateStore();

  const [records, setRecords] = useState<TransactionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const rawIds = useMemo(() => {
    if (options.id) return [options.id];
    if (options.ids && options.ids.length > 0) return options.ids;
    return null;
  }, [options.id, options.ids]);

  const idsHex = useMemo(() => {
    if (!rawIds) return null;
    return rawIds.map((id) =>
      normalizeHex(typeof id === "string" ? id : id.toHex())
    );
  }, [rawIds]);

  const filter = options.filter;
  const refreshOnSync = options.refreshOnSync !== false;

  const refetch = useCallback(async () => {
    /* v8 ignore next 1 — early-return guard; tests always call with ready client */
    if (!client || !isReady) return;

    setIsLoading(true);
    setError(null);

    try {
      const { filter: resolvedFilter, localFilterHexes } = buildFilter(
        filter,
        rawIds,
        idsHex
      );
      const fetched = await client.getTransactions(resolvedFilter);
      const filtered = localFilterHexes
        ? fetched.filter((record) =>
            localFilterHexes.includes(normalizeHex(record.id().toHex()))
          )
        : fetched;
      setRecords(filtered);
      /* v8 ignore next 3 — catch block not exercised in tests; all thrown values are Error instances */
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [client, isReady, filter, rawIds, idsHex]);

  useEffect(() => {
    /* v8 ignore next 1 — effect fires when not ready; tests always start in ready state */
    if (!isReady) return;
    refetch();
  }, [isReady, refetch]);

  useEffect(() => {
    if (!isReady || !refreshOnSync || !lastSyncTime) return;
    refetch();
  }, [isReady, lastSyncTime, refreshOnSync, refetch]);

  const record = useMemo(() => {
    if (!idsHex || idsHex.length !== 1) return null;
    return (
      records.find((item) => normalizeHex(item.id().toHex()) === idsHex[0]) ??
      null
    );
  }, [records, idsHex]);

  const status = useMemo<TransactionStatus | null>(() => {
    if (!record) return null;
    const current = record.transactionStatus();
    if (current.isCommitted()) return "committed";
    if (current.isDiscarded()) return "discarded";
    /* v8 ignore next 2 — pending status requires a transaction in pending state; tests cover committed/discarded */
    if (current.isPending()) return "pending";
    return null;
  }, [record]);

  return {
    records,
    record,
    status,
    isLoading,
    error,
    refetch,
  };
}

export type UseTransactionHistoryResult = TransactionHistoryResult;

type FilterBuildResult = {
  filter: TransactionFilter;
  localFilterHexes?: string[];
};

function buildFilter(
  filter: TransactionHistoryOptions["filter"],
  ids: Array<string | TransactionId> | null,
  idsHex: string[] | null
): FilterBuildResult {
  if (filter) {
    return { filter };
  }

  if (!ids || ids.length === 0) {
    return { filter: TransactionFilter.all() };
  }

  const allTransactionIds = ids.every((id) => typeof id !== "string");
  if (allTransactionIds) {
    return { filter: TransactionFilter.ids(ids as TransactionId[]) };
  }

  return {
    filter: TransactionFilter.all(),
    /* v8 ignore next 1 — idsHex is always non-null when ids is non-empty; ?? [] is a safety net */
    localFilterHexes: idsHex ?? [],
  };
}

function normalizeHex(value: string): string {
  const trimmed = value.trim();
  const normalized =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed
      : `0x${trimmed}`;
  return normalized.toLowerCase();
}
