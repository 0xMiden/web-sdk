export class ContractsResource {
  #getWasm;
  #client;

  constructor(getWasm, client) {
    this.#getWasm = getWasm;
    this.#client = client;
  }

  /**
   * Create a contract from compiled components, generating what the caller
   * leaves out: a random 32-byte `seed` and a Falcon `AuthSecretKey` (stored
   * with the account, like any `accounts.create` contract). Everything else,
   * including validation and the default `storage` ("public"), is
   * `accounts.create`'s.
   *
   * Resolves to `{ account, seed, auth }` with the values actually used.
   */
  async deploy(opts) {
    this.#client.assertNotTerminated();
    if (opts?.components === undefined) {
      // accounts.create reads a request without components as a wallet.
      throw new TypeError(
        "contracts.deploy() requires `components` (compile them with client.compile.component())."
      );
    }
    const wasm = await this.#getWasm();
    const seed = opts.seed ?? crypto.getRandomValues(new Uint8Array(32));
    const auth = opts.auth ?? wasm.AuthSecretKey.rpoFalconWithRNG();
    const create = { components: opts.components, seed, auth };
    if (opts.storage !== undefined) create.storage = opts.storage;
    const account = await this.#client.accounts.create(create);
    return { account, seed, auth };
  }
}
