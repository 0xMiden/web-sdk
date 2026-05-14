import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  PswapCreateOptions,
  TransactionStage,
  TransactionResult,
} from "../types";
import { DEFAULTS } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";
import { getNoteType } from "../utils/noteFilters";

export interface UsePswapCreateResult {
  /** Create a partial-swap (PSWAP) note */
  pswapCreate: (options: PswapCreateOptions) => Promise<TransactionResult>;
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
 * Hook to create a partial-swap (PSWAP) note offering one fungible asset for
 * another. The resulting note can be filled by multiple consumers; each fill
 * emits a payback note to the creator and, on a partial fill, a remainder
 * PSWAP note carrying the unfilled amount.
 *
 * @example
 * ```tsx
 * function CreatePswapButton({ accountId }: { accountId: string }) {
 *   const { pswapCreate, isLoading, stage, error } = usePswapCreate();
 *
 *   const handleCreate = async () => {
 *     const result = await pswapCreate({
 *       accountId,
 *       offeredFaucetId: '0x...',
 *       offeredAmount: 100n,
 *       requestedFaucetId: '0x...',
 *       requestedAmount: 50n,
 *     });
 *     console.log('PSWAP created! TX:', result.transactionId);
 *   };
 *
 *   return (
 *     <button onClick={handleCreate} disabled={isLoading}>
 *       {isLoading ? stage : 'Create PSWAP'}
 *     </button>
 *   );
 * }
 * ```
 */
export function usePswapCreate(): UsePswapCreateResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const pswapCreate = useCallback(
    async (options: PswapCreateOptions): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const noteType = getNoteType(options.noteType ?? DEFAULTS.NOTE_TYPE);
        const paybackNoteType = getNoteType(
          options.paybackNoteType ?? DEFAULTS.NOTE_TYPE
        );

        const accountIdObj = parseAccountId(options.accountId);
        const offeredFaucetIdObj = parseAccountId(options.offeredFaucetId);
        const requestedFaucetIdObj = parseAccountId(options.requestedFaucetId);

        setStage("proving");
        const txResult = await runExclusiveSafe(async () => {
          const txRequest = await client.newPswapCreateTransactionRequest(
            accountIdObj,
            offeredFaucetIdObj,
            BigInt(options.offeredAmount),
            requestedFaucetIdObj,
            BigInt(options.requestedAmount),
            noteType,
            paybackNoteType
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
    pswapCreate,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
