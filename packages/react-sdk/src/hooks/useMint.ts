import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  MintOptions,
  TransactionStage,
  TransactionResult,
} from "../types";
import { DEFAULTS } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";
import { getNoteType } from "../utils/noteFilters";

export interface UseMintResult {
  /** Mint tokens from a faucet to a target account */
  mint: (options: MintOptions) => Promise<TransactionResult>;
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
 * Hook to mint tokens from a faucet.
 *
 * To mint from a non-fungible faucet, pass `asset` in place of `amount`. The
 * asset must be issued by `faucetId`; build it with
 * `new NonFungibleAsset(faucetId, value)`.
 *
 * @example
 * ```tsx
 * function MintButton({ faucetId, targetAccountId }: Props) {
 *   const { mint, isLoading, stage, error } = useMint();
 *
 *   const handleMint = async () => {
 *     try {
 *       const result = await mint({
 *         faucetId,
 *         targetAccountId,
 *         amount: 1000n,
 *       });
 *       console.log('Minted! TX:', result.transactionId);
 *     } catch (err) {
 *       console.error('Mint failed:', err);
 *     }
 *   };
 *
 *   const handleMintNft = (value: Word) =>
 *     mint({
 *       faucetId,
 *       targetAccountId,
 *       asset: new NonFungibleAsset(AccountId.fromHex(faucetId), value),
 *     });
 *
 *   return (
 *     <button onClick={handleMint} disabled={isLoading}>
 *       {isLoading ? stage : 'Mint Tokens'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useMint(): UseMintResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const mint = useCallback(
    async (options: MintOptions): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const noteType = getNoteType(options.noteType ?? DEFAULTS.NOTE_TYPE);

        // Convert string IDs to AccountId objects
        const targetAccountIdObj = parseAccountId(options.targetAccountId);
        const faucetIdObj = parseAccountId(options.faucetId);
        const nonFungibleAsset = options.asset;

        if (nonFungibleAsset) {
          if (options.amount != null) {
            throw new Error("Pass either `asset` or `amount`, not both");
          }
          if (
            nonFungibleAsset.faucetId().toString() !== faucetIdObj.toString()
          ) {
            throw new Error("`asset` must be issued by the faucet `faucetId`");
          }
        }

        setStage("proving");
        const txResult = await runExclusiveSafe(async () => {
          const txRequest = nonFungibleAsset
            ? await client.newMintNonFungibleTransactionRequest(
                targetAccountIdObj,
                nonFungibleAsset,
                noteType
              )
            : await client.newMintTransactionRequest(
                targetAccountIdObj,
                faucetIdObj,
                noteType,
                BigInt(options.amount!)
              );

          const txId = prover
            ? await client.submitNewTransactionWithProver(
                faucetIdObj,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(faucetIdObj, txRequest);

          return { transactionId: txId.toHex() };
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
    mint,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
