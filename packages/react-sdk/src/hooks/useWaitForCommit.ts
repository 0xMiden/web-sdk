import { useCallback } from "react";
import { useMiden } from "../context/MidenProvider";
import type { TransactionId } from "@miden-sdk/miden-sdk";
import type { WaitForCommitOptions } from "../types";
import { runExclusiveDirect } from "../utils/runExclusive";
import { waitForTransactionCommit } from "../utils/transactionCommit";
import type { ClientWithTransactions } from "../utils/transactionCommit";

export interface UseWaitForCommitResult {
  /** Wait for a transaction to be committed on-chain */
  waitForCommit: (
    txId: string | TransactionId,
    options?: WaitForCommitOptions
  ) => Promise<void>;
}

export function useWaitForCommit(): UseWaitForCommitResult {
  const { client, isReady } = useMiden();

  const waitForCommit = useCallback(
    async (txId: string | TransactionId, options?: WaitForCommitOptions) => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      const timeoutMs = Math.max(0, options?.timeoutMs ?? 10_000);
      // A NaN interval would make every sleep a zero-length timer.
      const flooredInterval = Math.max(1, options?.intervalMs ?? 1_000);
      const intervalMs = Number.isNaN(flooredInterval)
        ? 1_000
        : flooredInterval;

      // Read the hex once, up front. `TransactionFilter.ids` takes its handles
      // by value, so the caller's `TransactionId` must never reach a filter:
      // the wait builds a fresh one for every poll instead.
      await waitForTransactionCommit(
        client as unknown as ClientWithTransactions,
        runExclusiveDirect,
        typeof txId === "string" ? txId : txId.toHex(),
        timeoutMs,
        intervalMs
      );
    },
    [client, isReady]
  );

  return { waitForCommit };
}
