import {
  resolveAccountRef,
  resolveStorageMode,
  resolveAuthScheme,
  hashSeed,
  toAmount,
} from "../utils.js";
import {
  classifyInputNoteState,
  defaultFaucetUrl,
  networkFromEndpoint,
  normalizeFundingOptions,
  requestNoteFromFaucet,
  sleep,
  withinTimeout,
  wrapAfterRequest,
  fundingInvalid,
} from "../funding.js";

// Legacy numeric 0/1 and "NonFungibleFaucet" are still accepted; non-fungible
// requests reach the Rust rejection.
const FAUCET_TYPES = new Set(["FungibleFaucet", "NonFungibleFaucet", 0, 1]);
const CONTRACT_TYPES = new Set(["ImmutableContract", "MutableContract"]);
const FAUCET_FIELDS = ["name", "symbol", "decimals", "maxSupply"];
const REQUIRED_FAUCET_FIELDS = ["symbol", "decimals", "maxSupply"];

function display(value) {
  try {
    return String(value);
  } catch {
    return typeof value;
  }
}

function selectorError(problem) {
  return new TypeError(
    `accounts.create(): ${problem} Pass type: FaucetType.FungibleFaucet for a faucet, omit type for a wallet, or pass components for a contract.`
  );
}

export class AccountsResource {
  #inner;
  #getWasm;
  #client;

  constructor(inner, getWasm, client) {
    this.#inner = inner;
    this.#getWasm = getWasm;
    this.#client = client;
  }

  /**
   * Create a wallet by default, a faucet via `FaucetType`, or a contract via
   * `components`. A contract also needs a raw 32-byte `seed` and `auth`.
   * `auth` is an `AuthSecretKey` stored with the account, or `"none"` for a
   * NoAuth contract that anyone can call and that stores no key. Omitting
   * `auth` is rejected and does not default to NoAuth. `"none"` is only valid
   * on a contract; wallet and faucet `auth` stays `AuthScheme.Falcon` or
   * `AuthScheme.ECDSA`. Visibility is selected separately with `storage`.
   *
   * The legacy 0, 1 and "NonFungibleFaucet" still select a faucet; 0 and 1 are
   * also AccountType.Private/Public, so a visibility value passed as `type` is
   * read as a faucet selector. Throws a TypeError naming `FaucetType`, before
   * creating anything, for an unrecognised `type`, for faucet fields (`name`,
   * `symbol`, `decimals`, `maxSupply`) without a faucet type, for `components`
   * on a faucet, and for a faucet missing `symbol`, `decimals` or `maxSupply`.
   */
  async create(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    const type = opts?.type;

    if (FAUCET_TYPES.has(type)) {
      if (opts.components !== undefined) {
        throw selectorError("a faucet request cannot carry components.");
      }
      const missing = REQUIRED_FAUCET_FIELDS.filter(
        (field) => opts[field] === undefined
      );
      if (missing.length > 0) {
        throw selectorError(`a faucet request needs ${missing.join(", ")}.`);
      }
      const storageMode = resolveStorageMode(opts.storage ?? "public", wasm);
      const authScheme = resolveAuthScheme(opts.auth, wasm);
      return await this.#inner.newFaucet(
        storageMode,
        type === 1 || type === "NonFungibleFaucet",
        opts.name ?? opts.symbol,
        opts.symbol,
        opts.decimals,
        toAmount(opts.maxSupply, "create maxSupply"),
        authScheme
      );
    }

    if (type !== undefined && !CONTRACT_TYPES.has(type)) {
      throw selectorError(`unrecognised type ${display(type)}.`);
    }
    // A stale AccountType.FungibleFaucet reads as undefined, so faucet fields
    // are how a missed FaucetType migration shows up.
    const faucetFields = FAUCET_FIELDS.filter(
      (field) => opts?.[field] !== undefined
    );
    if (faucetFields.length > 0) {
      throw selectorError(
        `${faucetFields.join(", ")} only apply to faucets, and no faucet type was given.`
      );
    }

    if (
      CONTRACT_TYPES.has(type) ||
      // Contracts are distinguished from wallets by having components; any
      // value other than undefined asks for a contract, so null fails loudly.
      opts?.components !== undefined
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
      throw new Error(
        "Contract creation requires an 'auth' (AuthSecretKey, or \"none\" for a NoAuth contract)"
      );

    const noAuth = opts.auth === "none";
    const storageMode = resolveStorageMode(opts.storage ?? "public", wasm);

    // Schema commitment from `build()` is not a substitute for contract code: a contract needs at
    // least one component exporting a non-auth procedure, or the account is created but nothing
    // can call into it. Auth-only and storage-only contracts are rejected at this layer.
    const components = opts.components ?? [];
    if (components.length === 0) {
      throw new Error(
        "Contract accounts require at least one non-auth procedure: pass at least one entry in `components`."
      );
    }
    const hasNonAuthProcedure = components.some((component) =>
      component.getProcedures().some((procedure) => !procedure.isAuth)
    );
    if (!hasNonAuthProcedure) {
      throw new Error(
        "Contract accounts require at least one non-auth procedure: none of the entries in `components` exports one (only exports marked `@account_procedure` become non-auth procedures)."
      );
    }

    const base = new wasm.AccountBuilder(opts.seed).storageMode(storageMode);
    let builder = noAuth
      ? base.withNoAuthComponent()
      : base.withAuthComponent(
          wasm.AccountComponent.createAuthComponentFromSecretKey(opts.auth)
        );

    for (const component of components) {
      builder = builder.withComponent(component);
    }

    const built = builder.build();
    const account = built.account;

    if (noAuth) {
      // No key to store: the built account already carries its seed.
      await this.#inner.newAccount(account, false);
    } else {
      await this.#inner.newAccountWithSecretKey(account, opts.auth);
    }
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

  /**
   * Read a coherent persisted account snapshot without syncing the network.
   * Includes changes from other browser clients sharing this database.
   *
   * @param {AccountRef} ref - The account to retrieve.
   * @returns {Promise<Account | null>} The account, or null if not tracked.
   */
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
    try {
      return await reader.getBalance(faucetId);
    } finally {
      // The reader holds the client's store, which terminate() cannot release
      // while it lives. The Node binding's reader has no free().
      reader.free?.();
    }
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

  async importWatched(ref) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    await this.#inner.importWatchedAccountById(id);
    return await this.#inner.getAccount(id);
  }

  async trackWitness(ref) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    return await this.#inner.trackAccountWitness(resolveAccountRef(ref, wasm));
  }

  async untrackWitness(ref) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    return await this.#inner.untrackAccountWitness(
      resolveAccountRef(ref, wasm)
    );
  }

  async trackedWitnesses() {
    this.#client.assertNotTerminated();
    return Array.from(await this.#inner.trackedAccountWitnesses());
  }

  async getStorageMapWitness(ref, slotName, key) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const id = resolveAccountRef(ref, wasm);
    const reader = await this.#inner.accountReader(id);
    try {
      return await reader.getStorageMapWitness(slotName, key);
    } finally {
      reader.free?.();
    }
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

  /**
   * Returns whether the invitation code can be used to register an account:
   * `true` when the node does not enforce an account allowlist, or when the
   * code exists and is not registered to an account. Unknown and registered
   * codes answer `false`.
   *
   * The query does not consume the code and does not identify the account
   * that holds it.
   *
   * @param {string} invitationCode
   * @returns {Promise<boolean>}
   */
  async isInvitationCodeValid(invitationCode) {
    this.#client.assertNotTerminated();
    if (typeof invitationCode !== "string" || invitationCode.length === 0) {
      throw new Error(
        "accounts.isInvitationCodeValid requires a non-empty 'invitationCode' string"
      );
    }
    return await this.#inner.isInvitationCodeValid(invitationCode);
  }

  /**
   * Request a public P2ID note of the chain's native fee asset from a
   * development faucet. Does not consume the note or sign a transaction.
   *
   * Defaults to the public testnet / devnet faucet APIs when the client RPC
   * endpoint names those networks; other networks require `faucetUrl`.
   * The request is never retried: a timeout during minting can leave a note
   * on the chain.
   *
   * @param {import("../types/api-types.js").AccountRef} account
   * @param {import("../funding.js").FundingOptions} [options]
   * @returns {Promise<{ noteId: string, transactionId: string, faucetId: string, amount: bigint }>}
   */
  async requestFundingNote(account, options = {}) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(account, wasm);
    const accountIdHex = accountId.toString();
    const opts = normalizeFundingOptions(options);

    return withinTimeout(
      opts.timeoutMs,
      "the faucet (minting may already have succeeded)",
      async () => {
        await this.#client.syncChain();
        const feeFaucetId = await this.#client.feeFaucetId();
        const feeFaucetIdHex =
          typeof feeFaucetId?.toString === "function"
            ? feeFaucetId.toString()
            : String(feeFaucetId);

        const network =
          opts.network ?? networkFromEndpoint(this.#client.endpoint());
        const faucetUrl = opts.faucetUrl ?? defaultFaucetUrl(network);

        return requestNoteFromFaucet({
          faucetUrl,
          accountIdHex,
          feeFaucetIdHex,
          network,
          amount: opts.amount,
          wasm,
          fetch: opts.fetch,
        });
      }
    );
  }

  /**
   * Fund a tracked account from a development faucet: request a public P2ID
   * note of the native fee asset, wait until it is committed locally, consume
   * it, and wait for confirmation. A fresh wallet can pay its first fee from
   * this note. After a failure that retains a note id, resume that note
   * instead of requesting funds again.
   *
   * @param {import("../types/api-types.js").AccountRef} account
   * @param {import("../funding.js").FundingOptions} [options]
   * @returns {Promise<{ noteId: string, transactionId: string, balance: bigint }>}
   */
  async fundAccount(account, options = {}) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(account, wasm);
    const accountIdHex = accountId.toString();
    const opts = normalizeFundingOptions(options);

    // Reject untracked accounts before the faucet creates a note.
    const tracked = await this.#inner.getAccount(accountId);
    if (!tracked) {
      throw fundingInvalid(
        `account ${accountIdHex} is not tracked locally; create or import it before funding`
      );
    }

    const receipt = await this.requestFundingNote(accountIdHex, {
      ...options,
      // Keep normalized timers / amount; requestFundingNote re-normalizes.
    });

    let consumptionTxId = null;
    try {
      await withinTimeout(opts.timeoutMs, "the funding note", async () => {
        for (;;) {
          await this.#client.syncChain();
          const record = await this.#client.notes.get(receipt.noteId);
          if (record) {
            const kind = classifyInputNoteState(
              record.state?.() ?? record.state,
              wasm
            );
            if (kind === "consumed" || kind === "processing") {
              throw fundingInvalid(
                "funding note is already consumed or being processed"
              );
            }
            if (kind === "committed") {
              return;
            }
          }
          await sleep(opts.pollIntervalMs);
        }
      });

      const { txId } = await this.#client.transactions.consume({
        account: accountIdHex,
        noteIds: [receipt.noteId],
        waitForConfirmation: true,
        timeout: opts.timeoutMs,
      });
      consumptionTxId =
        typeof txId?.toHex === "function"
          ? txId.toHex()
          : typeof txId?.toString === "function"
            ? txId.toString()
            : String(txId);

      const balance = await this.getBalance(accountIdHex, receipt.faucetId);
      return {
        noteId: receipt.noteId,
        transactionId: consumptionTxId,
        balance,
      };
    } catch (source) {
      throw wrapAfterRequest(source, {
        noteId: receipt.noteId,
        transactionId: consumptionTxId,
      });
    }
  }
}
