import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  PswapConsumeOptions,
  TransactionStage,
  TransactionResult,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { resolveNoteInput } from "../utils/notes";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UsePswapConsumeResult {
  /** Fill (consume) an existing partial-swap (PSWAP) note */
  pswapConsume: (options: PswapConsumeOptions) => Promise<TransactionResult>;
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
 * Hook to consume (fully or partially fill) an existing PSWAP note. The
 * consumer supplies `fillAmount` of the requested asset and receives a
 * proportional share of the offered asset. A full fill produces only the
 * payback note; a partial fill also produces a remainder PSWAP note.
 *
 * @example
 * ```tsx
 * function FillPswapButton({ accountId, note }: Props) {
 *   const { pswapConsume, isLoading, stage } = usePswapConsume();
 *
 *   const handleFill = async () => {
 *     await pswapConsume({
 *       accountId,
 *       note,
 *       fillAmount: 25n,
 *     });
 *   };
 *
 *   return (
 *     <button onClick={handleFill} disabled={isLoading}>
 *       {isLoading ? stage : 'Fill PSWAP'}
 *     </button>
 *   );
 * }
 * ```
 */
export function usePswapConsume(): UsePswapConsumeResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const pswapConsume = useCallback(
    async (options: PswapConsumeOptions): Promise<TransactionResult> => {
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

          const txRequest = await client.newPswapConsumeTransactionRequest(
            note,
            accountIdObj,
            BigInt(options.fillAmount),
            BigInt(options.noteFillAmount ?? 0)
          );

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
    pswapConsume,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
