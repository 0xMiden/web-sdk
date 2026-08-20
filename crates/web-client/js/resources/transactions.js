import {
  resolveAccountRef,
  resolveNoteType,
  resolveTransactionIdHex,
} from "../utils.js";

/**
 * Reject an `anchor` that is present but nullish.
 *
 * Every anchored branch is selected by truthiness, so `{ anchor: null }` would
 * otherwise fall through and execute at the current tip. That is the one
 * failure mode anchoring exists to prevent, and it is easy to hit: the natural
 * source of an anchor is `useChainAnchor().anchor`, which is `null` until the
 * capture resolves.
 */
/** Preview operations that build their own request, and so cannot be anchored. */
const PREVIEW_BUILT_IN_OPERATIONS = new Set([
  "send",
  "mint",
  "bridge",
  "consume",
  "swap",
  "pswapCreate",
  "pswapConsume",
  "pswapCancel",
]);

function assertAnchorNotNullish(opts) {
  if (opts && "anchor" in opts && opts.anchor == null) {
    throw new Error(
      "anchor was null or undefined; await captureAnchor(request) before " +
        "passing it, or omit the option entirely to execute at the current tip"
    );
  }
}

/**
 * Prove an executed transaction, resolving the prover exactly the way the
 * one-shot `submit()` pipeline does: the per-call prover if given, else the
 * client's default prover, else the built-in local prover. Shared by
 * {@link TransactionExecution.prove} and the internal pipeline so the two can
 * never drift.
 *
 * @param {*} inner - The WASM WebClient.
 * @param {*} defaultProver - The client's configured default prover, or null.
 * @param {*} result - The execution result to prove.
 * @param {{ prover?: * }} [opts] - Optional per-call prover override.
 * @returns {Promise<*>} The proven transaction.
 */
async function proveResult(inner, defaultProver, result, opts) {
  const prover = opts?.prover ?? defaultProver;
  return prover
    ? await inner.proveTransaction(result, prover)
    : await inner.proveTransaction(result);
}

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

  /**
   * Builds a Public custom-script note carrying a NetworkAccountTarget
   * attachment, submits it as an own output note, and optionally waits for
   * confirmation. Provide exactly one of `recipient` or `script`.
   */
  async createNetworkNote(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    if (opts.recipient && opts.script) {
      throw new Error(
        "createNetworkNote requires exactly one of `recipient` or `script`, not both."
      );
    }

    const senderId = resolveAccountRef(opts.account, wasm);

    const target =
      opts.target instanceof wasm.NetworkAccountTarget
        ? opts.target
        : new wasm.NetworkAccountTarget(
            resolveAccountRef(opts.target, wasm),
            opts.executionHint
          );

    const noteAssets = opts.assets
      ? new wasm.NoteAssets(
          (Array.isArray(opts.assets) ? opts.assets : [opts.assets]).map(
            (a) =>
              new wasm.FungibleAsset(
                resolveAccountRef(a.token, wasm),
                BigInt(a.amount)
              )
          )
        )
      : new wasm.NoteAssets();

    const metadata = new wasm.NoteMetadata(
      senderId,
      wasm.NoteType.Public,
      wasm.NoteTag.withAccountTarget(target.targetId())
    );

    let recipient = opts.recipient;
    if (!recipient) {
      if (!opts.script) {
        throw new Error(
          "createNetworkNote requires either `recipient` or `script`."
        );
      }
      const storage = new wasm.NoteStorage(
        new wasm.FeltArray(
          (opts.inputs ?? []).map((value) => new wasm.Felt(value))
        )
      );
      recipient = wasm.NoteRecipient.fromScript(opts.script, storage);
    }

    const attachments = [target.toAttachment()];
    if (opts.attachment) {
      attachments.push(new wasm.NoteAttachment(opts.attachment));
    }

    const note = wasm.Note.withAttachments(
      noteAssets,
      metadata,
      recipient,
      attachments
    );

    // NoteArray constructor consumes its elements; use push(&note) to keep
    // `note` valid so we can return it to the caller.
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

  async bridge(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = await this.#buildB2AggRequest(opts, wasm);

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

  /** Create a partial-swap (PSWAP) note. See {@link PswapCreateOptions}. */
  async pswapCreate(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = await this.#buildPswapCreateRequest(
      opts,
      wasm
    );

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

  /** Consume (fully or partially fill) a PSWAP note. See {@link PswapConsumeOptions}. */
  async pswapConsume(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = await this.#buildPswapConsumeRequest(
      opts,
      wasm
    );

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

  /** Cancel a PSWAP note as its creator and reclaim the offered asset. See {@link PswapCancelOptions}. */
  async pswapCancel(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();
    const { accountId, request } = await this.#buildPswapCancelRequest(
      opts,
      wasm
    );

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
   * Dry-run a transaction to obtain the TransactionSummary pending
   * authorization (e.g. a multisig below its signing threshold). Rejects
   * with an error carrying `code: "TRANSACTION_ALREADY_AUTHORIZED"` (on
   * Node.js the code prefixes the message instead) when the transaction
   * executes successfully, since a fully authorized transaction produces
   * no summary. See {@link PreviewOptions}.
   *
   * With `operation: "custom"` you may pass an `anchor` from
   * {@link captureAnchor} to derive the summary at a pinned reference block
   * rather than the current sync height. A co-signer verifying a proposal must
   * use the proposer's anchor: since protocol 0.16 the summary binds the
   * reference block commitment, so deriving it locally at a different height
   * produces a different summary and the comparison always fails.
   */
  async preview(opts) {
    this.#client.assertNotTerminated();
    const wasm = await this.#getWasm();

    assertAnchorNotNullish(opts);

    // Only `custom` can be anchored. Every other operation builds its request
    // here, so the caller cannot hold an anchor captured for it — accepting one
    // would execute against a request the anchor never tracked, surfacing as an
    // opaque error from deep inside the executor. An unrecognized operation
    // falls through to the switch, so it reports that rather than the anchor.
    if (opts.anchor && PREVIEW_BUILT_IN_OPERATIONS.has(opts.operation)) {
      throw new Error(
        `preview does not accept an anchor for operation "${opts.operation}"; ` +
          `capture one with captureAnchor(request) and use operation: "custom"`
      );
    }

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
      case "bridge": {
        ({ accountId, request } = await this.#buildB2AggRequest(opts, wasm));
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
      case "pswapCreate": {
        ({ accountId, request } = await this.#buildPswapCreateRequest(
          opts,
          wasm
        ));
        break;
      }
      case "pswapConsume": {
        ({ accountId, request } = await this.#buildPswapConsumeRequest(
          opts,
          wasm
        ));
        break;
      }
      case "pswapCancel": {
        ({ accountId, request } = await this.#buildPswapCancelRequest(
          opts,
          wasm
        ));
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

    return opts.anchor
      ? await this.#inner.executeForSummaryAt(accountId, request, opts.anchor)
      : await this.#inner.executeForSummary(accountId, request);
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
   * @param {object} [options] - Optional settings (waitForConfirmation, timeout).
   *   The batch is proved with the client's configured prover; the V1 batch API
   *   has no per-call prover override.
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

  /**
   * Capture a {@link ChainAnchor} at the current sync height for `request`,
   * pinning the reference block that a later execution can replay against.
   *
   * The anchor tracks the creation blocks of the request's authenticated input
   * notes, so it stays valid for that request once the chain advances. Pass it
   * back to {@link preview}, {@link executeRequest}, or {@link submit} via
   * their `anchor` option. Serialize it with `anchor.serialize()` to ship it
   * alongside a summary awaiting signatures.
   *
   * @param {TransactionRequest} request - The request the anchor is captured for.
   * @returns {Promise<ChainAnchor>} An anchor pinned to the current sync height.
   * @throws An error with `code` `"INVALID_CHAIN_ANCHOR"` (on Node.js the code
   * prefixes the message instead) if a sync lands mid-capture and leaves the
   * anchor internally inconsistent. Retry.
   */
  async captureAnchor(request) {
    this.#client.assertNotTerminated();
    return await this.#inner.chainAnchorForRequest(request);
  }

  async submit(account, request, opts) {
    this.#client.assertNotTerminated();
    assertAnchorNotNullish(opts);
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(account, wasm);
    return await this.#submitOrSubmitWithProver(
      accountId,
      request,
      opts?.prover,
      opts?.anchor
    );
  }

  /**
   * Execute a transaction request locally — nothing is proven, submitted, or
   * persisted. Returns a {@link TransactionExecution} handle; advance the
   * lifecycle by chaining `.prove()` → `.submit()` → `.apply()`, benchmarking
   * or error-handling each stage independently. Use {@link submit} to run every
   * stage in one call.
   *
   * ```ts
   * const executed  = await client.transactions.executeRequest(account, request);
   * const proven    = await executed.prove({ prover });
   * const submitted = await proven.submit();
   * await submitted.apply();
   * ```
   *
   * The stages are NOT atomic as a group: awaiting other mutating calls on the
   * same account between them can interleave state. Drive the chain as an
   * uninterrupted sequence per account.
   *
   * @param {AccountRef} account - The account executing the transaction.
   * @param {TransactionRequest} request - The pre-built transaction request.
   * @param {{ anchor?: ChainAnchor }} [opts] - Pass `anchor` to execute against
   *   a pinned reference block instead of the current sync height, reproducing
   *   the summary that was signed at that block.
   * @returns {Promise<TransactionExecution>} A handle to the executed
   *   transaction, ready to prove.
   */
  async executeRequest(account, request, opts) {
    this.#client.assertNotTerminated();
    assertAnchorNotNullish(opts);
    const wasm = await this.#getWasm();
    const accountId = resolveAccountRef(account, wasm);
    const result = opts?.anchor
      ? await this.#inner.executeTransactionAt(accountId, request, opts.anchor)
      : await this.#inner.executeTransaction(accountId, request);
    return new TransactionExecution(this.#inner, this.#client, this, result);
  }

  /**
   * Submit a proof produced somewhere that shares nothing with this client —
   * e.g. a detached prover that never saw the local store. Returns a
   * {@link TransactionSubmission} handle; call `.apply()` on it to persist
   * locally. For the in-process flow prefer
   * `executeRequest(...)` → `.prove()` → `.submit()`, which threads the proof
   * and result for you.
   *
   * @param {ProvenTransaction} proof - A proof for `result`, proven elsewhere.
   * @param {TransactionResult} result - The matching execution result.
   * @returns {Promise<TransactionSubmission>} A handle to the submitted
   *   transaction, ready to apply.
   */
  async submitProven(proof, result) {
    this.#client.assertNotTerminated();
    const blockNumber = await this.#inner.submitProvenTransaction(
      proof,
      result
    );
    return new TransactionSubmission(
      this.#inner,
      this.#client,
      this,
      result,
      blockNumber
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
        // Chain-only sync is sufficient: confirmation only needs on-chain
        // state, and skipping NTL keeps polling alive when the note
        // transport endpoint is unavailable.
        await this.#inner.syncChain();
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

  async #buildB2AggRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const bridgeAccountId = resolveAccountRef(opts.bridgeAccount, wasm);
    const faucetId = resolveAccountRef(opts.token, wasm);
    const amount = BigInt(opts.amount);
    const destinationAddress = wasm.EthAddress.fromHex(opts.destinationAddress);

    const request = await this.#inner.newB2AggTransactionRequest(
      accountId,
      bridgeAccountId,
      faucetId,
      amount,
      opts.destinationNetwork,
      destinationAddress
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

  async #buildPswapCreateRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const offeredFaucetId = resolveAccountRef(opts.offer.token, wasm);
    const requestedFaucetId = resolveAccountRef(opts.request.token, wasm);
    const noteType = resolveNoteType(opts.type, wasm);
    const paybackNoteType = resolveNoteType(
      opts.paybackType ?? opts.type,
      wasm
    );

    const request = await this.#inner.newPswapCreateTransactionRequest(
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

  async #buildPswapConsumeRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const note = await this.#resolveNoteInput(opts.note);
    const noteFillAmount = opts.noteFillAmount ?? 0n;

    const request = await this.#inner.newPswapConsumeTransactionRequest(
      note,
      accountId,
      BigInt(opts.fillAmount),
      BigInt(noteFillAmount)
    );
    return { accountId, request };
  }

  async #buildPswapCancelRequest(opts, wasm) {
    const accountId = resolveAccountRef(opts.account, wasm);
    const note = await this.#resolveNoteInput(opts.note);

    const request = await this.#inner.newPswapCancelTransactionRequest(
      note,
      accountId
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

  async #submitOrSubmitWithProver(accountId, request, perCallProver, anchor) {
    const result = anchor
      ? await this.#inner.executeTransactionAt(accountId, request, anchor)
      : await this.#inner.executeTransaction(accountId, request);
    const proven = await proveResult(
      this.#inner,
      this.#client.defaultProver,
      result,
      { prover: perCallProver }
    );
    const txId = result.id();
    const height = await this.#inner.submitProvenTransaction(proven, result);
    await this.#inner.applyTransaction(result, height);
    return { txId, result };
  }
}

/**
 * A locally-executed transaction — nothing proven, submitted, or persisted yet.
 * First stage of the manual transaction lifecycle, returned by
 * {@link TransactionsResource.executeRequest}. Advance it with {@link prove}.
 */
class TransactionExecution {
  #inner;
  #client;
  #resource;
  #result;

  constructor(inner, client, resource, result) {
    this.#inner = inner;
    this.#client = client;
    this.#resource = resource;
    this.#result = result;
  }

  /** The raw execution artifact (account delta, output notes, …). */
  get result() {
    return this.#result;
  }

  /** The executed transaction's id. */
  get id() {
    return this.#result.id();
  }

  /**
   * Prove this execution. Uses the per-call prover when provided, falling back
   * to the client's default prover (or the built-in local prover). Pure
   * computation — touches neither the network nor the local store.
   *
   * A `TransactionProver` is consumed by the call: build (or clone) a fresh
   * prover per `prove()`. Reusing an already-passed prover silently falls back
   * to the built-in local prover.
   *
   * @param {ProveOptions} [opts] - Optional per-call prover override.
   * @returns {Promise<TransactionProof>} A handle to the proven transaction,
   *   ready to submit.
   */
  async prove(opts) {
    this.#client.assertNotTerminated();
    const proven = await proveResult(
      this.#inner,
      this.#client.defaultProver,
      this.#result,
      opts
    );
    return new TransactionProof(
      this.#inner,
      this.#client,
      this.#resource,
      proven,
      this.#result
    );
  }
}

/**
 * A proven transaction, ready for the network. Second stage of the manual
 * transaction lifecycle, returned by {@link TransactionExecution.prove}.
 * Advance it with {@link submit}.
 */
class TransactionProof {
  #inner;
  #client;
  #resource;
  #proof;
  #result;

  constructor(inner, client, resource, proof, result) {
    this.#inner = inner;
    this.#client = client;
    this.#resource = resource;
    this.#proof = proof;
    this.#result = result;
  }

  /** The raw proof — e.g. to serialize and submit from a different client. */
  get proof() {
    return this.#proof;
  }

  /** The execution result this proof was produced from. */
  get result() {
    return this.#result;
  }

  /**
   * Submit the proof to the network. Does NOT persist locally — call
   * {@link TransactionSubmission.apply} on the returned handle; skipping it
   * leaves the local store out of sync until the next full sync.
   *
   * @returns {Promise<TransactionSubmission>} A handle to the submitted
   *   transaction, ready to apply.
   */
  async submit() {
    this.#client.assertNotTerminated();
    const blockNumber = await this.#inner.submitProvenTransaction(
      this.#proof,
      this.#result
    );
    return new TransactionSubmission(
      this.#inner,
      this.#client,
      this.#resource,
      this.#result,
      blockNumber
    );
  }
}

/**
 * A submitted transaction. Final stage of the manual transaction lifecycle,
 * returned by {@link TransactionProof.submit}. Persist it locally with
 * {@link apply}, or block until it commits with {@link waitForConfirmation}.
 */
class TransactionSubmission {
  #inner;
  #client;
  #resource;
  #result;
  #blockNumber;

  constructor(inner, client, resource, result, blockNumber) {
    this.#inner = inner;
    this.#client = client;
    this.#resource = resource;
    this.#result = result;
    this.#blockNumber = blockNumber;
  }

  /** The block height the transaction was submitted at. */
  get blockNumber() {
    return this.#blockNumber;
  }

  /** The execution result that was submitted. */
  get result() {
    return this.#result;
  }

  /**
   * Persist the transaction into the local store, firing registered
   * transaction observers (e.g. PSWAP lineage tracking). Until this runs the
   * local store is unaware of the transaction.
   *
   * @returns {Promise<TransactionStoreUpdate>} The pre-apply store update.
   */
  async apply() {
    this.#client.assertNotTerminated();
    return await this.#inner.applyTransaction(this.#result, this.#blockNumber);
  }

  /**
   * Poll local sync height until the transaction commits on-chain. Convenience
   * wrapper over {@link TransactionsResource.waitFor}.
   *
   * @param {WaitOptions} [opts] - Polling options (timeout, interval, onProgress).
   */
  async waitForConfirmation(opts) {
    return await this.#resource.waitFor(this.#result.id().toHex(), opts);
  }
}
