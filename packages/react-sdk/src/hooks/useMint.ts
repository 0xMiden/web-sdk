import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  MintNonFungibleOptions,
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

export interface UseMintNonFungibleResult {
  /** Mint one non-fungible asset from a non-fungible faucet to a target account */
  mintNonFungible: (
    options: MintNonFungibleOptions
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
 * Hook to mint tokens from a faucet.
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
 *   return (
 *     <button onClick={handleMint} disabled={isLoading}>
 *       {isLoading ? stage : 'Mint Tokens'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useMint(): UseMintResult {
  return useMintAsset(false);
}

/**
 * Hook to mint one non-fungible asset from a non-fungible faucet. The asset
 * must be issued by `faucetId`; build it with
 * `NonFungibleAsset.fromData(faucetId, data, salt)`.
 *
 * @example
 * ```tsx
 * const { mintNonFungible, isLoading } = useMintNonFungible();
 *
 * await mintNonFungible({
 *   faucetId,
 *   targetAccountId,
 *   nonFungibleAsset: NonFungibleAsset.fromData(
 *     AccountId.fromHex(faucetId),
 *     data, // the NFT's data, as bytes
 *     salt // a random Word; keep it with the data
 *   ),
 * });
 * ```
 */
export function useMintNonFungible(): UseMintNonFungibleResult {
  const { mint, ...state } = useMintAsset(true);
  return { mintNonFungible: mint, ...state };
}

function useMintAsset(nonFungible: boolean) {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const mint = useCallback(
    async (
      options: MintOptions | MintNonFungibleOptions
    ): Promise<TransactionResult> => {
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
        const nonFungibleAsset = nonFungible
          ? (options as MintNonFungibleOptions).nonFungibleAsset
          : undefined;
        if (nonFungible && !nonFungibleAsset) {
          throw new Error("mintNonFungible requires `nonFungibleAsset`");
        }
        if (
          nonFungibleAsset &&
          nonFungibleAsset.faucetId().toString() !== faucetIdObj.toString()
        ) {
          throw new Error(
            "`nonFungibleAsset` must be issued by the faucet `faucetId`"
          );
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
                BigInt((options as MintOptions).amount)
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
    [client, isReady, nonFungible, prover, runExclusive, sync]
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
