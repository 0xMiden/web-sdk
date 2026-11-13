import { useCallback, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import { runExclusiveDirect } from "../utils/runExclusive";
import { PrivateNoteDeliveryError } from "../utils/errors";
import type { PrivateNoteResendRequest } from "../utils/errors";
import { deliverPrivateNotes } from "../utils/privateNoteDelivery";

export interface UseResendPrivateNotesResult {
  /**
   * Relay private notes again. Resolves once every note is delivered; rejects
   * with a `PrivateNoteDeliveryError` naming the ones that still failed.
   */
  resend: (request: PrivateNoteResendRequest) => Promise<void>;
  /** Whether a resend is in progress */
  isLoading: boolean;
  /** Error from the last resend, cleared when one succeeds */
  error: Error | null;
}

/**
 * Hook to relay private notes a transaction hook could not deliver.
 *
 * `useSend`, `useMultiSend` and `useTransaction` reject with a
 * `PrivateNoteDeliveryError` when a private note is not delivered after its
 * transaction was submitted. The SDK keeps no queue and never re-sends a note
 * on its own, so pass the error's `transactionId` and `undelivered` notes here.
 * Each call syncs once, so a note whose transaction has committed since has the
 * inclusion proof the relay needs, then attempts every note through the
 * provider's `runExclusive` lock. One sync does not guarantee the transaction
 * has committed: a note that still fails comes back in the error, with
 * `commitment: "unknown"`. Delivery is idempotent by note id, so repeating a
 * resend is safe.
 *
 * Notes from a transaction this client could not apply are not in its store
 * and cannot be resent from here.
 *
 * @example
 * ```tsx
 * const { send } = useSend();
 * const { resend } = useResendPrivateNotes();
 *
 * try {
 *   await send({ from, to, assetId, amount: 100n, noteType: "private" });
 * } catch (err) {
 *   if (err instanceof PrivateNoteDeliveryError) {
 *     await resend({
 *       transactionId: err.transactionId,
 *       notes: err.undelivered,
 *     });
 *   }
 * }
 * ```
 */
export function useResendPrivateNotes(): UseResendPrivateNotesResult {
  const { client, isReady, runExclusive } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const resend = useCallback(
    async (request: PrivateNoteResendRequest): Promise<void> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      setIsLoading(true);
      setError(null);

      try {
        await runExclusiveSafe(() => client.syncState());
        const { delivered, undelivered, firstError } =
          await deliverPrivateNotes(client, runExclusiveSafe, request.notes);
        if (undelivered.length > 0) {
          throw new PrivateNoteDeliveryError({
            transactionId: request.transactionId,
            commitment: "unknown",
            delivered,
            undelivered,
            cause: firstError,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isReady, runExclusive]
  );

  return { resend, isLoading, error };
}
