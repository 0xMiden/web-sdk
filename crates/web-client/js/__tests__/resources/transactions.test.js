import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionsResource } from "../../resources/transactions.js";

// ── Wasm mock factory ──────────────────────────────────────────────────────────

function makeNoteArray() {
  const items = [];
  return {
    push: vi.fn((note) => items.push(note)),
    _items: items,
  };
}

function makeTxRequestBuilder() {
  const self = {
    withOwnOutputNotes: vi.fn().mockReturnThis(),
    withInputNotes: vi.fn().mockReturnThis(),
    withCustomScript: vi.fn().mockReturnThis(),
    withForeignAccounts: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnValue("txRequest"),
  };
  return self;
}

function makeWasm(overrides = {}) {
  return {
    AccountId: {
      fromHex: vi.fn((hex) => ({ hex, toString: () => hex })),
      fromBech32: vi.fn((b) => ({ bech32: b, toString: () => b })),
    },
    NoteType: { Public: "Public", Private: "Private" },
    Note: {
      createP2IDNote: vi.fn().mockReturnValue("p2idNote"),
    },
    NoteAssets: vi.fn().mockReturnValue("noteAssets"),
    FungibleAsset: vi.fn().mockReturnValue("fungibleAsset"),
    NoteAttachment: vi.fn().mockReturnValue("noteAttachment"),
    NoteArray: vi.fn().mockImplementation(makeNoteArray),
    NoteAndArgs: vi.fn().mockImplementation((note, args) => ({ note, args })),
    NoteAndArgsArray: vi.fn().mockReturnValue("noteAndArgsArray"),
    TransactionRequestBuilder: vi.fn().mockImplementation(makeTxRequestBuilder),
    TransactionFilter: {
      all: vi.fn().mockReturnValue("filterAll"),
      uncommitted: vi.fn().mockReturnValue("filterUncommitted"),
      ids: vi.fn().mockReturnValue("filterIds"),
      expiredBefore: vi.fn().mockReturnValue("filterExpired"),
    },
    TransactionId: {
      fromHex: vi.fn((hex) => ({ hex, toHex: () => hex })),
    },
    ForeignAccount: {
      public: vi.fn().mockReturnValue("foreignAcc"),
    },
    ForeignAccountArray: vi.fn().mockReturnValue("foreignAccArray"),
    AccountStorageRequirements: vi.fn().mockReturnValue("storageReqs"),
    AdviceInputs: vi.fn().mockReturnValue("adviceInputs"),
    ...overrides,
  };
}

// ── Inner mock factory ─────────────────────────────────────────────────────────

function makeInner(overrides = {}) {
  const txResult = {
    id: vi.fn().mockReturnValue({ toHex: () => "txHex" }),
  };
  return {
    executeTransaction: vi.fn().mockResolvedValue(txResult),
    proveTransaction: vi.fn().mockResolvedValue("provenTx"),
    submitProvenTransaction: vi.fn().mockResolvedValue(100),
    applyTransaction: vi.fn().mockResolvedValue(undefined),
    newSendTransactionRequest: vi.fn().mockResolvedValue("sendRequest"),
    newMintTransactionRequest: vi.fn().mockResolvedValue("mintRequest"),
    newConsumeTransactionRequest: vi.fn().mockResolvedValue("consumeRequest"),
    newSwapTransactionRequest: vi.fn().mockResolvedValue("swapRequest"),
    getTransactions: vi.fn().mockResolvedValue([]),
    getInputNote: vi
      .fn()
      .mockResolvedValue({ toNote: vi.fn().mockReturnValue("noteFromRecord") }),
    getConsumableNotes: vi.fn().mockResolvedValue([]),
    executeForSummary: vi.fn().mockResolvedValue("summary"),
    executeProgram: vi.fn().mockResolvedValue("programResult"),
    syncStateWithTimeout: vi.fn().mockResolvedValue(undefined),
    _txResult: txResult,
    ...overrides,
  };
}

function makeClient(overrides = {}) {
  return {
    assertNotTerminated: vi.fn(),
    defaultProver: null,
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeResource(
  innerOverrides = {},
  clientOverrides = {},
  wasmOverrides = {}
) {
  const inner = makeInner(innerOverrides);
  const client = makeClient(clientOverrides);
  const wasm = makeWasm(wasmOverrides);
  const getWasm = vi.fn().mockResolvedValue(wasm);
  const resource = new TransactionsResource(inner, getWasm, client);
  return { resource, inner, client, wasm, getWasm };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("TransactionsResource", () => {
  describe("send — default path", () => {
    it("builds send request and submits", async () => {
      const { resource, inner } = makeResource();
      const result = await resource.send({
        account: "0xsender",
        to: "0xrecipient",
        token: "0xfaucet",
        type: "public",
        amount: 100,
      });
      expect(inner.newSendTransactionRequest).toHaveBeenCalled();
      expect(inner.executeTransaction).toHaveBeenCalled();
      expect(inner.proveTransaction).toHaveBeenCalled();
      expect(inner.submitProvenTransaction).toHaveBeenCalled();
      expect(inner.applyTransaction).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
      expect(result.note).toBeNull();
    });

    it("waits for confirmation when waitForConfirmation=true", async () => {
      const { resource, inner } = makeResource();
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const tx = { transactionStatus: () => committedStatus };
      inner.getTransactions.mockResolvedValue([tx]);
      const result = await resource.send({
        account: "0xsender",
        to: "0xrecipient",
        token: "0xfaucet",
        type: "public",
        amount: 100,
        waitForConfirmation: true,
        timeout: 30000,
      });
      expect(inner.syncStateWithTimeout).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
    });

    it("uses defaultProver from client when set", async () => {
      const prover = { prove: vi.fn() };
      const { resource, inner } = makeResource({}, { defaultProver: prover });
      await resource.send({
        account: "0xsender",
        to: "0xrecipient",
        token: "0xfaucet",
        type: "public",
        amount: 100,
      });
      expect(inner.proveTransaction).toHaveBeenCalledWith(
        expect.anything(),
        prover
      );
    });

    it("uses per-call prover over client.defaultProver", async () => {
      const defaultProver = { prove: vi.fn() };
      const callProver = { prove: vi.fn() };
      const { resource, inner } = makeResource({}, { defaultProver });
      await resource.send({
        account: "0xsender",
        to: "0xrecipient",
        token: "0xfaucet",
        type: "public",
        amount: 100,
        prover: callProver,
      });
      expect(inner.proveTransaction).toHaveBeenCalledWith(
        expect.anything(),
        callProver
      );
    });
  });

  describe("send — returnNote path", () => {
    it("throws when reclaimAfter is set with returnNote=true", async () => {
      const { resource } = makeResource();
      await expect(
        resource.send({
          account: "0xsender",
          to: "0xrecipient",
          token: "0xfaucet",
          type: "public",
          amount: 100,
          returnNote: true,
          reclaimAfter: 1000,
        })
      ).rejects.toThrow("reclaimAfter and timelockUntil are not supported");
    });

    it("throws when timelockUntil is set with returnNote=true", async () => {
      const { resource } = makeResource();
      await expect(
        resource.send({
          account: "0xsender",
          to: "0xrecipient",
          token: "0xfaucet",
          type: "public",
          amount: 100,
          returnNote: true,
          timelockUntil: 9999,
        })
      ).rejects.toThrow("reclaimAfter and timelockUntil are not supported");
    });

    it("builds P2ID note and returns note object", async () => {
      const { resource, inner, wasm } = makeResource();
      const result = await resource.send({
        account: "0xsender",
        to: "0xrecipient",
        token: "0xfaucet",
        type: "public",
        amount: 50,
        returnNote: true,
      });
      expect(wasm.Note.createP2IDNote).toHaveBeenCalled();
      expect(result.note).toBe("p2idNote");
      expect(result.txId).toBeDefined();
    });
  });

  describe("mint", () => {
    it("builds mint request and submits", async () => {
      const { resource, inner } = makeResource();
      const result = await resource.mint({
        account: "0xfaucet",
        to: "0xrecipient",
        type: "public",
        amount: 500,
      });
      expect(inner.newMintTransactionRequest).toHaveBeenCalled();
      expect(inner.executeTransaction).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
    });
  });

  describe("consume", () => {
    it("builds consume request for note IDs and submits", async () => {
      const { resource, inner } = makeResource();
      const result = await resource.consume({
        account: "0xaccHex",
        notes: ["0xnote1", "0xnote2"],
      });
      expect(inner.newConsumeTransactionRequest).toHaveBeenCalled();
      expect(inner.executeTransaction).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
    });

    it("handles single note instead of array", async () => {
      const { resource, inner } = makeResource();
      await resource.consume({
        account: "0xaccHex",
        notes: "0xnote1",
      });
      expect(inner.newConsumeTransactionRequest).toHaveBeenCalled();
    });

    it("uses NoteAndArgs builder path when direct Note objects passed", async () => {
      const { resource, wasm } = makeResource();
      const directNote = {
        id: vi.fn().mockReturnValue({ toString: () => "noteid" }),
        assets: vi.fn(),
        // no toNote method — that's the key distinguisher
      };
      await resource.consume({
        account: "0xaccHex",
        notes: [directNote],
      });
      expect(wasm.NoteAndArgs).toHaveBeenCalledWith(directNote, null);
      expect(wasm.TransactionRequestBuilder).toHaveBeenCalled();
    });

    it("unwraps InputNoteRecord via toNote() in standard path", async () => {
      const noteRecord = { toNote: vi.fn().mockReturnValue("note") };
      const { resource, inner } = makeResource();
      await resource.consume({
        account: "0xaccHex",
        notes: [noteRecord],
      });
      expect(noteRecord.toNote).toHaveBeenCalledOnce();
      expect(inner.newConsumeTransactionRequest).toHaveBeenCalled();
    });

    it("fetches note by string in standard path", async () => {
      const { resource, inner } = makeResource();
      await resource.consume({
        account: "0xaccHex",
        notes: ["0xnoteHex"],
      });
      expect(inner.getInputNote).toHaveBeenCalledWith("0xnoteHex");
    });

    it("throws when note not found by string in standard path", async () => {
      const { resource, inner } = makeResource({
        getInputNote: vi.fn().mockResolvedValue(null),
      });
      await expect(
        resource.consume({
          account: "0xaccHex",
          notes: ["0xmissing"],
        })
      ).rejects.toThrow("Note not found: 0xmissing");
    });

    it("resolves NoteId object with constructor.fromHex in standard path", async () => {
      const { resource, inner } = makeResource();
      const noteIdObj = {
        toString: vi.fn().mockReturnValue("0xnoteIdHex"),
        constructor: { fromHex: vi.fn() },
      };
      await resource.consume({
        account: "0xaccHex",
        notes: [noteIdObj],
      });
      expect(inner.getInputNote).toHaveBeenCalledWith("0xnoteIdHex");
    });

    it("passes through unknown object as-is in standard path", async () => {
      // If input is not a string, not a toNote(), not a NoteId with fromHex
      // then #resolveNoteInput returns it as-is (treated as raw Note).
      const unknownNote = { someData: true };
      const { resource, inner } = makeResource();
      // Standard path uses it directly (falls through to return input)
      // But it goes to newConsumeTransactionRequest, which is mocked
      await resource.consume({
        account: "0xaccHex",
        notes: [unknownNote],
      });
      expect(inner.newConsumeTransactionRequest).toHaveBeenCalledWith([
        unknownNote,
      ]);
    });
  });

  describe("consumeAll", () => {
    it("returns empty result when no consumable notes", async () => {
      const { resource, inner } = makeResource({
        getConsumableNotes: vi.fn().mockResolvedValue([]),
      });
      const result = await resource.consumeAll({ account: "0xaccHex" });
      expect(result).toEqual({ txId: null, consumed: 0, remaining: 0 });
    });

    it("returns empty result when consumable is null", async () => {
      const { resource } = makeResource({
        getConsumableNotes: vi.fn().mockResolvedValue(null),
      });
      const result = await resource.consumeAll({ account: "0xaccHex" });
      expect(result).toEqual({ txId: null, consumed: 0, remaining: 0 });
    });

    it("consumes all notes and returns count", async () => {
      const note1 = {
        inputNoteRecord: vi
          .fn()
          .mockReturnValue({ toNote: vi.fn().mockReturnValue("n1") }),
      };
      const note2 = {
        inputNoteRecord: vi
          .fn()
          .mockReturnValue({ toNote: vi.fn().mockReturnValue("n2") }),
      };
      const { resource, inner } = makeResource({
        getConsumableNotes: vi.fn().mockResolvedValue([note1, note2]),
      });
      const result = await resource.consumeAll({ account: "0xaccHex" });
      expect(inner.newConsumeTransactionRequest).toHaveBeenCalledWith([
        "n1",
        "n2",
      ]);
      expect(result.consumed).toBe(2);
      expect(result.remaining).toBe(0);
      expect(result.txId).toBeDefined();
    });

    it("respects maxNotes option", async () => {
      const notes = Array.from({ length: 5 }, (_, i) => ({
        inputNoteRecord: vi
          .fn()
          .mockReturnValue({ toNote: vi.fn().mockReturnValue(`n${i}`) }),
      }));
      const { resource } = makeResource({
        getConsumableNotes: vi.fn().mockResolvedValue(notes),
      });
      const result = await resource.consumeAll({
        account: "0xaccHex",
        maxNotes: 3,
      });
      expect(result.consumed).toBe(3);
      expect(result.remaining).toBe(2);
    });

    it("returns early when maxNotes=0 reduces toConsume to empty", async () => {
      const notes = [
        {
          inputNoteRecord: vi
            .fn()
            .mockReturnValue({ toNote: vi.fn().mockReturnValue("n1") }),
        },
      ];
      const { resource } = makeResource({
        getConsumableNotes: vi.fn().mockResolvedValue(notes),
      });
      const result = await resource.consumeAll({
        account: "0xaccHex",
        maxNotes: 0,
      });
      expect(result).toEqual({ txId: null, consumed: 0, remaining: 1 });
    });
  });

  describe("swap", () => {
    it("builds swap request and submits", async () => {
      const { resource, inner } = makeResource();
      const result = await resource.swap({
        account: "0xaccHex",
        offer: { token: "0xofferedToken", amount: 10 },
        request: { token: "0xwantedToken", amount: 5 },
        type: "public",
      });
      expect(inner.newSwapTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        BigInt(10),
        expect.anything(),
        BigInt(5),
        "Public",
        "Public" // paybackNoteType defaults to type
      );
      expect(result.txId).toBeDefined();
    });

    it("uses paybackType when provided", async () => {
      const { resource, inner } = makeResource();
      await resource.swap({
        account: "0xaccHex",
        offer: { token: "0xofferedToken", amount: 10 },
        request: { token: "0xwantedToken", amount: 5 },
        type: "public",
        paybackType: "private",
      });
      expect(inner.newSwapTransactionRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        BigInt(10),
        expect.anything(),
        BigInt(5),
        "Public",
        "Private"
      );
    });
  });

  describe("preview", () => {
    it("builds send request for preview", async () => {
      const { resource, inner } = makeResource();
      await resource.preview({
        operation: "send",
        account: "0xacc",
        to: "0xrec",
        token: "0xfau",
        type: "public",
        amount: 1,
      });
      expect(inner.newSendTransactionRequest).toHaveBeenCalled();
      expect(inner.executeForSummary).toHaveBeenCalled();
    });

    it("builds mint request for preview", async () => {
      const { resource, inner } = makeResource();
      await resource.preview({
        operation: "mint",
        account: "0xacc",
        to: "0xrec",
        type: "public",
        amount: 1,
      });
      expect(inner.newMintTransactionRequest).toHaveBeenCalled();
      expect(inner.executeForSummary).toHaveBeenCalled();
    });

    it("builds consume request for preview", async () => {
      const { resource, inner } = makeResource();
      await resource.preview({
        operation: "consume",
        account: "0xacc",
        notes: ["0xnote1"],
      });
      expect(inner.newConsumeTransactionRequest).toHaveBeenCalled();
      expect(inner.executeForSummary).toHaveBeenCalled();
    });

    it("builds swap request for preview", async () => {
      const { resource, inner } = makeResource();
      await resource.preview({
        operation: "swap",
        account: "0xacc",
        offer: { token: "0xoffered", amount: 1 },
        request: { token: "0xwanted", amount: 1 },
        type: "public",
      });
      expect(inner.newSwapTransactionRequest).toHaveBeenCalled();
      expect(inner.executeForSummary).toHaveBeenCalled();
    });

    it("handles custom operation", async () => {
      const { resource, inner } = makeResource();
      const customRequest = { type: "custom" };
      await resource.preview({
        operation: "custom",
        account: "0xacc",
        request: customRequest,
      });
      expect(inner.executeForSummary).toHaveBeenCalledWith(
        expect.anything(),
        customRequest
      );
    });

    it("throws on unknown operation", async () => {
      const { resource } = makeResource();
      await expect(resource.preview({ operation: "unknown" })).rejects.toThrow(
        "Unknown preview operation: unknown"
      );
    });
  });

  describe("execute", () => {
    it("builds request with custom script and submits", async () => {
      const { resource, inner, wasm } = makeResource();
      const result = await resource.execute({
        account: "0xaccHex",
        script: "txScript",
      });
      expect(wasm.TransactionRequestBuilder).toHaveBeenCalled();
      const builder = wasm.TransactionRequestBuilder.mock.results[0].value;
      expect(builder.withCustomScript).toHaveBeenCalledWith("txScript");
      expect(inner.executeTransaction).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
    });

    it("attaches foreign accounts from wrapper objects", async () => {
      const { resource, wasm } = makeResource();
      await resource.execute({
        account: "0xaccHex",
        script: "script",
        foreignAccounts: [{ id: "0xforeignId", storage: "storageReqs" }],
      });
      expect(wasm.ForeignAccount.public).toHaveBeenCalled();
      expect(wasm.ForeignAccountArray).toHaveBeenCalled();
    });

    it("attaches foreign accounts from WASM Account objects (has .id() method)", async () => {
      const { resource, wasm } = makeResource();
      const wasmAccount = {
        id: vi.fn().mockReturnValue({ toString: () => "0xwasmId" }),
      };
      await resource.execute({
        account: "0xaccHex",
        script: "script",
        foreignAccounts: [wasmAccount],
      });
      expect(wasmAccount.id).toHaveBeenCalled();
      expect(wasm.ForeignAccount.public).toHaveBeenCalled();
    });
  });

  describe("executeProgram", () => {
    it("calls inner.executeProgram with resolved accountId", async () => {
      const { resource, inner, wasm } = makeResource();
      const result = await resource.executeProgram({
        account: "0xaccHex",
        script: "program",
      });
      expect(inner.executeProgram).toHaveBeenCalledWith(
        expect.anything(),
        "program",
        expect.anything(), // AdviceInputs instance (new wasm.AdviceInputs())
        expect.anything() // ForeignAccountArray instance (new wasm.ForeignAccountArray())
      );
      expect(result).toBe("programResult");
    });

    it("handles foreign accounts in executeProgram", async () => {
      const { resource, inner, wasm } = makeResource();
      const wasmAccount = {
        id: vi.fn().mockReturnValue({ toString: () => "0xid" }),
      };
      await resource.executeProgram({
        account: "0xaccHex",
        script: "program",
        foreignAccounts: [wasmAccount],
      });
      expect(wasm.ForeignAccount.public).toHaveBeenCalled();
    });
  });

  describe("submit", () => {
    it("resolves account and delegates to #submitOrSubmitWithProver", async () => {
      const { resource, inner } = makeResource();
      const request = { type: "request" };
      const result = await resource.submit("0xaccHex", request);
      expect(inner.executeTransaction).toHaveBeenCalledWith(
        expect.anything(),
        request
      );
      expect(result.txId).toBeDefined();
    });

    it("handles undefined opts (no prover)", async () => {
      const { resource } = makeResource();
      const request = { type: "request" };
      // opts is undefined — tests opts?.prover branch
      const result = await resource.submit("0xaccHex", request, undefined);
      expect(result.txId).toBeDefined();
    });
  });

  describe("executeProgram — wrapper without storage", () => {
    it("creates AccountStorageRequirements when wrapper has no storage", async () => {
      const { resource, wasm } = makeResource();
      // A wrapper object with id property (not a function) but no storage
      const wrapper = { id: "0xforeignHex" }; // isWrapper=true, fa.storage=undefined
      await resource.executeProgram({
        account: "0xaccHex",
        script: "program",
        foreignAccounts: [wrapper],
      });
      expect(wasm.AccountStorageRequirements).toHaveBeenCalled();
    });

    it("uses fa.storage when wrapper has a storage property", async () => {
      const { resource, wasm } = makeResource();
      // A wrapper object with both id and storage
      const wrapper = { id: "0xforeignHex", storage: "customStorageReqs" };
      await resource.executeProgram({
        account: "0xaccHex",
        script: "program",
        foreignAccounts: [wrapper],
      });
      expect(wasm.ForeignAccount.public).toHaveBeenCalledWith(
        expect.anything(),
        "customStorageReqs"
      );
    });
  });

  describe("submit — with prover", () => {
    it("uses provided prover in opts", async () => {
      const prover = { prove: vi.fn() };
      const { resource, inner } = makeResource();
      const request = { type: "request" };
      await resource.submit("0xaccHex", request, { prover });
      expect(inner.proveTransaction).toHaveBeenCalledWith(
        expect.anything(),
        prover
      );
    });
  });

  describe("list", () => {
    it("uses filter.all() when no query", async () => {
      const { resource, inner, wasm } = makeResource();
      inner.getTransactions.mockResolvedValue(["tx1"]);
      const result = await resource.list();
      expect(wasm.TransactionFilter.all).toHaveBeenCalled();
      expect(result).toEqual(["tx1"]);
    });

    it("uses filter.uncommitted() for status='uncommitted'", async () => {
      const { resource, wasm } = makeResource();
      await resource.list({ status: "uncommitted" });
      expect(wasm.TransactionFilter.uncommitted).toHaveBeenCalled();
    });

    it("uses filter.ids() for query.ids", async () => {
      const { resource, wasm } = makeResource();
      await resource.list({ ids: ["0xid1", "0xid2"] });
      expect(wasm.TransactionId.fromHex).toHaveBeenCalledTimes(2);
      expect(wasm.TransactionFilter.ids).toHaveBeenCalled();
    });

    it("uses filter.expiredBefore() for query.expiredBefore", async () => {
      const { resource, wasm } = makeResource();
      await resource.list({ expiredBefore: 12345 });
      expect(wasm.TransactionFilter.expiredBefore).toHaveBeenCalledWith(12345);
    });

    it("falls back to filter.all() for unknown query shape", async () => {
      const { resource, wasm } = makeResource();
      await resource.list({ unknown: "field" });
      expect(wasm.TransactionFilter.all).toHaveBeenCalled();
    });
  });

  describe("waitFor", () => {
    it("uses default 60s timeout when opts.timeout is not provided", async () => {
      const committedStatus = {
        isCommitted: vi.fn().mockReturnValue(true),
        isDiscarded: vi.fn().mockReturnValue(false),
      };
      const tx = {
        transactionStatus: vi.fn().mockReturnValue(committedStatus),
      };
      const { resource } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      // No timeout specified — uses opts?.timeout ?? 60_000 (60 seconds default)
      // But since tx commits on first poll, it returns before timeout fires
      await resource.waitFor("0xtxHex", { interval: 0 });
    });

    it("uses default 5s interval when opts.interval is not provided", async () => {
      const committedStatus = {
        isCommitted: vi.fn().mockReturnValue(true),
        isDiscarded: vi.fn().mockReturnValue(false),
      };
      const tx = {
        transactionStatus: vi.fn().mockReturnValue(committedStatus),
      };
      const { resource } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      // Test that it uses 5_000 default interval (but commits immediately so no wait)
      await resource.waitFor("0xtxHex", { timeout: 5000 });
    });

    it("resolves immediately when tx is committed on first poll", async () => {
      const committedStatus = {
        isCommitted: vi.fn().mockReturnValue(true),
        isDiscarded: vi.fn().mockReturnValue(false),
      };
      const tx = {
        transactionStatus: vi.fn().mockReturnValue(committedStatus),
      };
      const { resource, inner } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      const onProgress = vi.fn();
      await resource.waitFor("0xtxHex", {
        timeout: 5000,
        interval: 10,
        onProgress,
      });
      expect(onProgress).toHaveBeenCalledWith("committed");
    });

    it("throws when tx is discarded", async () => {
      const discardedStatus = {
        isCommitted: vi.fn().mockReturnValue(false),
        isDiscarded: vi.fn().mockReturnValue(true),
      };
      const tx = {
        transactionStatus: vi.fn().mockReturnValue(discardedStatus),
      };
      const { resource } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      await expect(
        resource.waitFor("0xtxHex", { timeout: 5000, interval: 10 })
      ).rejects.toThrow("Transaction rejected");
    });

    it("calls onProgress with 'pending' when no txs returned", async () => {
      const { resource, inner } = makeResource({
        getTransactions: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            {
              transactionStatus: () => ({
                isCommitted: () => true,
                isDiscarded: () => false,
              }),
            },
          ]),
      });
      const onProgress = vi.fn();
      await resource.waitFor("0xtxHex", {
        timeout: 5000,
        interval: 0,
        onProgress,
      });
      expect(onProgress).toHaveBeenCalledWith("pending");
      expect(onProgress).toHaveBeenCalledWith("committed");
    });

    it("calls onProgress with 'submitted' when tx lacks committed status", async () => {
      let pollCount = 0;
      const { resource } = makeResource({
        getTransactions: vi.fn().mockImplementation(() => {
          pollCount++;
          if (pollCount === 1) {
            return Promise.resolve([
              {
                transactionStatus: () => ({
                  isCommitted: () => false,
                  isDiscarded: () => false,
                }),
              },
            ]);
          }
          return Promise.resolve([
            {
              transactionStatus: () => ({
                isCommitted: () => true,
                isDiscarded: () => false,
              }),
            },
          ]);
        }),
      });
      const onProgress = vi.fn();
      await resource.waitFor("0xtxHex", {
        timeout: 5000,
        interval: 0,
        onProgress,
      });
      expect(onProgress).toHaveBeenCalledWith("submitted");
    });

    it("throws timeout when transaction takes too long", async () => {
      const { resource } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([]),
        syncStateWithTimeout: vi.fn().mockResolvedValue(undefined),
      });
      await expect(
        resource.waitFor("0xtxHex", { timeout: 1, interval: 0 })
      ).rejects.toThrow("Transaction confirmation timed out");
    }, 5000);

    it("handles transactionStatus returning undefined (no status method)", async () => {
      let count = 0;
      const { resource } = makeResource({
        getTransactions: vi.fn().mockImplementation(() => {
          count++;
          if (count < 2)
            return Promise.resolve([{ transactionStatus: undefined }]);
          return Promise.resolve([
            {
              transactionStatus: () => ({
                isCommitted: () => true,
                isDiscarded: () => false,
              }),
            },
          ]);
        }),
      });
      await resource.waitFor("0xtxHex", { timeout: 5000, interval: 0 });
    });

    it("resolves TransactionId objects via .toHex()", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const { resource } = makeResource({
        getTransactions: vi
          .fn()
          .mockResolvedValue([{ transactionStatus: () => committedStatus }]),
      });
      const txIdObj = { toHex: vi.fn().mockReturnValue("0xtxHex") };
      await resource.waitFor(txIdObj, { timeout: 5000, interval: 0 });
      expect(txIdObj.toHex).toHaveBeenCalled();
    });

    it("continues polling when syncStateWithTimeout throws", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      let syncCount = 0;
      const { resource } = makeResource({
        syncStateWithTimeout: vi.fn().mockImplementation(() => {
          if (syncCount++ === 0) throw new Error("sync fail");
          return Promise.resolve();
        }),
        getTransactions: vi
          .fn()
          .mockResolvedValue([{ transactionStatus: () => committedStatus }]),
      });
      await resource.waitFor("0xtxHex", { timeout: 5000, interval: 0 });
    });

    it("polls with no timeout when timeout=0", async () => {
      let pollCount = 0;
      const { resource } = makeResource({
        getTransactions: vi.fn().mockImplementation(() => {
          pollCount++;
          if (pollCount >= 2) {
            return Promise.resolve([
              {
                transactionStatus: () => ({
                  isCommitted: () => true,
                  isDiscarded: () => false,
                }),
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      });
      await resource.waitFor("0xtxHex", { timeout: 0, interval: 0 });
      expect(pollCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Gap-fill: uncovered branches ───────────────────────────────────────────

  describe("send — returnNote + waitForConfirmation branch", () => {
    it("calls waitFor after returnNote send when waitForConfirmation=true", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const tx = { transactionStatus: () => committedStatus };
      const { resource, inner } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      const result = await resource.send({
        account: "0xsender",
        to: "0xrecipient",
        token: "0xfaucet",
        type: "public",
        amount: 50,
        returnNote: true,
        waitForConfirmation: true,
        timeout: 5000,
      });
      expect(inner.syncStateWithTimeout).toHaveBeenCalled();
      expect(result.note).toBe("p2idNote");
    });
  });

  describe("mint — waitForConfirmation branch", () => {
    it("waits for confirmation after mint when waitForConfirmation=true", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const tx = { transactionStatus: () => committedStatus };
      const { resource, inner } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      const result = await resource.mint({
        account: "0xfaucet",
        to: "0xrecipient",
        type: "public",
        amount: 500,
        waitForConfirmation: true,
        timeout: 5000,
      });
      expect(inner.syncStateWithTimeout).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
    });
  });

  describe("consume — waitForConfirmation branch", () => {
    it("waits for confirmation after consume when waitForConfirmation=true", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const tx = { transactionStatus: () => committedStatus };
      const { resource, inner } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      const result = await resource.consume({
        account: "0xaccHex",
        notes: ["0xnote1"],
        waitForConfirmation: true,
        timeout: 5000,
      });
      expect(inner.syncStateWithTimeout).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
    });
  });

  describe("consumeAll — waitForConfirmation branch", () => {
    it("waits for confirmation after consumeAll when waitForConfirmation=true", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const tx = { transactionStatus: () => committedStatus };
      const note1 = {
        inputNoteRecord: vi
          .fn()
          .mockReturnValue({ toNote: vi.fn().mockReturnValue("n1") }),
      };
      const { resource, inner } = makeResource({
        getConsumableNotes: vi.fn().mockResolvedValue([note1]),
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      const result = await resource.consumeAll({
        account: "0xaccHex",
        waitForConfirmation: true,
        timeout: 5000,
      });
      expect(inner.syncStateWithTimeout).toHaveBeenCalled();
      expect(result.consumed).toBe(1);
    });
  });

  describe("swap — waitForConfirmation branch", () => {
    it("waits for confirmation after swap when waitForConfirmation=true", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const tx = { transactionStatus: () => committedStatus };
      const { resource, inner } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      await resource.swap({
        account: "0xaccHex",
        offer: { token: "0xofferedToken", amount: 10 },
        request: { token: "0xwantedToken", amount: 5 },
        type: "public",
        waitForConfirmation: true,
        timeout: 5000,
      });
      expect(inner.syncStateWithTimeout).toHaveBeenCalled();
    });
  });

  describe("execute — waitForConfirmation branch", () => {
    it("calls waitFor after execute when waitForConfirmation=true", async () => {
      const committedStatus = {
        isCommitted: () => true,
        isDiscarded: () => false,
      };
      const tx = { transactionStatus: () => committedStatus };
      const { resource, inner } = makeResource({
        getTransactions: vi.fn().mockResolvedValue([tx]),
      });
      const result = await resource.execute({
        account: "0xaccHex",
        script: "script",
        waitForConfirmation: true,
        timeout: 5000,
      });
      expect(inner.syncStateWithTimeout).toHaveBeenCalled();
      expect(result.txId).toBeDefined();
    });
  });

  describe("consume — mixed note types in direct-note path", () => {
    it("resolves non-direct note via #resolveNoteInput when mixed with direct notes", async () => {
      const { resource, inner } = makeResource();
      // A direct note (has id() and assets(), no toNote())
      const directNote = {
        id: vi.fn().mockReturnValue({ toString: () => "id1" }),
        assets: vi.fn(),
      };
      // An InputNoteRecord (has toNote())
      const record = { toNote: vi.fn().mockReturnValue("noteFromRecord") };
      await resource.consume({
        account: "0xaccHex",
        notes: [directNote, record],
      });
      // Should take the NoteAndArgs builder path since at least one is direct
      expect(record.toNote).toHaveBeenCalledOnce();
    });

    it("resolves NoteId in direct-note path via #resolveNoteInput string branch", async () => {
      const { resource, inner } = makeResource();
      const directNote = {
        id: vi.fn().mockReturnValue({ toString: () => "direct" }),
        assets: vi.fn(),
      };
      // A string note ID — should be resolved via #resolveNoteInput
      await resource.consume({
        account: "0xaccHex",
        notes: [directNote, "0xnoteIdString"],
      });
      expect(inner.getInputNote).toHaveBeenCalledWith("0xnoteIdString");
    });

    it("throws when NoteId string not found in direct-note path", async () => {
      const { resource } = makeResource({
        getInputNote: vi.fn().mockResolvedValue(null),
      });
      const directNote = {
        id: vi.fn().mockReturnValue({ toString: () => "direct" }),
        assets: vi.fn(),
      };
      await expect(
        resource.consume({
          account: "0xaccHex",
          notes: [directNote, "0xmissingNote"],
        })
      ).rejects.toThrow("Note not found: 0xmissingNote");
    });

    it("throws in #resolveNoteInput when NoteId object not found in store", async () => {
      const { resource } = makeResource({
        getInputNote: vi.fn().mockResolvedValue(null),
      });
      // A NoteId with constructor.fromHex — should look up in store and throw if missing
      const noteId = {
        toString: vi.fn().mockReturnValue("0xnoteHexFromId"),
        constructor: { fromHex: vi.fn() },
      };
      await expect(
        resource.consume({
          account: "0xaccHex",
          notes: [noteId],
        })
      ).rejects.toThrow("Note not found: 0xnoteHexFromId");
    });
  });
});
