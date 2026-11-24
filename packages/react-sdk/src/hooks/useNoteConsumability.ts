import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Note,
  NoteConsumability,
  WasmWebClient as WebClient,
} from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import { useSyncStateStore } from "../store/MidenStore";
import { captureClientReadGuard } from "../store/clientReadGuard";
import type {
  NoteConsumabilityOptions,
  NoteConsumabilityResult,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { getNoteConsumabilityStatus } from "../utils/noteConsumability";

/**
 * Hook to show whether a note can be consumed: now, after a block height, or
 * never. It screens the note, imported or not, with the screener sync uses,
 * and screens it again after each sync. The note is not stored.
 *
 * It only presents the screen. Notes offered for consumption still come from
 * `useNotes().consumableNotes`, which holds payments consumable now: a note
 * reported `immediately` here may be another trader's PSWAP order, which
 * consuming would fill from the account's vault.
 *
 * `status` stays null when the client tracks no account to screen.
 *
 * @param note - The note to screen; pass null or undefined to screen nothing.
 * @param options - Optional account to screen for; it must be in the client's
 *   store. Omit to screen every tracked account.
 *
 * @example
 * ```tsx
 * function NoteStatus({ note }: { note: Note }) {
 *   const { status } = useNoteConsumability(note, { accountId });
 *   if (!status) return <span>Checking...</span>;
 *   if (status.kind === "immediately") return <span>Claimable</span>;
 *   if (status.kind === "afterBlock")
 *     return <span>Unlocks at block {status.blockHeight}</span>;
 *   return <span>Not claimable</span>;
 * }
 * ```
 */
export function useNoteConsumability(
  note: Note | null | undefined,
  options?: NoteConsumabilityOptions
): NoteConsumabilityResult {
  const { client, isReady } = useMiden();
  const { lastSyncTime } = useSyncStateStore();
  const accountId = options?.accountId;
  const accountKey = useMemo(() => {
    if (accountId == null) return null;
    if (typeof accountId === "string") return accountId;
    return parseAccountId(accountId).toString();
  }, [accountId]);
  // Keyed by id: a caller building the note each render must not re-screen it.
  const noteKey = note ? note.id().toString() : null;
  const key = noteKey == null ? null : `${noteKey}|${accountKey ?? ""}`;

  const noteRef = useRef(note);
  noteRef.current = note;
  const latestRequestRef = useRef(0);
  // The producing client is stored: a replacement client must not show it.
  const [result, setResult] = useState<{
    key: string;
    client: WebClient;
    entries: NoteConsumability[];
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    const request = ++latestRequestRef.current;
    const current = noteRef.current;
    if (!client || !isReady || !current || key == null) {
      setIsLoading(false);
      setError(null);
      return;
    }
    const isCurrent = captureClientReadGuard(client);
    if (!isCurrent()) return;
    setIsLoading(true);
    setError(null);
    try {
      const entries =
        accountKey == null
          ? await client.getNoteConsumability(current)
          : await client.getNoteConsumabilityForAccount(
              current,
              parseAccountId(accountKey)
            );
      // An empty unfiltered screen is not `never` when no account was screened.
      const screened =
        accountKey != null ||
        entries.length > 0 ||
        (await client.getAccounts()).length > 0;
      if (!isCurrent() || latestRequestRef.current !== request) return;
      setResult(screened ? { key, client, entries } : null);
    } catch (err) {
      if (!isCurrent() || latestRequestRef.current !== request) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (latestRequestRef.current === request) setIsLoading(false);
    }
  }, [client, isReady, key, accountKey]);

  useEffect(() => {
    refetch();
  }, [refetch, lastSyncTime]);

  const entries =
    result && result.key === key && result.client === client
      ? result.entries
      : null;
  const status = useMemo(
    () => (entries ? getNoteConsumabilityStatus(entries) : null),
    [entries]
  );

  return {
    status,
    consumability: entries,
    isLoading,
    error,
    refetch,
  };
}
