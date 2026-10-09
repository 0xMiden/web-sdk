import { useCallback, useEffect, useMemo, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import {
  useMidenStore,
  useNotesStore,
  useConsumableNotesStore,
  useSyncStateStore,
} from "../store/MidenStore";
import { isConsumableNow, NoteFilter } from "@miden-sdk/miden-sdk";
import type { NotesFilter, NotesResult, NoteSummary } from "../types";
import { getNoteSummary } from "../utils/notes";
import { useAssetMetadata } from "./useAssetMetadata";
import { parseAccountId } from "../utils/accountParsing";
import { getNoteFilterType } from "../utils/noteFilters";

// Senders are matched by account id, not by display string: the bech32 form
// carries the network of the provider's client, which a sender filter computed
// before that client existed would not.
const accountIdKey = (value: string): string => {
  let id: ReturnType<typeof parseAccountId> | undefined;
  try {
    id = parseAccountId(value);
    return id.toString();
  } catch {
    return value;
  } finally {
    (id as { free?: () => void } | undefined)?.free?.();
  }
};

/**
 * Hook to list notes.
 *
 * @param options - Optional filter options
 *
 * @example
 * ```tsx
 * function NotesList() {
 *   const { notes, consumableNotes, isLoading, refetch } = useNotes();
 *
 *   if (isLoading) return <div>Loading...</div>;
 *
 *   return (
 *     <div>
 *       <h2>All Notes ({notes.length})</h2>
 *       {notes.map(n => (
 *         <div key={n.id().toString()}>
 *           Note: {n.id().toString()} - {n.isConsumed() ? 'Consumed' : 'Pending'}
 *         </div>
 *       ))}
 *
 *       <h2>Consumable Notes ({consumableNotes.length})</h2>
 *       {consumableNotes.map(n => (
 *         <div key={n.inputNoteRecord().id().toString()}>
 *           {n.inputNoteRecord().id().toString()}
 *         </div>
 *       ))}
 *
 *       <button onClick={refetch}>Refresh</button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useNotes(options?: NotesFilter): NotesResult {
  const { client, isReady } = useMiden();
  const notes = useNotesStore();
  const consumableNotes = useConsumableNotesStore();
  const isLoadingNotes = useMidenStore((state) => state.isLoadingNotes);
  const setLoadingNotes = useMidenStore((state) => state.setLoadingNotes);
  const setNotesIfChanged = useMidenStore((state) => state.setNotesIfChanged);
  const setConsumableNotesIfChanged = useMidenStore(
    (state) => state.setConsumableNotesIfChanged
  );
  const { lastSyncTime } = useSyncStateStore();

  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!client || !isReady) return;

    setLoadingNotes(true);
    setError(null);

    try {
      const filterType = getNoteFilterType(options?.status);
      const filter = new NoteFilter(filterType);

      const fetchedNotes = await client.getInputNotes(filter);

      // Block-locked notes come back from the screener but cannot be consumed
      // yet, so they are not "consumable" here either - the same rule
      // notes.listAvailable and transactions.consumeAll apply.
      let fetchedConsumable;
      if (options?.accountId) {
        const accountIdObj = parseAccountId(options.accountId);
        const accountIdHex = accountIdObj.toString();
        fetchedConsumable = (
          await client.getConsumableNotes(accountIdObj)
        ).filter((record) => isConsumableNow(record, accountIdHex));
      } else {
        fetchedConsumable = (await client.getConsumableNotes()).filter(
          (record) => isConsumableNow(record)
        );
      }

      // Smart refetch: only update store if note IDs changed (prevents unnecessary re-renders)
      setNotesIfChanged(fetchedNotes);
      setConsumableNotesIfChanged(fetchedConsumable);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoadingNotes(false);
    }
  }, [
    client,
    isReady,
    options?.status,
    options?.accountId,
    setLoadingNotes,
    setNotesIfChanged,
    setConsumableNotesIfChanged,
  ]);

  // Initial fetch
  useEffect(() => {
    if (isReady && notes.length === 0) {
      refetch();
    }
  }, [isReady, notes.length, refetch]);

  // Refresh after successful syncs to keep notes current
  useEffect(() => {
    if (!isReady || !lastSyncTime) return;
    refetch();
  }, [isReady, lastSyncTime, refetch]);

  const noteAssetIds = useMemo(() => {
    const ids = new Set<string>();
    const collect = (note: unknown) => {
      const summary = getNoteSummary(note as never);
      if (!summary) return;
      summary.assets.forEach((asset) => ids.add(asset.assetId));
    };

    notes.forEach(collect);
    consumableNotes.forEach(collect);

    return Array.from(ids);
  }, [notes, consumableNotes]);

  const { assetMetadata } = useAssetMetadata(noteAssetIds);
  const getMetadata = useCallback(
    (assetId: string) => assetMetadata.get(assetId),
    [assetMetadata]
  );

  // Resolve the sender once outside the loop to avoid per-note WASM allocations
  const senderId = useMemo(
    () => (options?.sender ? accountIdKey(options.sender) : null),
    [options?.sender]
  );

  // Serialize excludeIds to a stable string key so array literals don't defeat memoization
  const excludeIdsKey = useMemo(() => {
    if (!options?.excludeIds || options.excludeIds.length === 0) return "";
    return [...options.excludeIds].sort().join("\0");
  }, [options?.excludeIds]);

  // Helper: resolve each sender string once per pass; parseAccountId is a WASM
  // call per invocation.
  const filterBySender = useCallback(
    (summaries: NoteSummary[], target: string): NoteSummary[] => {
      const cache = new Map<string, string>();
      return summaries.filter((s) => {
        if (!s.sender) return false;
        let id = cache.get(s.sender);
        if (id === undefined) {
          id = accountIdKey(s.sender);
          cache.set(s.sender, id);
        }
        return id === target;
      });
    },
    []
  );

  // Build summaries with optional sender and excludeIds filters
  const noteSummaries = useMemo(() => {
    let summaries = notes
      .map((note) => getNoteSummary(note, getMetadata))
      .filter(Boolean) as NoteSummary[];

    if (senderId) {
      summaries = filterBySender(summaries, senderId);
    }

    if (excludeIdsKey) {
      const excludeSet = new Set(excludeIdsKey.split("\0"));
      summaries = summaries.filter((s) => !excludeSet.has(s.id));
    }

    return summaries;
  }, [notes, getMetadata, senderId, excludeIdsKey, filterBySender]);

  const consumableNoteSummaries = useMemo(() => {
    let summaries = consumableNotes
      .map((note) => getNoteSummary(note, getMetadata))
      .filter(Boolean) as NoteSummary[];

    if (senderId) {
      summaries = filterBySender(summaries, senderId);
    }

    if (excludeIdsKey) {
      const excludeSet = new Set(excludeIdsKey.split("\0"));
      summaries = summaries.filter((s) => !excludeSet.has(s.id));
    }

    return summaries;
  }, [consumableNotes, getMetadata, senderId, excludeIdsKey, filterBySender]);

  return {
    notes,
    consumableNotes,
    noteSummaries,
    consumableNoteSummaries,
    isLoading: isLoadingNotes,
    error,
    refetch,
  };
}
