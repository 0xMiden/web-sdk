import { useCallback, useState } from "react";
import { EthAddress } from "@miden-sdk/miden-sdk";
import { useMiden } from "../context/MidenProvider";
import type {
  BridgeOptions,
  TransactionResult,
  TransactionStage,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UseBridgeResult {
  /** Bridge a fungible asset out to another network via the AggLayer */
  bridge: (options: BridgeOptions) => Promise<TransactionResult>;
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
 * Hook to bridge a fungible asset out to another network via the AggLayer.
 *
 * Emits a single public B2AGG (Bridge-to-AggLayer) note that the bridge account consumes,
 * burning the asset so it can be claimed at the destination Ethereum address on the destination
 * network. The sender account executes the transaction that emits the note.
 *
 * Returns `{ bridge, result, isLoading, stage, error, reset }`. `bridge` resolves to a
 * `TransactionResult` (`{ transactionId }`) and rejects on failure.
 *
 * @example
 * ```tsx
 * function BridgeButton({ from, bridgeAccount, assetId }: Props) {
 *   const { bridge, isLoading, stage, error } = useBridge();
 *
 *   const handleBridge = async () => {
 *     try {
 *       const result = await bridge({
 *         from,
 *         bridgeAccount,
 *         assetId,
 *         amount: 100n,
 *         destinationNetwork: 1,
 *         destinationAddress: "0x000000000000000000000000000000000000dEaD",
 *       });
 *       console.log("Bridged! TX:", result.transactionId);
 *     } catch (err) {
 *       console.error("Bridge failed:", err);
 *     }
 *   };
 *
 *   return (
 *     <button onClick={handleBridge} disabled={isLoading}>
 *       {isLoading ? stage : "Bridge"}
 *     </button>
 *   );
 * }
 * ```
 */
export function useBridge(): UseBridgeResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const bridge = useCallback(
    async (options: BridgeOptions): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const senderId = parseAccountId(options.from);
        const bridgeId = parseAccountId(options.bridgeAccount);
        const assetId = parseAccountId(options.assetId);
        const destinationAddress = EthAddress.fromHex(
          options.destinationAddress
        );

        setStage("proving");
        const txResult = await runExclusiveSafe(async () => {
          const txRequest = await client.newB2AggTransactionRequest(
            senderId,
            bridgeId,
            assetId,
            BigInt(options.amount),
            options.destinationNetwork,
            destinationAddress
          );

          // The sender executes the transaction that emits the bridge note.
          const txId = prover
            ? await client.submitNewTransactionWithProver(
                senderId,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(senderId, txRequest);

          return { transactionId: txId.toHex() };
        });

        setStage("complete");
        setResult(txResult);

        if (!options.skipSync) {
          await sync();
        }

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
    bridge,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
