import { useCallback, useRef, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type { TransactionSummary, PreviewTransactionOptions } from "../types";
import { parseAccountId } from "../utils/accountParsing";
import { runExclusiveDirect } from "../utils/runExclusive";
import { MidenError } from "../utils/errors";
import { resolveTransactionRequest } from "../utils/transactions";

export interface UsePreviewResult {
  /** Derive the transaction summary awaiting authorization */
  preview: (options: PreviewTransactionOptions) => Promise<TransactionSummary>;
  /** The most recently derived summary */
  summary: TransactionSummary | null;
  /** Whether a preview is in progress */
  isPreviewing: boolean;
  /** Error if the preview failed */
  error: Error | null;
  /** Reset the hook state */
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

  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

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
        setSummary(derived);
        return derived;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsPreviewing(false);
        isBusyRef.current = false;
      }
    },
    [client, isReady, runExclusiveSafe]
  );

  const reset = useCallback(() => {
    setSummary(null);
    setIsPreviewing(false);
    setError(null);
  }, []);

  return {
    preview,
    summary,
    isPreviewing,
    error,
    reset,
  };
}
