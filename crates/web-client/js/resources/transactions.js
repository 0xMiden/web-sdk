import {
  resolveAccountRef,
  resolveNoteType,
  resolveTransactionIdHex,
} from "../utils.js";

export class TransactionsResource {
  #inner;
  #getWasm;
  #client;

  constructor(inner, getWasm, client) {
    this.#inner = inner;
    this.#getWasm = getWasm;
    this.#client = client;
  }

  async send(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    if (opts.returnNote === true) {
      // returnNote path — build the P2ID note in JS so we can return the Note
      // object to the caller (e.g. for out-of-band delivery to the recipient).
      if (opts.reclaimAfter != null || opts.timelockUntil != null) {
        throw new Error(
          "reclaimAfter and timelockUntil are not supported when returnNote is true"
        );
      }

      const senderId = resolveAccountRef(opts.account, wasm);
      const receiverId = resolveAccountRef(opts.to, wasm);
      const faucetId = resolveAccountRef(opts.token, wasm);
      const noteType = resolveNoteType(opts.type, wasm);

      const note = wasm.Note.createP2IDNote(
        senderId,
        receiverId,
        new wasm.NoteAssets([
          new wasm.FungibleAsset(faucetId, BigInt(opts.amount)),
        ]),
        noteType,
        new wasm.NoteAttachment()
      );

      // NoteArray constructor consumes its elements; use push(&note) to keep
      // `note` valid so we can return it to the caller below.
      const ownOutputs = new wasm.NoteArray();
      ownOutputs.push(note);
      const request = new wasm.TransactionRequestBuilder()
        .withOwnOutputNotes(ownOutputs)
        .build();

      const { txId, result } = await this.#submitOrSubmitWithProver(
        senderId,
        request,
        opts.prover
      );

      if (opts.waitForConfirmation) {
        await this.waitFor(txId.toHex(), { timeout: opts.timeout });
      }

      return { txId, note, result };
    }

    // Default path — note built in WASM with optional reclaim/timelock
    const { accountId, request } = await this.#buildSendRequest(opts, wasm);
    const { txId, result } = await this.#submitOrSubmitWithProver(
      accountId,
      request,
      opts.prover
    );

    if (opts.waitForConfirmation) {
      await this.waitFor(txId.toHex(), { timeout: opts.timeout });
    }

    return { txId, note: null, result };
  }

  async mint(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = await this.#buildMintRequest(opts, wasm);

    const { txId, result } = await this.#submitOrSubmitWithProver(
      accountId,
      request,
      opts.prover
    );

    if (opts.waitForConfirmation) {
      await this.waitFor(txId.toHex(), { timeout: opts.timeout });
    }

    return { txId, result };
  }

  async consume(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = await this.#buildConsumeRequest(opts, wasm);

    const { txId, result } = await this.#submitOrSubmitWithProver(
      accountId,
      request,
      opts.prover
    );

    if (opts.waitForConfirmation) {
      await this.waitFor(txId.toHex(), { timeout: opts.timeout });
    }

    return { txId, result };
  }

  async consumeAll(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    // getConsumableNotes takes AccountId by value (consumed by WASM).
    // Save hex so we can reconstruct for submitNewTransaction.
    const accountId = resolveAccountRef(opts.account, wasm);
    const accountIdHex = accountId.toString();
    const consumable = await this.#inner.getConsumableNotes(accountId);

    if (!consumable || consumable.length === 0) {
      return { txId: null, consumed: 0, remaining: 0 };
    }

    const total = consumable.length;
    const toConsume =
      opts.maxNotes != null ? consumable.slice(0, opts.maxNotes) : consumable;

    if (toConsume.length === 0) {
      return { txId: null, consumed: 0, remaining: total };
    }

    const notes = toConsume.map((c) => c.inputNoteRecord().toNote());

    const request = await this.#inner.newConsumeTransactionRequest(notes);

    const { txId, result } = await this.#submitOrSubmitWithProver(
      wasm.AccountId.fromHex(accountIdHex),
      request,
      opts.prover
    );

    if (opts.waitForConfirmation) {
      await this.waitFor(txId.toHex(), { timeout: opts.timeout });
    }

    return {
      txId,
      consumed: toConsume.length,
      remaining: total - toConsume.length,
      result,
    };
  }

  async swap(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = await this.#buildSwapRequest(opts, wasm);

    const { txId, result } = await this.#submitOrSubmitWithProver(
      accountId,
      request,
      opts.prover
    );

    if (opts.waitForConfirmation) {
      await this.waitFor(txId.toHex(), { timeout: opts.timeout });
    }

    return { txId, result };
  }

  async preview(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    let accountId;
    let request;

    switch (opts.operation) {
      case "send": {
        ({ accountId, request } = await this.#buildSendRequest(opts, wasm));
        break;
      }
      case "mint": {
        ({ accountId, request } = await this.#buildMintRequest(opts, wasm));
        break;
      }
      case "consume": {
        ({ accountId, request } = await this.#buildConsumeRequest(opts, wasm));
        break;
      }
      case "swap": {
        ({ accountId, request } = await this.#buildSwapRequest(opts, wasm));
        break;
      }
      case "custom": {
        accountId = resolveAccountRef(opts.account, wasm);
        request = opts.request;
        break;
      }
      default:
        throw new Error(`Unknown preview operation: ${opts.operation}`);
    }

    return await this.#inner.executeForSummary(accountId, request);
  }

  async execute(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = this.#buildExecuteRequest(opts, wasm);

    const { txId, result } = await this.#submitOrSubmitWithProver(
      accountId,
      request,
      opts.prover
    );

    if (opts.waitForConfirmation) {
      await this.waitFor(txId.toHex(), { timeout: opts.timeout });
    }

    return { txId, result };
  }

  /**
   * Submit a heterogeneous batch of operations against a single account. All
   * operations are executed, proven individually and as a batch, and submitted
   * atomically — either every tx in the batch lands or none does.
   *
   * @param {BatchOptions} opts - Batch options including the account, operations array, and confirmation settings.
   * @returns {Promise<BatchSubmitResult>} The block number the batch was accepted into.
   */
  async batch(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    if (!opts || !opts.account) {
      throw new Error("batch: `account` is required");
    }
    if (!Array.isArray(opts.operations) || opts.operations.length === 0) {
      throw new Error("batch: `operations` must be a non-empty array");
    }

    // Build each TransactionRequest. Per-op builders all use the batch-level
    // `account` — V1 only supports same-account batches, mirroring the Rust
    // constraint. We forward `opts.account` into each per-op options object so
    // the existing builders' `resolveAccountRef` produces fresh AccountIds
    // when needed.
    const requests = [];
    for (let i = 0; i < opts.operations.length; i++) {
      const op = opts.operations[i];
      let built;
      switch (op?.kind) {
        case "send":
          built = await this.#buildSendRequest(
            { ...op, account: opts.account },
            wasm
          );
          break;
        case "mint":
          built = await this.#buildMintRequest(
            { ...op, account: opts.account },
            wasm
          );
          break;
        case "consume":
          built = await this.#buildConsumeRequest(
            { ...op, account: opts.account },
            wasm
          );
          break;
        case "swap":
          built = await this.#buildSwapRequest(
            { ...op, account: opts.account },
            wasm
          );
          break;
        case "execute":
          built = this.#buildExecuteRequest(
            { ...op, account: opts.account },
            wasm
          );
          break;
        case "custom":
          if (!op.request) {
            throw new Error(
              `batch: operation[${i}] of kind "custom" is missing \`request\``
            );
          }
          built = { request: op.request };
          break;
        default:
          throw new Error(
            `batch: operation[${i}] has unknown kind "${op?.kind}"`
          );
      }
      requests.push(built.request);
    }

    return this.submitBatch(opts.account, requests, opts);
  }

  /**
   * Submit pre-built TransactionRequests as an atomic batch. Lower-level
   * counterpart of `batch()` — for callers that already have built requests in
   * hand. Equivalent to `submit()` but plural.
   *
   * @param {AccountRef} account - The account executing the batch.
   * @param {TransactionRequest[]} requests - Pre-built transaction requests.
   * @param {object} [options] - Optional settings (waitForConfirmation, timeout, prover).
   * @returns {Promise<BatchSubmitResult>} The block number the batch was accepted into.
   */
  async submitBatch(account, requests, options) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    if (!Array.isArray(requests) || requests.length === 0) {
      throw new Error("submitBatch: `requests` must be a non-empty array");
    }

    const accountId = resolveAccountRef(account, wasm);
    const blockNumber = await this.#inner.submitNewTransactionBatch(
      accountId,
      requests.map((r) => r.serialize())
    );

    if (options?.waitForConfirmation) {
      await this.#waitForBlock(blockNumber, options);
    }

    return { blockNumber };
  }

  /**
   * Polls until the local sync height reaches `blockNumber` or the timeout
   * expires. The Rust V1 batch API returns only a block number — there are no
   * per-tx ids to poll on, so we wait on the chain height instead.
   *
   * @param {number} blockNumber - The block height to wait for.
   * @param {object} [opts] - Polling options (timeout, interval).
   */
  async #waitForBlock(blockNumber, opts) {
    const timeout = opts?.timeout ?? 60_000;
    const interval = opts?.interval ?? 5_000;
    const start = Date.now();

    while (true) {
      if (timeout > 0 && Date.now() - start >= timeout) {
        throw new Error(
          `Batch confirmation timed out after ${timeout}ms (waiting for block ${blockNumber})`
        );
      }
      try {
        await this.#inner.syncStateWithTimeout(0);
      } catch {
        // sync may fail transiently; continue polling
      }
      const height = await this.#inner.getSyncHeight();
      if (height >= blockNumber) return;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  #buildExecuteRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);

    let builder = new wasm.TransactionRequestBuilder().withCustomScript(
      opts.script
    );

    if (opts.foreignAccounts?.length) {
      const accounts = opts.foreignAccounts.map((fa) => {
        // Distinguish { id: AccountRef, storage? } wrapper objects from WASM types
        // (Account/AccountHeader expose .id() as a method, wrappers have .id as a property)
        const isWrapper =
          fa !== null &&
          typeof fa === "object" &&
          "id" in fa &&
          typeof fa.id !== "function";
        const id = resolveAccountRef(isWrapper ? fa.id : fa, wasm);
        const storage =
          isWrapper && fa.storage
            ? fa.storage
            : new wasm.AccountStorageRequirements();
        return wasm.ForeignAccount.public(id, storage);
      });
      builder = builder.withForeignAccounts(
        new wasm.ForeignAccountArray(accounts)
      );
    }

    return { accountId, request: builder.build() };
  }

  async executeProgram(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(opts.account, wasm);

    let foreignAccountsArray = new wasm.ForeignAccountArray();
    if (opts.foreignAccounts?.length) {
      const accounts = opts.foreignAccounts.map((fa) => {
        const isWrapper =
          fa !== null &&
          typeof fa === "object" &&
          "id" in fa &&
          typeof fa.id !== "function";
        const id = resolveAccountRef(isWrapper ? fa.id : fa, wasm);
        const storage =
          isWrapper && fa.storage
            ? fa.storage
            : new wasm.AccountStorageRequirements();
        return wasm.ForeignAccount.public(id, storage);
      });
      foreignAccountsArray = new wasm.ForeignAccountArray(accounts);
    }

    return await this.#inner.executeProgram(
      accountId,
      opts.script,
      opts.adviceInputs ?? new wasm.AdviceInputs(),
      foreignAccountsArray
    );
  }

  async submit(account, request, opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(account, wasm);
    return await this.#submitOrSubmitWithProver(
      accountId,
      request,
      opts?.prover
    );
  }

  async list(query) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    let filter;
    if (!query) {
      filter = wasm.TransactionFilter.all();
    } else if (query.status === "uncommitted") {
      filter = wasm.TransactionFilter.uncommitted();
    } else if (query.ids) {
      const txIds = query.ids.map((id) =>
        wasm.TransactionId.fromHex(resolveTransactionIdHex(id))
      );
      filter = wasm.TransactionFilter.ids(txIds);
    } else if (query.expiredBefore !== undefined) {
      filter = wasm.TransactionFilter.expiredBefore(query.expiredBefore);
    } else {
      filter = wasm.TransactionFilter.all();
    }

    return await this.#inner.getTransactions(filter);
  }

  /**
   * Polls for transaction confirmation.
   *
   * @param {string | TransactionId} txId - Transaction ID hex string or TransactionId object.
   * @param {WaitOptions} [opts] - Polling options.
   * @param {number} [opts.timeout=60000] - Wall-clock polling timeout in
   *   milliseconds. This is NOT a block height — it controls how long the
   *   client waits before giving up. Set to 0 to disable the timeout and poll
   *   indefinitely until the transaction is committed or discarded.
   * @param {number} [opts.interval=5000] - Polling interval in ms.
   * @param {function} [opts.onProgress] - Called with the current status on
   *   each poll iteration ("pending", "submitted", or "committed").
   */
  async waitFor(txId, opts) {
    this.#client.assertNotTerminated();
    const hex = resolveTransactionIdHex(txId);
    const timeout = opts?.timeout ?? 60_000;
    const interval = opts?.interval ?? 5_000;
    const start = Date.now();

    const wasm = await this.#getWasm();

    while (true) {
      const elapsed = Date.now() - start;
      if (timeout > 0 && elapsed >= timeout) {
        throw new Error(
          `Transaction confirmation timed out after ${timeout}ms`
        );
      }

      try {
        await this.#inner.syncStateWithTimeout(0);
      } catch {
        // Sync may fail transiently; continue polling
      }

      // Recreate filter each iteration — WASM consumes it by value
      const filter = wasm.TransactionFilter.ids([
        wasm.TransactionId.fromHex(hex),
      ]);
      const txs = await this.#inner.getTransactions(filter);

      if (txs && txs.length > 0) {
        const tx = txs[0];
        const status = tx.transactionStatus?.();

        if (status) {
          if (status.isCommitted()) {
            opts?.onProgress?.("committed");
            return;
          }
          if (status.isDiscarded()) {
            throw new Error(`Transaction rejected: ${hex}`);
          }
        }

        opts?.onProgress?.("submitted");
      } else {
        opts?.onProgress?.("pending");
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // ── Shared request builders ──

  async #buildSendRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const targetId = resolveAccountRef(opts.to, wasm);
    const faucetId = resolveAccountRef(opts.token, wasm);
    const noteType = resolveNoteType(opts.type, wasm);
    const amount = BigInt(opts.amount);

    const request = await this.#inner.newSendTransactionRequest(
      accountId,
      targetId,
      faucetId,
      noteType,
      amount,
      opts.reclaimAfter,
      opts.timelockUntil
    );
    return { accountId, request };
  }

  async #buildMintRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const targetId = resolveAccountRef(opts.to, wasm);
    const noteType = resolveNoteType(opts.type, wasm);
    const amount = BigInt(opts.amount);

    // WASM signature: newMintTransactionRequest(target, faucet, noteType, amount)
    const request = await this.#inner.newMintTransactionRequest(
      targetId,
      accountId,
      noteType,
      amount
    );
    return { accountId, request };
  }

  async #buildConsumeRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const noteInputs = Array.isArray(opts.notes) ? opts.notes : [opts.notes];

    const isDirectNote = (input) =>
      input !== null &&
      typeof input === "object" &&
      typeof input.id === "function" &&
      typeof input.toNote !== "function";

    const hasDirectNotes = noteInputs.some(isDirectNote);

    if (hasDirectNotes) {
      // At least one raw Note object — use NoteAndArgs builder path
      // (the only WASM path that accepts unauthenticated notes not in the store).
      const resolvedNotes = await Promise.all(
        noteInputs.map(async (input) => {
          if (isDirectNote(input)) return input;
          if (input && typeof input.toNote === "function")
            return input.toNote();
          return await this.#resolveNoteInput(input);
        })
      );

      const noteAndArgsArr = resolvedNotes.map(
        (note) => new wasm.NoteAndArgs(note, null)
      );
      const request = new wasm.TransactionRequestBuilder()
        .withInputNotes(new wasm.NoteAndArgsArray(noteAndArgsArr))
        .build();
      return { accountId, request };
    }

    // Standard path: all inputs are IDs or records — look up from store.
    const notes = await Promise.all(
      noteInputs.map((input) => this.#resolveNoteInput(input))
    );
    const request = await this.#inner.newConsumeTransactionRequest(notes);
    return { accountId, request };
  }

  async #buildSwapRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const offeredFaucetId = resolveAccountRef(opts.offer.token, wasm);
    const requestedFaucetId = resolveAccountRef(opts.request.token, wasm);
    const noteType = resolveNoteType(opts.type, wasm);
    const paybackNoteType = resolveNoteType(
      opts.paybackType ?? opts.type,
      wasm
    );

    const request = await this.#inner.newSwapTransactionRequest(
      accountId,
      offeredFaucetId,
      BigInt(opts.offer.amount),
      requestedFaucetId,
      BigInt(opts.request.amount),
      noteType,
      paybackNoteType
    );
    return { accountId, request };
  }

  async #resolveNoteInput(input) {
    if (typeof input === "string") {
      const record = await this.#inner.getInputNote(input);
      if (!record) {
        throw new Error(`Note not found: ${input}`);
      }
      return record.toNote();
    }
    // InputNoteRecord — unwrap to Note
    if (input && typeof input.toNote === "function") {
      return input.toNote();
    }
    // NoteId — has toString() but not toNote() or id() (unlike InputNoteRecord/Note).
    // Check for constructor.fromHex to distinguish from plain objects.
    if (
      input &&
      typeof input.toString === "function" &&
      typeof input.toNote !== "function" &&
      typeof input.id !== "function" &&
      input.constructor?.fromHex !== undefined
    ) {
      const hex = input.toString();
      const record = await this.#inner.getInputNote(hex);
      if (!record) {
        throw new Error(`Note not found: ${hex}`);
      }
      return record.toNote();
    }
    // Assume it's already a Note object
    return input;
  }

  async #submitOrSubmitWithProver(accountId, request, perCallProver) {
    const result = await this.#inner.executeTransaction(accountId, request);
    const prover = perCallProver ?? this.#client.defaultProver;
    const proven = prover
      ? await this.#inner.proveTransaction(result, prover)
      : await this.#inner.proveTransaction(result);
    const txId = result.id();
    const height = await this.#inner.submitProvenTransaction(proven, result);
    await this.#inner.applyTransaction(result, height);
    return { txId, result };
  }
}
