import { resolveAccountRef } from "../utils.js";

/**
 * Coerce an `orderId` (string | bigint) to a decimal string for the WASM
 * `u64` parse on the other side.
 *
 * A PSWAP `orderId` is `u64`-shaped and routinely exceeds
 * `Number.MAX_SAFE_INTEGER` (`2^53 - 1`). JS `number` cannot represent the
 * full u64 range without silent precision loss, so it is not accepted — pass
 * `orderId` as a `bigint` or `string` instead.
 *
 * @param {string | bigint} orderId
 * @returns {string}
 */
function normalizeOrderId(orderId) {
  if (typeof orderId === "bigint") return orderId.toString();
  if (typeof orderId === "string") return orderId;
  throw new TypeError(
    `PSWAP orderId must be a string or bigint; got ${typeof orderId}`
  );
}

/**
 * PswapResource surfaces partial-swap (PSWAP) lineage tracking and creator-side
 * cancellation keyed by a lineage's stable order id.
 *
 * A PSWAP note can be filled by many consumers; each fill advances the lineage
 * to a new remainder note. The client persists that chain locally as it syncs,
 * and the reader methods here expose it. {@link PswapResource#cancelByOrder}
 * reclaims the unfilled offered asset on the current tip of an active lineage,
 * resolving the creator account from the tracked record so the caller only
 * needs the order id.
 */
export class PswapResource {
  #inner;
  #getWasm;
  #client;

  constructor(inner, getWasm, client) {
    this.#inner = inner;
    this.#getWasm = getWasm;
    this.#client = client;
  }

  /**
   * Returns every PSWAP lineage tracked by this client.
   *
   * @returns {Promise<PswapLineageRecord[]>} All tracked lineages.
   */
  async lineages() {
    this.#client.assertNotTerminated();
    return await this.#inner.getPswapLineages();
  }

  /**
   * Returns lineages created by a specific local account.
   *
   * @param {AccountRef} account - Creator account (hex, bech32, Account, or AccountId).
   * @returns {Promise<PswapLineageRecord[]>} Lineages created by the account.
   */
  async lineagesFor(account) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(account, wasm);
    return await this.#inner.getPswapLineagesFor(accountId);
  }

  /**
   * Returns the lineage for one order, or null if not tracked.
   *
   * @param {string | bigint} orderId - Stable order id. Pass as a `string` or
   *   `bigint` for the full `u64` range; `number` is rejected because it cannot
   *   represent ids above `Number.MAX_SAFE_INTEGER` without precision loss.
   * @returns {Promise<PswapLineageRecord | null>} The lineage, or null.
   */
  async lineage(orderId) {
    this.#client.assertNotTerminated();
    const result = await this.#inner.getPswapLineage(normalizeOrderId(orderId));
    return result ?? null;
  }

  /**
   * Builds and submits a transaction reclaiming the unfilled offered asset on
   * the current tip of an Active lineage. The creator account is resolved from
   * the tracked lineage, so only the order id is required. Runs through the
   * same execute/prove/submit path as the other transaction helpers.
   *
   * Throws before submitting any transaction when:
   *   - no lineage is tracked for `orderId`, OR
   *   - the lineage is in a terminal state (`FullyFilled` or `Reclaimed`,
   *     guarded by the `buildPswapCancelByOrder` binding).
   *
   * Concurrency: the lineage-read, build, and submit steps below are not
   * atomic against external fills. If another consumer — or this client's own
   * in-flight tx — advances the lineage tip between the build and submit, the
   * cancel will target an already-consumed note and the kernel will reject
   * it with a "note already nullified" error. Treat that as a signal to
   * re-read the lineage and retry against the new tip.
   *
   * Fees: this is the one request-building path that cannot pay a verification
   * fee. `buildPswapCancelByOrder` delegates request building to miden-client,
   * which builds from a bare `TransactionRequestBuilder`, and a finished
   * `TransactionRequest` cannot be amended — so there is no seam at which to
   * attach fee conversion info. On a fee-charging chain this aborts with
   * `ERR_FEE_CONVERSION_INFO_MISSING`; cancel by note with
   * `client.transactions.pswapCancel` instead.
   *
   * @param {PswapCancelByOrderOptions} opts - Order id and optional tx options.
   * @returns {Promise<TransactionSubmitResult>} The submitted transaction.
   */
  async cancelByOrder(opts) {
    this.#client.assertNotTerminated();
    const orderId = normalizeOrderId(opts.orderId);

    // Fetch the lineage for the creator account (the cancel's submitter).
    // The terminal-state guard is authoritative in the `buildPswapCancelByOrder`
    // binding below, so it is not repeated here.
    const lineage = await this.#inner.getPswapLineage(orderId);
    if (!lineage) {
      throw new Error(`No PSWAP lineage tracked for order ${orderId}`);
    }
    const accountId = lineage.creatorAccountId();

    const request = await this.#inner.buildPswapCancelByOrder(orderId);

    const { txId, result } = await this.#client.transactions.submit(
      accountId,
      request,
      { prover: opts.prover }
    );

    if (opts.waitForConfirmation) {
      await this.#client.transactions.waitFor(txId.toHex(), {
        timeout: opts.timeout,
      });
    }

    return { txId, result };
  }
}
