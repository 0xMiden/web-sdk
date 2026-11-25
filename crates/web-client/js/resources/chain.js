// Frees a wasm handle unless the call it was passed to already consumed it.
function freeLive(handle) {
  if (typeof handle?.free !== "function") return;
  if ("__wbg_ptr" in handle && handle.__wbg_ptr === 0) return;
  try {
    handle.free();
  } catch {
    // Cleanup must never mask the read's own outcome.
  }
}

const MAX_PREFIX = 0xffff;

export class ChainResource {
  #getWasm;
  #client;
  #withRpc;

  constructor(getWasm, client, withRpc) {
    this.#getWasm = getWasm;
    this.#client = client;
    this.#withRpc = withRpc;
  }

  /**
   * Fetches a block header.
   *
   * @param {number} [blockNum] - The block to fetch; the latest when omitted.
   * @returns {Promise<BlockHeader>} The header, without an MMR proof.
   */
  async getBlockHeader(blockNum) {
    this.#client.assertNotTerminated();
    return await this.#withRpc((rpc) =>
      rpc.getBlockHeaderByNumber(blockNum, false)
    );
  }

  /**
   * Fetches a block header with the MMR proof of its commitment.
   *
   * @param {number} blockNum - The block to fetch.
   * @returns {Promise<{ header: BlockHeader, mmrProof: MmrProof }>} Copies the
   *   caller owns; the node's response wrapper is freed here.
   */
  async getBlockHeaderWithProof(blockNum) {
    this.#client.assertNotTerminated();
    const result = await this.#withRpc((rpc) =>
      rpc.getBlockHeaderWithProof(blockNum)
    );
    try {
      return { header: result.header(), mmrProof: result.mmrProof() };
    } finally {
      freeLive(result);
    }
  }

  /**
   * Looks up the block that consumed each nullifier, from `blockFrom` to the
   * chain tip, by full nullifier.
   *
   * @param {Array<Word | string>} nullifiers - Words (read, never consumed) or
   *   0x-prefixed hex strings of any case; a malformed string throws.
   * @param {{ blockFrom?: number }} [options] - `blockFrom` defaults to 0.
   * @returns {Promise<Map<string, number | null>>} Keyed by each nullifier as
   *   the caller passed it (a Word by its `toHex()`); `null` when not consumed
   *   in the range.
   */
  async getNullifierCommitHeights(nullifiers, { blockFrom = 0 } = {}) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const keys = nullifiers.map((n) => (typeof n === "string" ? n : n.toHex()));
    // The binding consumes its Word arguments in the browser build, so hand it
    // fresh ones and free whichever it left alive.
    const words = [];
    try {
      for (const key of keys) words.push(wasm.Word.fromHex(key));
      const canonical = words.map((word) => word.toHex());
      const updates = await this.#withRpc((rpc) =>
        rpc.getNullifierCommitHeights(words, blockFrom)
      );
      const found = new Map();
      try {
        for (const update of updates) {
          const nullifier = update.nullifier();
          try {
            found.set(nullifier.toHex(), update.blockNum());
          } finally {
            freeLive(nullifier);
          }
        }
      } finally {
        for (const update of updates) freeLive(update);
      }
      return new Map(
        keys.map((key, i) => [key, found.get(canonical[i]) ?? null])
      );
    } finally {
      for (const word of words) freeLive(word);
    }
  }

  /**
   * Fetches consumed nullifiers matching 16-bit prefixes in an inclusive
   * block range. Prefixes can match unrelated notes: compare the full
   * nullifier of each returned update.
   *
   * @param {ArrayLike<number>} prefixes - Integers from 0 to 65535, else a
   *   `RangeError` before any request.
   * @param {number} blockFrom - First block, inclusive.
   * @param {number} blockTo - Last block, inclusive; at or below the tip.
   * @returns {Promise<NullifierUpdate[]>}
   */
  async syncNullifiers(prefixes, blockFrom, blockTo) {
    this.#client.assertNotTerminated();
    const checked = new Uint16Array(prefixes.length);
    for (let i = 0; i < prefixes.length; i++) {
      const value = prefixes[i];
      if (!Number.isInteger(value) || value < 0 || value > MAX_PREFIX) {
        throw new RangeError(
          `syncNullifiers: prefix ${String(value)} is not an integer in 0..${MAX_PREFIX}`
        );
      }
      checked[i] = value;
    }
    return await this.#withRpc((rpc) =>
      rpc.syncNullifiers(checked, blockFrom, blockTo)
    );
  }
}
