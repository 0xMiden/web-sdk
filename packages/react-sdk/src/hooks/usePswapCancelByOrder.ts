import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  PswapCancelByOrderOptions,
  TransactionStage,
  TransactionResult,
} from "../types";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UsePswapCancelByOrderResult {
  /** Cancel a PSWAP lineage by its stable order id, reclaiming the unfilled offered asset. */
  pswapCancelByOrder: (
    options: PswapCancelByOrderOptions
  ) => Promise<TransactionResult>;
  /** The transaction result */
  result: TransactionResult | null;
  /** Whether the transaction is in progress */
  isLoading: boolean;
  /** Current stage of the transaction */
  stage: TransactionStage;
  /** Error if transaction failed */
  error: Error | null;
  /** Reset the hook state */
  reset: () => void;
}

/**
 * Hook to cancel a PSWAP lineage by its stable order id and reclaim the
 * unfilled offered asset on the lineage's current tip. Unlike
 * {@link usePswapCancel}, the creator account and tip note are resolved from
 * the locally tracked lineage, so only the order id is required.
 *
 * @example
 * ```tsx
 * function CancelOrderButton({ orderId }: { orderId: string }) {
 *   const { pswapCancelByOrder, isLoading, stage } = usePswapCancelByOrder();
 *   return (
 *     <button onClick={() => pswapCancelByOrder({ orderId })} disabled={isLoading}>
 *       {isLoading ? stage : "Cancel order"}
 *     </button>
 *   );
 * }
 * ```
 */
export function usePswapCancelByOrder(): UsePswapCancelByOrderResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const pswapCancelByOrder = useCallback(
    async (options: PswapCancelByOrderOptions): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const orderId = String(options.orderId);

        setStage("proving");
        const txResult = await runExclusiveSafe(async () => {
          const lineage = await client.getPswapLineage(orderId);
          if (!lineage) {
            throw new Error(`No PSWAP lineage tracked for order ${orderId}`);
          }
          const accountIdObj = lineage.creatorAccountId();

          // Terminal-state guard lives in the WASM `buildPswapCancelByOrder`
          // binding (the shared layer), so it can't be bypassed here; it
          // throws before any tx is submitted.
          const txRequest = await client.buildPswapCancelByOrder(orderId);

          const txId = prover
            ? await client.submitNewTransactionWithProver(
                accountIdObj,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(accountIdObj, txRequest);

          return { transactionId: txId.toHex() };
        });

        setResult(txResult);

        // Stage flips to "complete" AFTER `sync()` so consumers don't briefly
        // observe stage === "complete" while the tracked lineage still reads
        // Active — `usePswapLineage*` only refetch when sync bumps
        // `lastSyncTime`, so we wait for that signal to land first.
        await sync();
        setStage("complete");

        return txResult;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setStage("idle");
        throw error;
        /* v8 ignore next 1 — V8 counts } finally { as a branch for the exception-entry path */
      } finally {
        setIsLoading(false);
      }
    },
    [client, isReady, prover, runExclusive, sync]
  );

  const reset = useCallback(() => {
    setResult(null);
    setIsLoading(false);
    setStage("idle");
    setError(null);
  }, []);

  return {
    pswapCancelByOrder,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
