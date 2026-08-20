import { useCallback, useEffect, useRef, useState } from "react";
import { useMiden } from "../context/MidenProvider";
import type {
  ChainAnchor,
  CaptureAnchorOptions,
  TransactionRequest,
} from "../types";
import { runExclusiveDirect } from "../utils/runExclusive";
import { MidenError } from "../utils/errors";
import type { CodedError } from "../utils/errors";
import { resolveTransactionRequest } from "../utils/transactions";

export interface UseChainAnchorResult {
  /** Capture an anchor at the current sync height for the given request */
  captureAnchor: (options: CaptureAnchorOptions) => Promise<ChainAnchor>;
  /** The most recently captured anchor */
  anchor: ChainAnchor | null;
  /**
   * The exact request `anchor` was captured for.
   *
   * Pass this to `preview` and `execute` rather than re-resolving the input.
   * When `request` is a factory, calling it again yields a different object,
   * and builders that draw on the client's RNG — anything creating an output
   * note — produce a materially different transaction. The anchor would then
   * pin a request nobody executes, and the summary a co-signer verified would
   * not match the one submitted.
   */
  anchoredRequest: TransactionRequest | null;
  /** Whether a capture is in progress */
  isCapturing: boolean;
  /** Error if capture failed. Carries `code` for the cases documented below. */
  error: CodedError | null;
  /**
   * Clear the captured anchor, its request, and the error. Does not cancel a
   * running capture.
   */
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
 * and ships both, so the summary reproduces on a client at a different sync height, provided both
 * parties agree on the account state.
 *
 * The anchor tracks the creation blocks of the request's authenticated input
 * notes, so it stays valid for that request once the chain advances. Serialize
 * it with `anchor.serialize()` to send it to co-signers, and rebuild it with
 * `ChainAnchor.deserialize(bytes)` — importing the class itself from
 * `@miden-sdk/miden-sdk`, since this package re-exports it as a type only.
 *
 * The caller owns the returned anchor. `anchor` in state is the same object,
 * so neither `reset()` nor a client swap frees it — doing so would invalidate
 * a handle the caller may still hold. An anchor carries a partial blockchain,
 * so call `anchor.free()` once done with it rather than waiting for the
 * finalizer, in a flow that captures repeatedly.
 *
 * Runs on the main thread: capturing walks the chain in WASM without the
 * worker, so it blocks the UI briefly and queues other client calls behind it.
 *
 * Rejects with `code: "OPERATION_BUSY"` if a capture is already running, and
 * with `code: "INVALID_CHAIN_ANCHOR"` if a sync lands mid-capture and leaves
 * the anchor internally inconsistent — retry that one.
 *
 * `INVALID_CHAIN_ANCHOR` comes from the client rather than this package, so on
 * Node it prefixes the message (`"INVALID_CHAIN_ANCHOR: ..."`) instead of
 * appearing as a property; the napi bindings cannot attach one. `OPERATION_BUSY`
 * originates here and is always a property.
 *
 * Preview and execute against the returned `anchoredRequest`, not the value you
 * passed in. If `request` is a factory it resolves to a new object per call,
 * and any builder that mints an output note draws a fresh serial number from
 * the client's RNG — so a second call yields a transaction the anchor does not
 * pin and the co-signers did not approve.
 *
 * @example
 * ```tsx
 * function ProposeButton({ accountId, buildRequest }: Props) {
 *   const { captureAnchor, anchoredRequest, isCapturing } = useChainAnchor();
 *   const { preview } = usePreview();
 *
 *   const propose = async () => {
 *     const anchor = await captureAnchor({ request: buildRequest });
 *     // anchoredRequest, not buildRequest: the anchor pins this exact object.
 *     const summary = await preview({
 *       accountId,
 *       request: anchoredRequest!,
 *       anchor,
 *     });
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
  const [anchoredRequest, setAnchoredRequest] =
    useState<TransactionRequest | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<CodedError | null>(null);

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
        // Publish the resolved request, not `options.request`: a factory
        // resolves to a new object each call, and only this one is pinned.
        setAnchoredRequest(txRequest);
        return captured;
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
        setIsCapturing(false);
        isBusyRef.current = false;
      }
    },
    [client, isReady, runExclusiveSafe]
  );

  // Deliberately leaves `isCapturing` alone: reset clears results, it does not
  // cancel a running capture. Forcing the flag to false would re-enable a
  // button that the busy guard still rejects.
  const reset = useCallback(() => {
    setAnchor(null);
    setAnchoredRequest(null);
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
    setAnchoredRequest(null);
    setError(null);
  }, [client]);

  return {
    captureAnchor,
    anchor,
    anchoredRequest,
    isCapturing,
    error,
    reset,
  };
}
