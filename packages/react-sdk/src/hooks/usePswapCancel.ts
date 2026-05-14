import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  PswapCancelOptions,
  TransactionStage,
  TransactionResult,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { resolveNoteInput } from "../utils/notes";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UsePswapCancelResult {
  /** Cancel a partial-swap (PSWAP) note as the creator */
  pswapCancel: (options: PswapCancelOptions) => Promise<TransactionResult>;
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
 * Hook to cancel a PSWAP note as the creator and reclaim the offered asset.
 *
 * @example
 * ```tsx
 * function CancelPswapButton({ accountId, note }: Props) {
 *   const { pswapCancel, isLoading, stage } = usePswapCancel();
 *
 *   const handleCancel = async () => {
 *     await pswapCancel({ accountId, note });
 *   };
 *
 *   return (
 *     <button onClick={handleCancel} disabled={isLoading}>
 *       {isLoading ? stage : 'Cancel PSWAP'}
 *     </button>
 *   );
 * }
 * ```
 */
export function usePswapCancel(): UsePswapCancelResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const pswapCancel = useCallback(
    async (options: PswapCancelOptions): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const accountIdObj = parseAccountId(options.accountId);

        setStage("proving");
        const txResult = await runExclusiveSafe(async () => {
          const note = await resolveNoteInput(options.note, client);

          const txRequest = await client.newPswapCancelTransactionRequest(note);

          const txId = prover
            ? await client.submitNewTransactionWithProver(
                accountIdObj,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(accountIdObj, txRequest);

          return { transactionId: txId.toString() };
        });

        setStage("complete");
        setResult(txResult);

        await sync();

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
    pswapCancel,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
