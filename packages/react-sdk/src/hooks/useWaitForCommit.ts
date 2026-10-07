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

      // A caller's TransactionId is read once and never handed on: the poll
      // builds its own handle each time, so the caller's stays usable.
      await waitForTransactionCommit(
        client as unknown as ClientWithTransactions,
        runExclusiveDirect,
        typeof txId === "string" ? txId : txId.toHex(),
        Math.max(0, options?.timeoutMs ?? 10_000),
        Math.max(1, options?.intervalMs ?? 1_000)
      );
    },
    [client, isReady]
  );

  return { waitForCommit };
}
