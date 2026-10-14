import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  BurnNonFungibleOptions,
  TransactionStage,
  TransactionResult,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UseBurnNonFungibleResult {
  /** Send a non-fungible asset back to its faucet to be burned */
  burnNonFungible: (
    options: BurnNonFungibleOptions
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
 * Hook to burn a non-fungible asset. It sends the asset from `accountId` back
 * to its faucet in a public BURN note; the asset is burned when the faucet that
 * issued it consumes the note (for example with `useConsume`).
 *
 * @example
 * ```tsx
 * const { burnNonFungible, isLoading } = useBurnNonFungible();
 * const { nonFungibleAssets } = useAccount(accountId);
 *
 * await burnNonFungible({
 *   accountId,
 *   nonFungibleAsset: nonFungibleAssets[0].asset,
 * });
 * ```
 */
export function useBurnNonFungible(): UseBurnNonFungibleResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const burnNonFungible = useCallback(
    async (options: BurnNonFungibleOptions): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("proving");
      setError(null);

      try {
        if (!options.nonFungibleAsset) {
          throw new Error("burnNonFungible requires `nonFungibleAsset`");
        }

        const txResult = await runExclusiveSafe(async () => {
          // Create the WASM AccountId objects inside runExclusiveSafe so they
          // are not stale when the client consumes them.
          const txRequest =
            await client.newBurnNonFungibleAssetTransactionRequest(
              parseAccountId(options.accountId),
              options.nonFungibleAsset
            );
          const accountId = parseAccountId(options.accountId);
          const txId = prover
            ? await client.submitNewTransactionWithProver(
                accountId,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(accountId, txRequest);

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
    burnNonFungible,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
