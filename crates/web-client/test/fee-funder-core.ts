// @ts-nocheck
/**
 * Shared fee-funding runtime used by both Playwright browser tests (via
 * function serialization) and Node.js integration tests.
 *
 * Keep `createFundingRuntime` free of TypeScript-only syntax and module-level
 * closures so `createFundingRuntime.toString()` executes directly inside
 * browser `page.evaluate(...)` calls.
 */

export function createFundingRuntime(deps) {
  const {
    sdk,
    getDefaultClient,
    getFunderState,
    proveTransactionWithFallback,
    transferNoteFile,
    fundingAmount = 1_000_000n,
    retryDelayMs = 2_000,
  } = deps;

  const defaultTransferNoteFile = async (
    funderClient,
    targetClient,
    noteId
  ) => {
    if (!sdk?.NoteExportFormat?.Full || !sdk?.NoteFile?.deserialize) {
      return false;
    }
    try {
      const noteFile = await funderClient.exportNoteFile(
        noteId,
        sdk.NoteExportFormat.Full
      );
      const bytes = noteFile.serialize();
      await targetClient.importNoteFile(sdk.NoteFile.deserialize(bytes));
      return true;
    } catch {
      return false;
    }
  };
  const resolveTransferNoteFile = transferNoteFile ?? defaultTransferNoteFile;

  const toAccountHex = (accountOrHex) =>
    typeof accountOrHex === "string" ? accountOrHex : accountOrHex.toString();

  const normalizeIds = (accountIds) => {
    const seen = new Set();
    const hexes = [];
    for (const id of accountIds) {
      const hex = toAccountHex(id);
      if (!seen.has(hex)) {
        seen.add(hex);
        hexes.push(hex);
      }
    }
    return hexes;
  };

  const waitForCommitted = async (
    client,
    txIds,
    maxWaitTime = 60_000,
    delayInterval = 500
  ) => {
    const pending = new Set(Array.isArray(txIds) ? txIds : [txIds]);
    if (pending.size === 0) {
      return;
    }
    const start = Date.now();
    while (true) {
      await client.syncState();
      const records = await client.getTransactions(
        sdk.TransactionFilter.ids(
          Array.from(pending, (id) => sdk.TransactionId.fromHex(id))
        )
      );
      const byId = new Map(records.map((tx) => [tx.id().toHex(), tx]));
      for (const id of Array.from(pending)) {
        const status = byId.get(id)?.transactionStatus?.();
        if (status?.isDiscarded?.()) {
          throw new Error(`Transaction ${id} was discarded`);
        }
        if (status?.isCommitted?.()) {
          pending.delete(id);
        }
      }
      if (pending.size === 0) {
        return;
      }
      if (Date.now() - start >= maxWaitTime) {
        throw new Error(
          `Timeout waiting for transaction ${Array.from(pending).join(", ")}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayInterval));
    }
  };

  const resolveProver = (proverOverride) => {
    const candidate =
      typeof proverOverride === "function" ? proverOverride() : proverOverride;
    if (
      typeof proverOverride !== "function" &&
      candidate &&
      typeof candidate.serialize === "function" &&
      typeof sdk?.TransactionProver?.deserialize === "function"
    ) {
      return sdk.TransactionProver.deserialize(candidate.serialize());
    }
    return candidate;
  };

  const executeProveSubmitApply = async (
    client,
    accountHex,
    request,
    proverOverride
  ) => {
    const execResult = await client.executeTransaction(
      sdk.AccountId.fromHex(accountHex),
      request
    );
    const resolvedProver = resolveProver(proverOverride);
    const proven = await proveTransactionWithFallback(
      client,
      execResult,
      resolvedProver
    );
    const submissionHeight = await client.submitProvenTransaction(
      proven,
      execResult
    );
    const update = await client.applyTransaction(execResult, submissionHeight);
    return {
      update,
      txId: update.executedTransaction().id().toHex(),
    };
  };

  const buildP2idNotesRequest = (funderHex, feeFaucetHex, targets, amount) => {
    const targetNotes = [];
    const builtNotes = [];
    for (const targetHex of targets) {
      const asset = new sdk.FungibleAsset(
        sdk.AccountId.fromHex(feeFaucetHex),
        BigInt(amount)
      );
      const note = sdk.Note.createP2IDNote(
        sdk.AccountId.fromHex(funderHex),
        sdk.AccountId.fromHex(targetHex),
        new sdk.NoteAssets([asset]),
        sdk.NoteType.Public,
        new sdk.NoteAttachment()
      );
      const noteId = note.id().toString();
      targetNotes.push({ accountId: targetHex, noteId });
      builtNotes.push(note);
    }

    let ownNotes;
    if (sdk.NoteArray) {
      ownNotes = new sdk.NoteArray();
      for (const note of builtNotes) {
        ownNotes.push(note);
      }
    } else {
      ownNotes = builtNotes;
    }

    const request = new sdk.TransactionRequestBuilder()
      .withOwnOutputNotes(ownNotes)
      .build();

    return {
      request,
      targetNotes,
      noteIds: targetNotes.map((entry) => entry.noteId),
    };
  };

  const sendFundingNotes = async (accountIds, amount = fundingAmount) => {
    const targets = normalizeIds(accountIds);
    if (targets.length === 0) {
      return null;
    }

    const funder = await getFunderState();
    if (!funder) {
      return null;
    }

    const runPayment = async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        await funder.client.syncState();
        const feeFaucetHex =
          funder.feeFaucetHex ?? (await funder.client.feeFaucetId()).toString();
        const built = buildP2idNotesRequest(
          funder.funderHex,
          feeFaucetHex,
          targets,
          amount
        );

        let submitted = false;
        try {
          const execResult = await funder.client.executeTransaction(
            sdk.AccountId.fromHex(funder.funderHex),
            built.request
          );
          const proven = await proveTransactionWithFallback(
            funder.client,
            execResult,
            undefined
          );
          const submissionHeight = await funder.client.submitProvenTransaction(
            proven,
            execResult
          );
          submitted = true;
          const update = await funder.client.applyTransaction(
            execResult,
            submissionHeight
          );
          const txId = update.executedTransaction().id().toHex();
          await waitForCommitted(funder.client, txId);
          return {
            txId,
            noteIds: built.noteIds,
            targetNotes: built.targetNotes,
            funderClient: funder.client,
          };
        } catch (err) {
          lastError = err;
          if (submitted || attempt > 0) {
            throw err;
          }
          if (retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      }
      throw lastError;
    };

    const previous = funder.queue ?? Promise.resolve();
    const current = previous.then(runPayment, runPayment);
    funder.queue = current.catch(() => {});
    return await current;
  };

  const resolveInputNote = async (targetClient, funderClient, noteId) => {
    const deadline = Date.now() + 15_000;
    while (true) {
      await targetClient.syncState();
      const record = await targetClient.getInputNote(noteId);
      if (record) {
        return record.toNote();
      }
      const imported = await resolveTransferNoteFile(
        funderClient,
        targetClient,
        noteId
      );
      if (imported) {
        const synced = await targetClient.getInputNote(noteId);
        if (synced) {
          return synced.toNote();
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Funding note ${noteId} not found in target client`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  const fundAccounts = async (
    accountIds,
    targetClient,
    proverOverride,
    amount = fundingAmount
  ) => {
    const client = targetClient ?? getDefaultClient();
    const sent = await sendFundingNotes(accountIds, amount);
    if (!sent) {
      return null;
    }

    const consumeTxIds = [];
    for (const entry of sent.targetNotes) {
      const note = await resolveInputNote(
        client,
        sent.funderClient,
        entry.noteId
      );
      const consumeRequest = await client.newConsumeTransactionRequest(
        [note],
        sdk.AccountId.fromHex(entry.accountId)
      );
      const { txId } = await executeProveSubmitApply(
        client,
        entry.accountId,
        consumeRequest,
        proverOverride
      );
      consumeTxIds.push(txId);
    }
    await waitForCommitted(client, consumeTxIds);

    return sent;
  };

  const ensureFunded = async (
    accountIds,
    targetClient,
    proverOverride,
    amount = fundingAmount
  ) => {
    const targets = normalizeIds(accountIds);
    if (targets.length === 0) {
      return null;
    }

    const funder = await getFunderState();
    if (!funder) {
      return null;
    }

    const client = targetClient ?? getDefaultClient();
    const feeFaucetHex =
      funder.feeFaucetHex ?? (await client.feeFaucetId())?.toString();
    if (!feeFaucetHex) {
      return null;
    }

    const unfunded = [];
    for (const targetHex of targets) {
      const account = await client.getAccount(sdk.AccountId.fromHex(targetHex));
      const balance = account
        ? BigInt(
            account.vault().getBalance(sdk.AccountId.fromHex(feeFaucetHex))
          )
        : 0n;
      if (balance === 0n) {
        unfunded.push(targetHex);
      }
    }

    if (unfunded.length === 0) {
      return null;
    }

    return await fundAccounts(unfunded, client, proverOverride, amount);
  };

  return {
    sendFundingNotes,
    fundAccounts,
    ensureFunded,
  };
}
