import {
  resolveAccountRef,
  resolveStorageMode,
  resolveAuthScheme,
  hashSeed,
} from "../utils.js";

export class AccountsResource {
  #inner;
  #getWasm;
  #client;

  constructor(inner, getWasm, client) {
    this.#inner = inner;
    this.#getWasm = getWasm;
    this.#client = client;
  }

  async create(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    const type = opts?.type;

    if (
      type === 0 ||
      type === 1 ||
      type === "FungibleFaucet" ||
      type === "NonFungibleFaucet"
    ) {
      const storageMode = resolveStorageMode(opts.storage ?? "public", wasm);
      const authScheme = resolveAuthScheme(opts.auth, wasm);
      return await this.#inner.newFaucet(
        storageMode,
        type === 1 || type === "NonFungibleFaucet",
        opts.name ?? opts.symbol,
        opts.symbol,
        opts.decimals,
        BigInt(opts.maxSupply),
        authScheme
      );
    } else if (
      type === "ImmutableContract" ||
      type === "MutableContract" ||
      opts?.components // Contracts are distinguished from wallets by having components
    ) {
      return await this.#createContract(opts, wasm);
    } else {
      // Default: wallet
      const storageMode = resolveStorageMode(opts?.storage ?? "private", wasm);
      const authScheme = resolveAuthScheme(opts?.auth, wasm);
      const seed = opts?.seed ? await hashSeed(opts.seed) : undefined;
      return await this.#inner.newWallet(storageMode, authScheme, seed);
    }
  }

  async #createContract(opts, wasm) {
    if (!opts.seed)
      throw new Error("Contract creation requires a 'seed' (Uint8Array)");
    if (!opts.auth)
      throw new Error("Contract creation requires an 'auth' (AuthSecretKey)");

    const storageMode = resolveStorageMode(opts.storage ?? "public", wasm);
    const authComponent =
      wasm.AccountComponent.createAuthComponentFromSecretKey(opts.auth);

    // Schema commitment from `build()` is not a substitute for contract code; require explicit
    // `components` so auth-only contracts are rejected at this layer.
    const components = opts.components ?? [];
    if (components.length === 0) {
      throw new Error(
        "Contract accounts require at least one non-auth procedure: pass at least one entry in `components`."
      );
    }

    let builder = new wasm.AccountBuilder(opts.seed)
      .storageMode(storageMode)
      .withAuthComponent(authComponent);

    for (const component of components) {
      builder = builder.withComponent(component);
    }

    const built = builder.build();
    const account = built.account;

    await this.#inner.newAccountWithSecretKey(account, opts.auth);
    return account;
  }

  async insert({ account, overwrite = false }) {
    this.#client.assertNotTerminated();
    await this.#inner.newAccount(account, overwrite);
  }

  async getOrImport(ref) {
    this.#client.assertNotTerminated();
    return (await this.get(ref)) ?? (await this.import(ref));
  }

  async get(ref) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    const account = await this.#inner.getAccount(id);
    return account ?? null;
  }

  async list() {
    this.#client.assertNotTerminated();
    return await this.#inner.getAccounts();
  }

  async getDetails(ref) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    const account = await this.#inner.getAccount(id);
    if (!account) {
      throw new Error(`Account not found: ${id.toString()}`);
    }
    const keys = this.#inner.keystore
      ? await this.#inner.keystore.getCommitments(id)
      : await this.#inner.getPublicKeyCommitmentsOfAccount(id);
    return {
      account,
      vault: account.vault(),
      storage: account.storage(),
      code: account.code() ?? null,
      keys,
    };
  }

  async getBalance(accountRef, tokenRef) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(accountRef, wasm);
    const faucetId = resolveAccountRef(tokenRef, wasm);
    const reader = await this.#inner.accountReader(accountId);
    return await reader.getBalance(faucetId);
  }

  async import(input) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    // Early exit for string, Account, and AccountHeader types before property
    // checks, preventing misrouting if a WASM object ever gains a .file or .seed
    // property. Bare AccountId (no .id() method) falls through to the fallback.
    if (typeof input === "string" || typeof input.id === "function") {
      const id = resolveAccountRef(input, wasm);
      await this.#inner.importAccountById(id);
      return await this.#inner.getAccount(id);
    }

    if (input.file) {
      // Extract accountId before importAccountFile — WASM consumes the
      // AccountFile by value, invalidating the JS wrapper after the call.
      const accountId =
        typeof input.file.accountId === "function"
          ? input.file.accountId()
          : null;
      await this.#inner.importAccountFile(input.file);
      if (accountId) {
        return await this.#inner.getAccount(accountId);
      }
      throw new Error(
        "Could not determine account ID from AccountFile. " +
          "Ensure the file contains a valid account."
      );
    }

    if (input.seed) {
      // Import public account from seed
      const authScheme = resolveAuthScheme(input.auth, wasm);
      return await this.#inner.importPublicAccountFromSeed(
        input.seed,
        authScheme
      );
    }

    // Fallback: treat as AccountRef (string, AccountId, Account, AccountHeader)
    const id = resolveAccountRef(input, wasm);
    await this.#inner.importAccountById(id);
    return await this.#inner.getAccount(id);
  }

  async export(ref) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    return await this.#inner.exportAccountFile(id);
  }

  async addAddress(ref, addr) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    const address = wasm.Address.fromBech32(addr);
    await this.#inner.insertAccountAddress(id, address);
  }

  async removeAddress(ref, addr) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    const address = wasm.Address.fromBech32(addr);
    await this.#inner.removeAccountAddress(id, address);
  }

  /**
   * Binds an invitation code to a tracked account on the network allowlist,
   * so the account's first transaction can create it on chain.
   *
   * The account must be tracked, not yet deployed, and not a network account.
   * A registration consumes the code, so the node is asked first: an account
   * it already allows fails with `ACCOUNT_ALREADY_ALLOWED` and the code is
   * kept. The node's own rejections carry `INVITATION_NOT_FOUND`,
   * `ALREADY_REGISTERED` or `INVALID_REGISTRATION_REQUEST`. When the network
   * funds registered accounts, the call returns once the funding note is
   * committed, which can take a few blocks; the note arrives on the next sync.
   *
   * @param {RegisterAccountOptions} options
   * @returns {Promise<void>}
   */
  async register({ account, invitationCode }) {
    this.#client.assertNotTerminated();
    if (typeof invitationCode !== "string" || invitationCode.length === 0) {
      throw new Error(
        "accounts.register requires a non-empty 'invitationCode' string"
      );
    }
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(account, wasm);
    await this.#inner.registerAccount(id, invitationCode);
  }

  /**
   * Returns whether the network lets the account be created on chain: `true`
   * when the node does not enforce an account allowlist, or when the account
   * is registered.
   *
   * @param {AccountRef} ref
   * @returns {Promise<boolean>}
   */
  async isAllowed(ref) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    return await this.#inner.isAccountAllowed(id);
  }
}
