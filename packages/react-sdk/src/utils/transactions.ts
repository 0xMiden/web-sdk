import type {
  TransactionRequest,
  WasmWebClient as WebClient,
} from "@miden-sdk/miden-sdk";

/** A request, or a factory that builds one from the client. */
export type TransactionRequestInput =
  | TransactionRequest
  | ((client: WebClient) => TransactionRequest | Promise<TransactionRequest>);

/** Resolves the factory form of a transaction request to a concrete request. */
export async function resolveTransactionRequest(
  request: TransactionRequestInput,
  client: WebClient
): Promise<TransactionRequest> {
  const resolved =
    typeof request === "function" ? await request(client) : request;
  // Passing a nullish request into wasm surfaces as "null pointer passed to
  // rust", which reads like a consumed handle and sends the reader hunting in
  // the wrong place.
  if (resolved == null) {
    throw new Error(
      typeof request === "function"
        ? "the transaction request factory returned null or undefined"
        : "a transaction request is required"
    );
  }
  return resolved;
}

/**
 * Reject an `anchor` that is present but falsy — except `undefined`, which is
 * how an optional property spells "absent".
 *
 * Anchored branches are selected by truthiness, so `{ anchor: null }` would
 * otherwise execute at the current tip: the one outcome anchoring exists to
 * prevent. It is easy to hit, because `useChainAnchor().anchor` is `null` until
 * the capture resolves, and `cond && anchor` yields `false`.
 */
export function assertAnchorValueUsable(options: { anchor?: unknown }): void {
  const { anchor } = options;
  if (anchor === undefined || anchor) return;
  // String() rather than JSON.stringify: the latter throws on a BigInt and
  // renders NaN as "null", and this is an error path that must not itself fail.
  throw new Error(
    `anchor was ${String(anchor)}; await captureAnchor(request) before ` +
      "passing it, or omit the option entirely to execute at the current tip"
  );
}
