import { useCallback, useEffect, useRef, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type { ChainAnchor, CaptureAnchorOptions } from "../types";
import { runExclusiveDirect } from "../utils/runExclusive";
import { MidenError } from "../utils/errors";
import { resolveTransactionRequest } from "../utils/transactions";

export interface UseChainAnchorResult {
  /** Capture an anchor at the current sync height for the given request */
  captureAnchor: (options: CaptureAnchorOptions) => Promise<ChainAnchor>;
  /** The most recently captured anchor */
  anchor: ChainAnchor | null;
  /** Whether a capture is in progress */
  isCapturing: boolean;
  /** Error if capture failed */
  error: Error | null;
  /** Reset the hook state */
  reset: () => void;
}

/**
 * Hook to capture a {@link ChainAnchor} — a pinned reference block that a later
 * execution can replay against.
 *
 * Since protocol 0.16 a signed transaction summary binds the reference block
 * commitment, so signatures collected over a summary only authorize an
 * execution at that exact block. Any flow that collects signatures and executes
 * later — multisig, offline co-signing — captures an anchor next to the summary
 * and ships both, so the summary reproduces on a client at any sync height.
 *
 * The anchor tracks the creation blocks of the request's authenticated input
 * notes, so it stays valid for that request once the chain advances. Serialize
 * it with `anchor.serialize()` to send it to co-signers, and rebuild it with
 * `ChainAnchor.deserialize(bytes)`.
 *
 * @example
 * ```tsx
 * function ProposeButton({ accountId, request }: Props) {
 *   const { captureAnchor, isCapturing } = useChainAnchor();
 *   const { preview } = usePreview();
 *
 *   const propose = async () => {
 *     const anchor = await captureAnchor({ request });
 *     const summary = await preview({ accountId, request, anchor });
 *     await shipToCosigners(anchor.serialize(), summary.serialize());
 *   };
 *
 *   return <button onClick={propose} disabled={isCapturing}>Propose</button>;
 * }
 * ```
 */
export function useChainAnchor(): UseChainAnchorResult {
  const { client, isReady, runExclusive } = useMiden();
  const runExclusiveSafe = runExclusive ?? runExclusiveDirect;
  const isBusyRef = useRef(false);
  const clientRef = useRef(client);

  const [anchor, setAnchor] = useState<ChainAnchor | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const captureAnchor = useCallback(
    async (options: CaptureAnchorOptions): Promise<ChainAnchor> => {
      if (!client || !isReady) {
        throw new Error("Miden client is not ready");
      }

      if (isBusyRef.current) {
        throw new MidenError(
          "An anchor capture is already in progress. Await the previous capture before starting another.",
          { code: "OPERATION_BUSY" }
        );
      }

      isBusyRef.current = true;
      setIsCapturing(true);
      setError(null);

      try {
        const txRequest = await resolveTransactionRequest(
          options.request,
          client
        );
        const captured = await runExclusiveSafe(() =>
          client.chainAnchorForRequest(txRequest)
        );
        if (clientRef.current !== client) {
          throw new MidenError(
            "The client changed while the anchor was being captured; recapture it on the new chain.",
            { code: "STALE_CLIENT" }
          );
        }
        setAnchor(captured);
        return captured;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsCapturing(false);
        isBusyRef.current = false;
      }
    },
    [client, isReady, runExclusiveSafe]
  );

  const reset = useCallback(() => {
    setAnchor(null);
    setIsCapturing(false);
    setError(null);
  }, []);

  // An anchor is bound to one chain. Carrying it across a client swap would
  // replay against a header from the wrong network and fail somewhere deep in
  // the executor, rather than pointing at the stale capture. `clientRef` also
  // lets an in-flight capture notice the swap: it would otherwise resolve after
  // this effect and publish an anchor for the chain we just left.
  useEffect(() => {
    clientRef.current = client;
    setAnchor(null);
    setError(null);
  }, [client]);

  return {
    captureAnchor,
    anchor,
    isCapturing,
    error,
    reset,
  };
}
