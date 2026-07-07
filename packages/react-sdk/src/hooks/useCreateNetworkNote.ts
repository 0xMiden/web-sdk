import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import {
  Felt,
  FeltArray,
  FungibleAsset,
  Note,
  NoteArray,
  NoteAssets,
  NoteMetadata,
  NoteStorage,
  NoteRecipient,
  NoteTag,
  NoteType,
  NetworkAccountTarget,
  TransactionRequestBuilder,
} from "@miden-sdk/miden-sdk";
import type {
  CreateNetworkNoteOptions,
  NetworkNoteResult,
  TransactionStage,
} from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";
import { createNoteAttachment } from "../utils/noteAttachment";

export interface UseCreateNetworkNoteResult {
  /** Build + submit a Public custom-script network note. */
  createNetworkNote: (
    options: CreateNetworkNoteOptions
  ) => Promise<NetworkNoteResult>;
  result: NetworkNoteResult | null;
  isLoading: boolean;
  stage: TransactionStage;
  error: Error | null;
  reset: () => void;
}

/**
 * Hook that builds a Public custom-script note carrying a `NetworkAccountTarget`
 * attachment and submits it as an own output note, so a public network account
 * auto-consumes it. Provide exactly one of `recipient` or `script`.
 */
export function useCreateNetworkNote(): UseCreateNetworkNoteResult {
  const { client, isReady, sync, runExclusive, prover } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [result, setResult] = useState<NetworkNoteResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stage, setStage] = useState<TransactionStage>("idle");
  const [error, setError] = useState<Error | null>(null);

  const createNetworkNote = useCallback(
    async (options: CreateNetworkNoteOptions): Promise<NetworkNoteResult> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }
      if (options.recipient && options.script) {
        throw new Error(
          "createNetworkNote requires exactly one of `recipient` or `script`, not both."
        );
      }
      if (!options.recipient && !options.script) {
        throw new Error(
          "createNetworkNote requires either `recipient` or `script`."
        );
      }

      setIsLoading(true);
      setStage("executing");
      setError(null);

      try {
        const built = await runExclusiveSafe(async () => {
          const senderId = parseAccountId(options.accountId);
          const targetId = parseAccountId(options.target);
          const target = new NetworkAccountTarget(
            targetId,
            options.executionHint
          );

          const noteAssets =
            options.assetId != null
              ? new NoteAssets([
                  new FungibleAsset(
                    parseAccountId(options.assetId),
                    BigInt(options.amount ?? 0)
                  ),
                ])
              : new NoteAssets();

          const metadata = new NoteMetadata(
            senderId,
            NoteType.Public,
            NoteTag.withAccountTarget(target.targetId())
          );

          const recipient =
            options.recipient ??
            NoteRecipient.fromScript(
              options.script!,
              new NoteStorage(
                new FeltArray(
                  (options.inputs ?? []).map((value) => new Felt(value))
                )
              )
            );

          const attachments = [target.toAttachment()];
          if (options.attachment) {
            attachments.push(createNoteAttachment(options.attachment));
          }

          const note = Note.withAttachments(
            noteAssets,
            metadata,
            recipient,
            attachments
          );

          const ownOutputs = new NoteArray();
          ownOutputs.push(note); // push keeps `note` valid to return
          const txRequest = new TransactionRequestBuilder()
            .withOwnOutputNotes(ownOutputs)
            .build();

          // Reuse `senderId` (NoteMetadata only borrows it) rather than
          // re-parsing the same account id for submission.
          const txId = prover
            ? await client.submitNewTransactionWithProver(
                senderId,
                txRequest,
                prover
              )
            : await client.submitNewTransaction(senderId, txRequest);

          return { txId: txId.toHex(), note } as NetworkNoteResult;
        });

        setStage("complete");
        setResult(built);
        await sync();
        return built;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setStage("idle");
        throw e;
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

  return { createNetworkNote, result, isLoading, stage, error, reset };
}
