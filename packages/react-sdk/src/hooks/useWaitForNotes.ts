import { useCallback } from "react";
import { useMiden } from "../context/MidenProvider";
import type { ConsumableNoteRecord } from "@miden-sdk/miden-sdk";
import type { WaitForNotesOptions } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UseWaitForNotesResult {
  /** Wait until an account has consumable notes */
  waitForConsumableNotes: (
    options: WaitForNotesOptions
  ) => Promise<ConsumableNoteRecord[]>;
}

type ClientWithNotes = {
  syncState: () => Promise<unknown>;
  getConsumableNotes: (accountId?: unknown) => Promise<ConsumableNoteRecord[]>;
};

export function useWaitForNotes(): UseWaitForNotesResult {
  const { client, isReady, runExclusive } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const waitForConsumableNotes = useCallback(
    async (options: WaitForNotesOptions): Promise<ConsumableNoteRecord[]> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      const timeoutMs = Math.max(0, options.timeoutMs ?? 10_000);
      const intervalMs = Math.max(1, options.intervalMs ?? 1_000);
      const minCount = Math.max(1, options.minCount ?? 1);

      // Validate the account reference up front so a malformed id still
      // rejects before the first sync, then release the handle — the ones
      // actually handed to WASM are rebuilt per poll below.
      (parseAccountId(options.accountId) as { free?: () => void }).free?.();

      let waited = 0;

      while (waited < timeoutMs) {
        await runExclusiveSafe(() =>
          (client as unknown as ClientWithNotes).syncState()
        );
        // `getConsumableNotes` takes `Option<AccountId>` by value, so
        // wasm-bindgen moves the handle out of JS on every call. Reusing one
        // `AccountId` across iterations traps with "null pointer passed to
        // rust" on the second poll — i.e. exactly when the wait actually has
        // to wait. Build a fresh handle each time.
        const consumable = await runExclusiveSafe(() =>
          (client as unknown as ClientWithNotes).getConsumableNotes(
            parseAccountId(options.accountId)
          )
        );
        if (consumable.length >= minCount) {
          return consumable;
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        waited += intervalMs;
      }

      throw new Error("Timeout waiting for consumable notes");
    },
    [client, isReady, runExclusiveSafe]
  );

  return { waitForConsumableNotes };
}
