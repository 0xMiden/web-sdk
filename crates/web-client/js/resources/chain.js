export class ChainResource {
  #getWasm;
  #client;
  #withRpc;

  constructor(getWasm, client, withRpc) {
    this.#getWasm = getWasm;
    this.#client = client;
    this.#withRpc = withRpc;
  }

  async getBlockHeader(blockNum) {
    this.#client.assertNotTerminated();
    return await this.#withRpc((rpc) =>
      rpc.getBlockHeaderByNumber(blockNum, false)
    );
  }

  async getBlockHeaderWithProof(blockNum) {
    this.#client.assertNotTerminated();
    const result = await this.#withRpc((rpc) =>
      rpc.getBlockHeaderWithProof(blockNum)
    );
    return { header: result.header(), mmrProof: result.mmrProof() };
  }

  async getNullifierCommitHeights(nullifiers, { blockFrom = 0 } = {}) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const hexes = nullifiers.map((n) =>
      typeof n === "string" ? n : n.toHex()
    );
    // The binding consumes its Word arguments in the browser build, so build fresh ones.
    const words = hexes.map((hex) => wasm.Word.fromHex(hex));
    const updates = await this.#withRpc((rpc) =>
      rpc.getNullifierCommitHeights(words, blockFrom)
    );
    const found = new Map(
      updates.map((u) => [u.nullifier().toHex(), u.blockNum()])
    );
    return new Map(hexes.map((hex) => [hex, found.get(hex) ?? null]));
  }

  async syncNullifiers(prefixes, blockFrom, blockTo) {
    this.#client.assertNotTerminated();
    return await this.#withRpc((rpc) =>
      rpc.syncNullifiers(Uint16Array.from(prefixes), blockFrom, blockTo)
    );
  }
}
