import { useCallback, useRef, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import {
  FungibleAsset,
  Note,
  NoteAssets,
  NoteType,
  NoteArray,
} from "@miden-sdk/miden-sdk";
import type { SendOptions, SendResult, TransactionStage } from "../types";
import { DEFAULTS } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";
import { createNoteAttachment, emptyAttachment } from "../utils/noteAttachment";
import { MidenError } from "../utils/errors";
import { getNoteType } from "../utils/noteFilters";
import { proveWithFallback } from "../utils/prover";
import {
  readOwedPrivateNotes,
  recipientRef,
  sentNoteOwed,
  settlePrivateNotes,
} from "../utils/privateNoteDelivery";
import { useMidenStore } from "../store/MidenStore";

export interface UseSendResult {
  /** Send tokens from one account to another */
  send: (options: SendOptions) => Promise<SendResult>;
  /** The transaction result */
  result: SendResult | null;
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
 * Hook to send tokens between accounts.
 *
 * A private send waits for the transaction to commit and then relays the note
 * to the recipient. If the note is not delivered after the transaction was
 * submitted, the call rejects with a `PrivateNoteDeliveryError` carrying the
 * transaction id and the undelivered note; pass them to
 * `useResendPrivateNotes` to try again.
 *
 * @example
 * ```tsx
 * function SendButton({ from, to, assetId }: Props) {
 *   const { send, isLoading, stage, error } = useSend();
 *
 *   const handleSend = async () => {
 *     try {
 *       const result = await send({
 *         from,
 *         to,
 *         assetId,
 *         amount: 100n,
 *       });
 *       console.log('Transaction ID:', result.transactionId);
 *     } catch (err) {
 *       console.error('Send failed:', err);
 *     }
 *   };
 *
 *   return (
 *     <button onClick={handleSend} disabled={isLoading}>
 *       {isLoading ? stage : 'Send'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useSend(): UseSendResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;
  const isBusyRef = useRef(false);

  const [result, setResult] = useState<SendResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const send = useCallback(
    async (options: SendOptions): Promise<SendResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      if (isBusyRef.current) {
        throw new MidenError(
          "A send is already in progress. Await the previous send before starting another.",
          { code: "SEND_BUSY" }
        );
      }

      isBusyRef.current = true;
      setIsLoading(true);
      setStage("executing");
      setError(null);
      setResult(null);

      try {
        // Auto-sync before send unless opted out
        if (!options.skipSync) {
          await sync();
        }

        const noteType = getNoteType(options.noteType ?? DEFAULTS.NOTE_TYPE);

        // Resolve amount — if sendAll, query the account balance
        let amount = options.amount;
        if (options.sendAll) {
          const resolvedAmount = await runExclusiveSafe(async () => {
            const fromId = parseAccountId(options.from);
            const account = await client.getAccount(fromId);
            if (!account) throw new Error("Account not found");
            const assetIdObj = parseAccountId(options.assetId);
            const balance = account.vault?.()?.getBalance?.(assetIdObj);
            if (balance === undefined || balance === null) {
              throw new Error("Could not query account balance");
            }
            const bal = BigInt(balance as number | bigint);
            if (bal === 0n) {
              throw new Error("Account has zero balance for this asset");
            }
            return bal;
          });
          amount = resolvedAmount;
        }

        if (amount === undefined || amount === null) {
          throw new Error("Amount is required (provide amount or sendAll)");
        }
        amount = BigInt(amount);

        const assetId =
          options.assetId ??
          (options as { faucetId?: string }).faucetId ??
          null;
        if (!assetId) {
          throw new Error("Asset ID is required");
        }

        // Build transaction — use attachment path if attachment provided
        const hasAttachment =
          options.attachment !== undefined && options.attachment !== null;

        if (
          hasAttachment &&
          (options.recallHeight != null || options.timelockHeight != null)
        ) {
          throw new Error(
            "recallHeight and timelockHeight are not supported when attachment is provided"
          );
        }

        // returnNote path: build note in JS, submit as output note, return Note object
        if (options.returnNote === true) {
          const returnResult = await runExclusiveSafe(async () => {
            const fromId = parseAccountId(options.from);
            const toId = parseAccountId(options.to);
            const assetObj = parseAccountId(assetId);

            const assets = new NoteAssets([
              new FungibleAsset(assetObj, BigInt(amount!)),
            ]);
            const p2idNote = Note.createP2IDNote(
              fromId,
              toId,
              assets,
              noteType,
              emptyAttachment()
            );

            // NoteArray constructor consumes its elements; use push(&note)
            // to keep `p2idNote` valid so the caller can use the returned Note.
            const ownOutputs = new NoteArray();
            ownOutputs.push(p2idNote);
            // The sender executes this transaction, so its auth procedure is
            // what pays the fee; a bare builder would abort with
            // ERR_FEE_CONVERSION_INFO_MISSING wherever the chain charges.
            const builder =
              await client.feeAwareTransactionRequestBuilder(fromId);
            const txRequest = builder.withOwnOutputNotes(ownOutputs).build();

            const txId = prover
              ? await client.submitNewTransactionWithProver(
                  fromId,
                  txRequest,
                  prover
                )
              : await client.submitNewTransaction(fromId, txRequest);

            return { txId: txId.toHex(), note: p2idNote } as SendResult;
          });

          setStage("complete");
          setResult(returnResult);
          await sync();

          return returnResult;
        }

        // On-chain path (default)
        const txResult = await runExclusiveSafe(async () => {
          // Create all WASM AccountId objects inside runExclusiveSafe to
          // avoid stale pointers if another exclusive operation runs between
          // creation and consumption.
          const fromAccountId = parseAccountId(options.from);
          const toAccountId = parseAccountId(options.to);
          const assetIdObj = parseAccountId(assetId);

          let txRequest;

          if (hasAttachment) {
            // Manual P2ID note construction with attachment
            const attachment = createNoteAttachment(options.attachment!);
            const assets = new NoteAssets([
              new FungibleAsset(assetIdObj, amount!),
            ]);
            const note = Note.createP2IDNote(
              fromAccountId,
              toAccountId,
              assets,
              noteType,
              attachment
            );
            const builder =
              await client.feeAwareTransactionRequestBuilder(fromAccountId);
            txRequest = builder
              .withOwnOutputNotes(new NoteArray([note]))
              .build();
          } else {
            txRequest = await client.newSendTransactionRequest(
              fromAccountId,
              toAccountId,
              assetIdObj,
              noteType,
              amount!,
              options.recallHeight ?? null,
              options.timelockHeight ?? null
            );
          }

          return await client.executeTransaction(fromAccountId, txRequest);
        });

        setStage("proving");
        const proverConfig = useMidenStore.getState().config;
        const provenTransaction = await proveWithFallback(
          (resolvedProver) =>
            runExclusiveSafe(() =>
              client.proveTransaction(txResult, resolvedProver)
            ),
          proverConfig
        );

        setStage("submitting");
        const submissionHeight = await runExclusiveSafe(() =>
          client.submitProvenTransaction(provenTransaction, txResult)
        );

        // Read once the transaction is submitted, so a failure from here on
        // still reports which transaction it was.
        const txIdHex = txResult.id().toHex();

        const apply = () =>
          runExclusiveSafe(() =>
            client.applyTransaction(txResult, submissionHeight)
          );
        if (noteType === NoteType.Private) {
          await settlePrivateNotes({
            client,
            runExclusiveSafe,
            transactionId: txIdHex,
            owed: readOwedPrivateNotes(() =>
              sentNoteOwed(txResult, recipientRef(options.to))
            ),
            apply,
          });
        } else {
          await apply();
        }

        const sendResult: SendResult = {
          txId: txIdHex,
          note: null,
        };

        setStage("complete");
        setResult(sendResult);

        await sync();

        return sendResult;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        setStage("idle");
        throw error;
      } finally {
        setIsLoading(false);
        isBusyRef.current = false;
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
    send,
    result,
    isLoading,
    stage,
    error,
    reset,
  };
}
