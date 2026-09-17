import { useCallback, useEffect, useRef, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type { TransactionSummary, PreviewTransactionOptions } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";
import { MidenError } from "../utils/errors";
import type { CodedError } from "../utils/errors";
import {
  assertAnchorValueUsable,
  resolveTransactionRequest,
} from "../utils/transactions";

export interface UsePreviewResult {
  /** Derive the transaction summary awaiting authorization */
  preview: (options: PreviewTransactionOptions) => Promise<TransactionSummary>;
  /** The most recently derived summary */
  summary: TransactionSummary | null;
  /** Whether a preview is in progress */
  isPreviewing: boolean;
  /** Error if the preview failed. Carries `code` for the cases documented below. */
  error: CodedError | null;
  /** Clear the derived summary and error. Does not cancel a running preview. */
  reset: () => void;
}

/**
 * Hook to dry-run a transaction and obtain the {@link TransactionSummary} the
 * account is being asked to authorize, without submitting anything.
 *
 * The summary only exists while authorization is pending — it is produced when
 * the account's auth procedure aborts with the unauthorized event, e.g. a
 * multisig below its signing threshold. A transaction that is already fully
 * authorized produces no summary, and this rejects with an error whose `code`
 * is `"TRANSACTION_ALREADY_AUTHORIZED"`; use `useTransaction` to submit it.
 * That code comes from the client rather than this package, so on Node it
 * prefixes the message instead of appearing as a property.
 *
 * Also rejects with `code: "OPERATION_BUSY"` if a preview is already running,
 * and `code: "STALE_CLIENT"` if the client is swapped mid-call. Both originate
 * here and are always properties.
 *
 * The request is yours, so paying protocol 0.16's verification fee is too.
 * miden-client settles it in the chain's native fee asset at rate 1/1 and
 * commits that itself, so an ordinary account needs nothing; a multisig reuses
 * the fee conversion salt as its summary's replay guard, so miden-client will
 * not invent one and the request rejects with `FeeConversionInfoRequired`.
 * Build those from `client.feeAwareTransactionRequestBuilder(account)` rather
 * than `new TransactionRequestBuilder()`.
 *
 * Preview the request you will submit, not a rebuild of it. That salt is drawn
 * fresh on every build, and the multisig auth procedure uses the auth argument
 * derived from it as the summary's replay guard — so a summary taken over one
 * build does not authorize another.
 *
 * Runs the transaction in the VM on the main thread — unlike
 * `useTransaction().execute`, this is not offloaded to the worker (matching the
 * client's unanchored `executeForSummary`), so it blocks the UI for the
 * duration and queues other client calls behind it.
 *
 * A returned summary proves the request, anchor and summary agree; it does not
 * prove intent. Its commitment covers the account delta, the note commitments,
 * the reference block, the expiration delta and the user params — not the
 * transaction script or advice inputs. Note that `expirationDelta()` returns 0
 * to mean no expiration was set, not that it has already expired.
 *
 * Pass `anchor` to derive the summary at a pinned reference block. A co-signer
 * verifying a proposal must do this with the proposer's anchor: the summary
 * binds the reference block commitment, so deriving it at the local sync height
 * yields a different summary and the comparison always fails.
 *
 * @example
 * ```tsx
 * function VerifyProposal({ accountId, request, anchor, expected }: Props) {
 *   const { preview, isPreviewing } = usePreview();
 *
 *   const verify = async () => {
 *     const summary = await preview({ accountId, request, anchor });
 *     const matches =
 *       summary.toCommitment().toHex() === expected.toCommitment().toHex();
 *     if (matches) await sign(summary);
 *   };
 *
 *   return <button onClick={verify} disabled={isPreviewing}>Verify</button>;
 * }
 * ```
 */
export function usePreview(): UsePreviewResult {
  const { client, isReady, runExclusive } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;
  const isBusyRef = useRef(false);
  const clientRef = useRef(client);

  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [error, setError] = useState<CodedError | null>(null);

  const preview = useCallback(
    async (options: PreviewTransactionOptions): Promise<TransactionSummary> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      if (isBusyRef.current) {
        throw new MidenError(
          "A preview is already in progress. Await the previous preview before starting another.",
          { code: "OPERATION_BUSY" }
        );
      }

      assertAnchorValueUsable(options);

      isBusyRef.current = true;
      setIsPreviewing(true);
      setError(null);

      try {
        const txRequest = await resolveTransactionRequest(
          options.request,
          client
        );
        const derived = await runExclusiveSafe(() => {
          const accountIdObj = parseAccountId(options.accountId);
          return options.anchor
            ? client.executeForSummaryAt(
                accountIdObj,
                txRequest,
                options.anchor
              )
            : client.executeForSummary(accountIdObj, txRequest);
        });
        if (clientRef.current !== client) {
          throw new MidenError(
            "The client changed while the summary was being derived; re-derive it on the new chain.",
            { code: "STALE_CLIENT" }
          );
        }
        setSummary(derived);
        return derived;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Anything the client we left produced — including a plain failure —
        // is an artifact of that chain, so it belongs in the rejection but not
        // in the state the swap just cleared.
        if (clientRef.current === client) {
          setError(error);
        }
        throw error;
      } finally {
        setIsPreviewing(false);
        isBusyRef.current = false;
      }
    },
    [client, isReady, runExclusiveSafe]
  );

  // Deliberately leaves `isPreviewing` alone: reset clears results, it does not
  // cancel a running preview. Forcing the flag to false would re-enable a
  // button that the busy guard still rejects.
  const reset = useCallback(() => {
    setSummary(null);
    setError(null);
  }, []);

  // A summary binds the reference block commitment, so it is no more portable
  // across chains than the anchor it was derived at. Mirrors `useChainAnchor`.
  useEffect(() => {
    clientRef.current = client;
    setSummary(null);
    setError(null);
  }, [client]);

  return {
    preview,
    summary,
    isPreviewing,
    error,
    reset,
  };
}
