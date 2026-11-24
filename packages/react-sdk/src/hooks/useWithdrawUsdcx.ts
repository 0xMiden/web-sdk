import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  TransactionResult,
  TransactionStage,
  WithdrawUsdcxOptions,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { toAmount } from "../utils/amounts";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UseWithdrawUsdcxResult {
  /** Withdraw USDCx to another chain through Circle xReserve */
  withdrawUsdcx: (options: WithdrawUsdcxOptions) => Promise<TransactionResult>;
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
 * Hook to withdraw USDCx through Circle xReserve.
 *
 * Emits a single public burn note that the USDCx faucet (a public account)
 * consumes and burns; Circle then releases USDC to `destinationRecipient` on
 * `destinationDomain`. The sender account executes the transaction.
 *
 * Returns `{ withdrawUsdcx, result, isLoading, stage, error, reset }`.
 * `withdrawUsdcx` resolves to a `TransactionResult` (`{ transactionId }`) and
 * rejects on failure, including an unsafe number amount, a
 * `destinationDomain` that is not a u32 integer or a recipient that is not 32
 * bytes of 0x-prefixed hex.
 *
 * @example
 * ```tsx
 * const { withdrawUsdcx, isLoading } = useWithdrawUsdcx();
 * await withdrawUsdcx({
 *   from,
 *   faucetId: usdcxFaucetId,
 *   amount: 1_000_000n,
 *   destinationDomain: 6, // Arbitrum
 *   destinationRecipient: "0x" + evmAddress.slice(2).padStart(64, "0"),
 * });
 * ```
 */
export function useWithdrawUsdcx(): UseWithdrawUsdcxResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<TransactionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const withdrawUsdcx = useCallback(
    async (options: WithdrawUsdcxOptions): Promise<TransactionResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const amount = toAmount(options.amount, "withdrawUsdcx");
        const domain = options.destinationDomain;
        // The wasm parameter is a u32, which wraps or zeroes anything else.
        if (!Number.isInteger(domain) || domain < 0 || domain > 0xffffffff) {
          throw new Error(
            "withdrawUsdcx: destinationDomain must be an integer from 0 to 4294967295"
          );
        }
        const recipientHex = options.destinationRecipient;
        if (
          typeof recipientHex !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(recipientHex)
        ) {
          throw new Error(
            "withdrawUsdcx: destinationRecipient must be a 0x-prefixed 32-byte hex string"
          );
        }
        const recipient = Uint8Array.from(
          recipientHex.slice(2).match(/../g)!,
          (byte) => parseInt(byte, 16)
        );
        const senderId = parseAccountId(options.from);
        const faucetId = parseAccountId(options.faucetId);

        setStage("proving");
        const txResult = await runExclusiveSafe(async () => {
          const txRequest = await client.newXReserveBurnTransactionRequest(
            senderId,
            faucetId,
            amount,
            domain,
            recipient
          );

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

  return { withdrawUsdcx, result, isLoading, stage, error, reset };
}
