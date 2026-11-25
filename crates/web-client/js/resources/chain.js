export class ChainResource {
  constructor() {}
  async getBlockHeader() {
    throw new Error("not implemented");
  }
  async getBlockHeaderWithProof() {
    throw new Error("not implemented");
  }
  async getNullifierCommitHeights() {
    throw new Error("not implemented");
  }
  async syncNullifiers() {
    throw new Error("not implemented");
  }
}
