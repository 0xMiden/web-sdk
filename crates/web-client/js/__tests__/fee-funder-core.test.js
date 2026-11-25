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
    TransactionId: {
      fromHex: (hex) => ({ toHex: () => hex }),
    },
    TransactionFilter: {
      uncommitted: () => "uncommitted",
      ids: (ids) => ({
        kind: "ids",
        ids: ids.map((id) => id.toHex()),
      }),
    },
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
      getTransactions: vi.fn(async (filter) => {
        if (filter?.kind === "ids") {
          return filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => !uncommittedIds.includes(id),
              isDiscarded: () => false,
            }),
          }));
        }
        return uncommittedIds.map((id) => ({
          id: () => ({ toHex: () => id }),
        }));
      }),
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
      getTransactions: vi.fn(async (filter) => {
        if (filter?.kind === "ids") {
          return filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => !targetUncommitted.includes(id),
              isDiscarded: () => false,
            }),
          }));
        }
        return targetUncommitted.map((id) => ({
          id: () => ({ toHex: () => id }),
        }));
      }),
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

  it("rejects when a submitted transaction is discarded instead of committed", async () => {
    const sdk = createFakeSdk();
    const funderClient = {
      syncState: vi.fn(async () => {}),
      feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
      executeTransaction: vi.fn(async () => ({ kind: "exec" })),
      submitProvenTransaction: vi.fn(async () => 42),
      applyTransaction: vi.fn(async () => ({
        executedTransaction: () => ({
          id: () => ({ toHex: () => "0xtx_discarded" }),
        }),
      })),
      getTransactions: vi.fn(async (filter) => {
        if (filter?.kind === "ids") {
          return filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => false,
              isDiscarded: () => id === "0xtx_discarded",
            }),
          }));
        }
        return [];
      }),
    };

    const runtime = createFundingRuntime({
      sdk,
      getDefaultClient: () => ({}),
      getFunderState: async () => ({
        client: funderClient,
        funderHex: "0xfunder",
        feeFaucetHex: "0xfee",
        queue: Promise.resolve(),
      }),
      proveTransactionWithFallback: async () => ({ proven: true }),
      retryDelayMs: 0,
    });

    await expect(runtime.sendFundingNotes(["0xaaa"])).rejects.toThrow(
      /discarded/i
    );
  });

  it("submits all target consume transactions before polling commit once for all txIds", async () => {
    const sdk = createFakeSdk();
    const events = [];
    const targetNotes = new Map();
    const originalCreate = sdk.Note.createP2IDNote;
    sdk.Note.createP2IDNote = (sender, target, assets, noteType) => {
      const n = originalCreate(sender, target, assets, noteType);
      targetNotes.set(n.id().toString(), n.targetHex);
      return n;
    };

    const funderClient = {
      syncState: vi.fn(async () => {}),
      feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
      executeTransaction: vi.fn(async () => ({ kind: "funder-exec" })),
      submitProvenTransaction: vi.fn(async () => 42),
      applyTransaction: vi.fn(async () => ({
        executedTransaction: () => ({
          id: () => ({ toHex: () => "0xtx_funder" }),
        }),
      })),
      getTransactions: vi.fn(async (filter) => {
        if (filter?.kind === "ids") {
          return filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => true,
              isDiscarded: () => false,
            }),
          }));
        }
        return [];
      }),
    };

    let consumeSeq = 0;
    const targetClient = {
      feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
      syncState: vi.fn(async () => {
        events.push("target:sync");
      }),
      getAccount: vi.fn(async () => ({
        vault: () => ({ getBalance: () => 0n }),
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
        events.push(`target:apply:${txId}`);
        return {
          exec,
          executedTransaction: () => ({ id: () => ({ toHex: () => txId }) }),
        };
      }),
      getTransactions: vi.fn(async (filter) => {
        events.push(`target:getTx:${filter?.kind ?? filter}`);
        if (filter?.kind === "ids") {
          return filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => true,
              isDiscarded: () => false,
            }),
          }));
        }
        return [];
      }),
    };

    const runtime = createFundingRuntime({
      sdk,
      getDefaultClient: () => targetClient,
      getFunderState: async () => ({
        client: funderClient,
        funderHex: "0xfunder",
        feeFaucetHex: "0xfee",
        queue: Promise.resolve(),
      }),
      proveTransactionWithFallback: async () => ({ proven: true }),
      transferNoteFile: async () => false,
      retryDelayMs: 0,
    });

    await runtime.fundAccounts(["0xnew1", "0xnew2"]);

    expect(targetClient.getTransactions).toHaveBeenCalledTimes(1);
    expect(targetClient.getTransactions.mock.calls[0][0]).toEqual({
      kind: "ids",
      ids: ["0xtx_consume_1", "0xtx_consume_2"],
    });
    expect(events).toEqual([
      "target:sync",
      "target:apply:0xtx_consume_1",
      "target:sync",
      "target:apply:0xtx_consume_2",
      "target:sync",
      "target:getTx:ids",
    ]);
  });

  it("throws a timeout error naming pending txIds when a transaction never commits", async () => {
    const sdk = createFakeSdk();
    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const value = now;
      now += 65_000;
      return value;
    });

    try {
      const funderClient = {
        syncState: vi.fn(async () => {}),
        feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
        executeTransaction: vi.fn(async () => ({ kind: "exec" })),
        submitProvenTransaction: vi.fn(async () => 42),
        applyTransaction: vi.fn(async () => ({
          executedTransaction: () => ({
            id: () => ({ toHex: () => "0xtx_pending" }),
          }),
        })),
        getTransactions: vi.fn(async (filter) =>
          filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => false,
              isDiscarded: () => false,
            }),
          }))
        ),
      };

      const runtime = createFundingRuntime({
        sdk,
        getDefaultClient: () => ({}),
        getFunderState: async () => ({
          client: funderClient,
          funderHex: "0xfunder",
          feeFaucetHex: "0xfee",
          queue: Promise.resolve(),
        }),
        proveTransactionWithFallback: async () => ({ proven: true }),
        retryDelayMs: 0,
      });

      await expect(runtime.sendFundingNotes(["0xaaa"])).rejects.toThrow(
        "Timeout waiting for transaction 0xtx_pending"
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("uses sdk default transferNoteFile fallback when deps.transferNoteFile is omitted", async () => {
    const sdk = createFakeSdk();
    sdk.NoteExportFormat = { Full: "Full" };
    sdk.NoteFile = {
      deserialize: vi.fn((bytes) => ({ deserialized: bytes })),
    };

    let now = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      const val = now;
      now += 20_000;
      return val;
    });

    try {
      const funderClient = {
        syncState: vi.fn(async () => {}),
        feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
        executeTransaction: vi.fn(async () => ({ kind: "exec" })),
        submitProvenTransaction: vi.fn(async () => 42),
        applyTransaction: vi.fn(async () => ({
          executedTransaction: () => ({
            id: () => ({ toHex: () => "0xtx_funder" }),
          }),
        })),
        getTransactions: vi.fn(async (filter) =>
          filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => true,
              isDiscarded: () => false,
            }),
          }))
        ),
        exportNoteFile: vi.fn(async () => ({
          serialize: () => new Uint8Array([9, 8, 7]),
        })),
      };

      let imported = false;
      const targetClient = {
        feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
        syncState: vi.fn(async () => {}),
        getInputNote: vi.fn(async () =>
          imported ? { toNote: () => ({ id: "note_1" }) } : null
        ),
        importNoteFile: vi.fn(async () => {
          imported = true;
        }),
        newConsumeTransactionRequest: vi.fn(async () => ({ kind: "consume" })),
        executeTransaction: vi.fn(async () => ({ kind: "consume-exec" })),
        submitProvenTransaction: vi.fn(async () => 43),
        applyTransaction: vi.fn(async () => ({
          executedTransaction: () => ({
            id: () => ({ toHex: () => "0xtx_consume" }),
          }),
        })),
        getTransactions: vi.fn(async (filter) =>
          filter.ids.map((id) => ({
            id: () => ({ toHex: () => id }),
            transactionStatus: () => ({
              isCommitted: () => true,
              isDiscarded: () => false,
            }),
          }))
        ),
      };

      const runtime = createFundingRuntime({
        sdk,
        getDefaultClient: () => targetClient,
        getFunderState: async () => ({
          client: funderClient,
          funderHex: "0xfunder",
          feeFaucetHex: "0xfee",
          queue: Promise.resolve(),
        }),
        proveTransactionWithFallback: async () => ({ proven: true }),
        retryDelayMs: 0,
      });

      await runtime.fundAccounts(["0xaaa"]);
      expect(funderClient.exportNoteFile).toHaveBeenCalledWith(
        "note_1",
        "Full"
      );
      expect(targetClient.importNoteFile).toHaveBeenCalledWith({
        deserialized: new Uint8Array([9, 8, 7]),
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("clones serializable prover instances and invokes prover factories per target in fundAccounts and ensureFunded", async () => {
    const createConsumingProver = (
      payload = "remote|http://localhost:50051"
    ) => ({
      payload,
      consumed: false,
      serialize() {
        if (this.consumed) throw new Error("null pointer passed to rust");
        return this.payload;
      },
    });

    const sdk = {
      ...createFakeSdk(),
      TransactionProver: {
        deserialize: vi.fn((payload) => createConsumingProver(payload)),
      },
    };

    const createMoveSemanticsClient = (feeBalance = 0n) => {
      let noteCounter = 0;
      const committed = new Set();
      return {
        syncState: vi.fn(async () => {}),
        feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
        getAccount: vi.fn(async () => ({
          vault: () => ({ getBalance: () => feeBalance }),
        })),
        getInputNote: vi.fn(async (id) => ({
          toNote: () => ({ id }),
        })),
        newConsumeTransactionRequest: vi.fn(async (notes) => ({
          kind: "consume",
          notes,
        })),
        executeTransaction: vi.fn(async () => ({ kind: "exec" })),
        proveTransaction: vi.fn(async (_execResult, prover) => {
          if (!prover || typeof prover === "function") {
            throw new Error("expected TransactionProver instance, not factory");
          }
          if (prover.consumed) {
            throw new Error("null pointer passed to rust");
          }
          prover.consumed = true;
          return { proven: true };
        }),
        submitProvenTransaction: vi.fn(async () => 1),
        applyTransaction: vi.fn(async () => {
          const txId = `0xtx_${++noteCounter}`;
          committed.add(txId);
          return {
            executedTransaction: () => ({ id: () => ({ toHex: () => txId }) }),
          };
        }),
        getTransactions: vi.fn(async (filter) =>
          (filter.ids ?? [])
            .filter((id) => committed.has(id))
            .map((id) => ({
              id: () => ({ toHex: () => id }),
              transactionStatus: () => ({
                isCommitted: () => true,
                isDiscarded: () => false,
              }),
            }))
        ),
      };
    };

    const funderClient = {
      syncState: vi.fn(async () => {}),
      feeFaucetId: vi.fn(async () => ({ toString: () => "0xfee" })),
      executeTransaction: vi.fn(async () => ({ kind: "funder-exec" })),
      submitProvenTransaction: vi.fn(async () => 1),
      applyTransaction: vi.fn(async () => ({
        executedTransaction: () => ({
          id: () => ({ toHex: () => "0xfund_tx" }),
        }),
      })),
      getTransactions: vi.fn(async (filter) =>
        (filter.ids ?? []).map((id) => ({
          id: () => ({ toHex: () => id }),
          transactionStatus: () => ({
            isCommitted: () => true,
            isDiscarded: () => false,
          }),
        }))
      ),
    };

    const runtime = createFundingRuntime({
      sdk,
      getDefaultClient: () => targetClient,
      getFunderState: async () => ({
        client: funderClient,
        funderHex: "0xfunder",
        feeFaucetHex: "0xfee",
        queue: Promise.resolve(),
      }),
      proveTransactionWithFallback: async (
        client,
        execResult,
        proverOverride
      ) => {
        if (client === funderClient) {
          return { proven: true };
        }
        return await client.proveTransaction(execResult, proverOverride);
      },
      retryDelayMs: 0,
    });

    const targetClient = createMoveSemanticsClient(0n);
    const sharedProver = createConsumingProver("remote|http://localhost:50051");

    const funded = await runtime.fundAccounts(
      ["0xnew1", "0xnew2"],
      targetClient,
      sharedProver
    );
    expect(funded?.noteIds).toHaveLength(2);
    expect(sharedProver.consumed).toBe(false);
    expect(sdk.TransactionProver.deserialize).toHaveBeenCalledTimes(2);

    const ensured = await runtime.ensureFunded(
      ["0xnew3", "0xnew4"],
      targetClient,
      sharedProver
    );
    expect(ensured?.noteIds).toHaveLength(2);
    expect(sharedProver.consumed).toBe(false);
    expect(sdk.TransactionProver.deserialize).toHaveBeenCalledTimes(4);

    const makeProver = vi.fn(() => ({
      consumed: false,
    }));
    const viaFactory = await runtime.fundAccounts(
      ["0xnew5", "0xnew6"],
      targetClient,
      makeProver
    );
    expect(viaFactory?.noteIds).toHaveLength(2);
    expect(makeProver).toHaveBeenCalledTimes(2);
    expect(sdk.TransactionProver.deserialize).toHaveBeenCalledTimes(4);
  });
});
