
import { useCallback } from "react";
import { useMiden } from "../context/MidenProvider";
import { isConsumableNow } from "@miden-sdk/miden-sdk";
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
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        await runExclusiveSafe(() =>
          (client as unknown as ClientWithNotes).syncState()
        );

        const accountId = parseAccountId(options.accountId);
        const accountIdHex = accountId.toString();

        const consumable = (
          await runExclusiveSafe(() =>
            (client as unknown as ClientWithNotes).getConsumableNotes(accountId)
          )
        ).filter((record) => isConsumableNow(record, accountIdHex));

        if (consumable.length >= minCount) {
          return consumable;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }

        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(intervalMs, remainingMs))
        );
      }

      throw new Error("Timeout waiting for consumable notes");
    },
    [client, isReady, runExclusiveSafe]
  );

  return { waitForConsumableNotes };
}
