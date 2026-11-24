import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import {
  AccountStorageRequirements,
  ForeignAccount,
  ForeignAccountArray,
  Note,
  NoteArray,
} from "@miden-sdk/miden-sdk";
import type {
  ClaimAggLayerDepositOptions,
  NetworkNoteResult,
  TransactionStage,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";

export interface UseClaimAggLayerDepositResult {
  /** Claim an inbound AggLayer deposit */
  claimAggLayerDeposit: (
    options: ClaimAggLayerDepositOptions
  ) => Promise<NetworkNoteResult>;
  /** The submitted transaction id and CLAIM note */
  result: NetworkNoteResult | null;
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
 * Hook to claim an inbound AggLayer deposit.
 *
 * Emits the public CLAIM note built by `Note.createClaimNote`, which the bridge
 * account consumes to mint the deposit. The sender account executes the
 * transaction and declares the bridge as a foreign account.
 *
 * Returns `{ claimAggLayerDeposit, result, isLoading, stage, error, reset }`.
 * `claimAggLayerDeposit` resolves to `{ txId, note }` and rejects on failure,
 * including a `scale` that is not an integer from 0 to 18.
 *
 * @example
 * ```tsx
 * const { claimAggLayerDeposit } = useClaimAggLayerDeposit();
 * await claimAggLayerDeposit({ from, bridgeAccount, proof, leaf, scale: 10 });
 * ```
 */
export function useClaimAggLayerDeposit(): UseClaimAggLayerDepositResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<NetworkNoteResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const claimAggLayerDeposit = useCallback(
    async (
      options: ClaimAggLayerDepositOptions
    ): Promise<NetworkNoteResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const scale = options.scale;
        // The wasm parameter is a u32, which truncates or wraps anything else.
        if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
          throw new Error(
            "claimAggLayerDeposit: scale must be an integer from 0 to 18"
          );
        }
        const senderId = parseAccountId(options.from);
        const bridgeId = parseAccountId(options.bridgeAccount);

        setStage("proving");
        const claimed = await runExclusiveSafe(async () => {
          const note = Note.createClaimNote(
            options.proof,
            options.leaf,
            scale,
            bridgeId,
            senderId
          );
          const ownOutputs = new NoteArray();
          ownOutputs.push(note); // push keeps `note` valid to return
          // The CLAIM note targets the bridge, so it is priced against the
          // bridge like any network note; see useCreateNetworkNote.
          const bridgeAccounts = new ForeignAccountArray();
          bridgeAccounts.push(
            ForeignAccount.public(bridgeId, new AccountStorageRequirements())
          );
          const builder =
            await client.feeAwareTransactionRequestBuilder(senderId);
          const txRequest = builder
            .withOwnOutputNotes(ownOutputs)
            .withForeignAccounts(bridgeAccounts)
            .build();

          const txId = prover
            ? await client.submitNewTransactionWithProver(
                senderId,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(senderId, txRequest);

          return { txId: txId.toHex(), note };
        });

        setStage("complete");
        setResult(claimed);

        if (!options.skipSync) {
          await sync();
        }

        return claimed;
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

  return { claimAggLayerDeposit, result, isLoading, stage, error, reset };
}
