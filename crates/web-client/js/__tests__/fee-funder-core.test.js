import { describe, it, expect, vi } from "vitest";
import { createFundingRuntime } from "../../test/fee-funder-core";

function createFakeSdk() {
  let noteSeq = 0;

  class AccountId {
    constructor(hex) {
      this.hex = hex;
      this.consumed = false;
    }
    static fromHex(hex) {
      return new AccountId(hex);
    }
    toString() {
      if (this.consumed) throw new Error("AccountId handle consumed");
      return this.hex;
    }
  }

  class FungibleAsset {
    constructor(faucetId, amount) {
      faucetId.consumed = true;
      this.faucetHex = faucetId.hex;
      this.amount = amount;
    }
  }

  class NoteAssets {
    constructor(assets) {
      this.assets = assets;
    }
  }

  class NoteAttachment {}

  class NoteArray {
    constructor() {
      this.items = [];
    }
    push(note) {
      this.items.push(note);
    }
  }

  class Note {
    static createP2IDNote(sender, target, assets, noteType) {
      const targetHex = target.hex;
      sender.consumed = true;
      target.consumed = true;
      const id = `note_${++noteSeq}`;
      return {
        targetHex,
        assets,
        noteType,
        id: () => ({ toString: () => id }),
      };
    }
  }

  class TransactionRequestBuilder {
    withOwnOutputNotes(notes) {
      this.notes = notes.items ?? notes;
      return this;
    }
    build() {
      return { ownNotes: this.notes };
    }
  }

  return {
    AccountId,
    FungibleAsset,
    NoteAssets,
    NoteAttachment,
    NoteArray,
    Note,
    NoteType: { Public: "Public" },
    TransactionFilter: { uncommitted: () => "uncommitted" },
    TransactionRequestBuilder,
  };
}

describe("fee-funder-core", () => {
  it("serializes cleanly via Function constructor for browser injection", () => {
    const fn = new Function(`return (${createFundingRuntime.toString()});`)();
    expect(typeof fn).toBe("function");
  });

  it("returns null cleanly when no funder state is configured", async () => {
    const sdk = createFakeSdk();
    const runtime = createFundingRuntime({
      sdk,
      getDefaultClient: () => ({}),
      getFunderState: async () => null,
      proveTransactionWithFallback: async () => ({}),
    });

    expect(await runtime.sendFundingNotes(["0xaaa"])).toBeNull();
    expect(await runtime.fundAccounts(["0xaaa"])).toBeNull();
    expect(await runtime.ensureFunded(["0xaaa"])).toBeNull();
  });

  it("skips funded accounts, batches unique targets, and retries transient failures", async () => {
    const sdk = createFakeSdk();
    const targetNotes = new Map();
    const originalCreate = sdk.Note.createP2IDNote;
    sdk.Note.createP2IDNote = (sender, target, assets, noteType) => {
      const n = originalCreate(sender, target, assets, noteType);
      targetNotes.set(n.id().toString(), n.targetHex);
      return n;
    };

    let uncommittedIds = [];
    let execAttempts = 0;

    const funderClient = {
      syncState: vi.fn(async () => {
        uncommittedIds = [];
      }),
      feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
      executeTransaction: vi.fn(async () => {
        execAttempts++;
        if (execAttempts === 1) {
          throw new Error("stale block");
        }
        return { kind: "funder-exec" };
      }),
      submitProvenTransaction: vi.fn(async () => 42),
      applyTransaction: vi.fn(async (execResult) => {
        expect(execResult.kind).toBe("funder-exec");
        uncommittedIds = ["0xtx_funder"];
        return {
          executedTransaction: () => ({
            id: () => ({ toHex: () => "0xtx_funder" }),
          }),
        };
      }),
      getTransactions: vi.fn(async () =>
        uncommittedIds.map((id) => ({ id: () => ({ toHex: () => id }) }))
      ),
    };

    const balances = new Map([["0xfunded", 500n]]);
    let targetUncommitted = [];
    let consumeSeq = 0;

    const targetClient = {
      feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
      syncState: vi.fn(async () => {
        targetUncommitted = [];
      }),
      getAccount: vi.fn(async (id) => ({
        vault: () => ({
          getBalance: () => balances.get(id.hex) ?? 0n,
        }),
      })),
      getInputNote: vi.fn(async (noteId) => {
        const target = targetNotes.get(noteId);
        return target ? { toNote: () => ({ id: noteId, target }) } : null;
      }),
      newConsumeTransactionRequest: vi.fn(async (notes, accountId) => ({
        notes,
        target: accountId.hex,
      })),
      executeTransaction: vi.fn(async () => ({ kind: "consume-exec" })),
      submitProvenTransaction: vi.fn(async () => 43),
      applyTransaction: vi.fn(async (exec) => {
        const txId = `0xtx_consume_${++consumeSeq}`;
        targetUncommitted = [txId];
        return {
          exec,
          executedTransaction: () => ({ id: () => ({ toHex: () => txId }) }),
        };
      }),
      getTransactions: vi.fn(async () =>
        targetUncommitted.map((id) => ({ id: () => ({ toHex: () => id }) }))
      ),
    };

    const funderState = {
      client: funderClient,
      funderHex: "0xfunder",
      feeFaucetHex: "0xfee",
      queue: Promise.resolve(),
    };

    const runtime = createFundingRuntime({
      sdk,
      getDefaultClient: () => targetClient,
      getFunderState: async () => funderState,
      proveTransactionWithFallback: async () => ({ proven: true }),
      transferNoteFile: async () => false,
      retryDelayMs: 0,
    });

    expect(await runtime.ensureFunded(["0xfunded"])).toBeNull();
    expect(execAttempts).toBe(0);

    const res = await runtime.ensureFunded([
      "0xfunded",
      sdk.AccountId.fromHex("0xnew1"),
      "0xnew2",
      "0xnew1",
    ]);

    expect(res.targetNotes.map((entry) => entry.accountId)).toEqual([
      "0xnew1",
      "0xnew2",
    ]);
    expect(execAttempts).toBe(2);
    expect(targetClient.newConsumeTransactionRequest).toHaveBeenCalledTimes(2);
  });
});
