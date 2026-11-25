import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountsResource } from "../../resources/accounts.js";

const FEE = "0xfee";
const ACC = "0xacc";
const NOTE = "0x".padEnd(66, "a");
const MINT_TX = "0x".padEnd(66, "b");
const CONSUME_TX = "0x".padEnd(66, "c");
const P2ID_ROOT = "0xp2id";
const OTHER_ROOT = "0xother";

function noteRecord(state, root = P2ID_ROOT) {
  return {
    state: () => state,
    details: () => ({
      recipient: () => ({
        script: () => ({ root: () => ({ toHex: () => root }) }),
      }),
    }),
  };
}

function makeWasm() {
  return {
    AccountId: {
      fromHex: vi.fn((hex) => ({ hex, toString: () => hex })),
      fromBech32: vi.fn((b) => ({ bech32: b, toString: () => FEE })),
    },
    NoteScript: {
      p2id: () => ({ root: () => ({ toHex: () => P2ID_ROOT }) }),
      p2ide: () => ({ root: () => ({ toHex: () => "0xp2ide" }) }),
    },
    InputNoteState: {
      Committed: "Committed",
      ProcessingAuthenticated: "ProcessingAuthenticated",
      ConsumedExternal: "ConsumedExternal",
    },
  };
}

function makeResource({ inner, client, wasm }) {
  const getWasm = vi.fn().mockResolvedValue(wasm);
  return new AccountsResource(inner, getWasm, client);
}

describe("AccountsResource.requestFundingNote / fundAccount", () => {
  let wasm;
  let noteState;

  beforeEach(() => {
    wasm = makeWasm();
    noteState = "Expected";
  });

  function setup(fetchHandlers) {
    const fetchFn = vi.fn(async (url) => {
      const href = typeof url === "string" ? url : url.href;
      for (const h of fetchHandlers) {
        if (h.match(href)) return h.response();
      }
      return {
        ok: false,
        status: 404,
        text: async () => href,
        json: async () => ({}),
      };
    });

    const inner = {
      getAccount: vi.fn().mockResolvedValue({ id: () => ACC }),
      accountReader: vi.fn().mockResolvedValue({
        getBalance: vi.fn().mockResolvedValue(900_000n),
        free: vi.fn(),
      }),
    };

    const client = {
      assertNotTerminated: vi.fn(),
      syncChain: vi.fn().mockResolvedValue(undefined),
      feeFaucetId: vi.fn().mockResolvedValue({ toString: () => FEE }),
      endpoint: vi.fn().mockReturnValue("https://rpc.testnet.miden.io"),
      notes: {
        get: vi.fn(async () => {
          if (noteState === null) return null;
          return noteRecord(noteState);
        }),
      },
      transactions: {
        consume: vi.fn().mockResolvedValue({
          txId: { toHex: () => CONSUME_TX },
          result: {},
        }),
        waitFor: vi.fn().mockResolvedValue(undefined),
      },
    };

    const resource = makeResource({ inner, client, wasm });
    return { resource, inner, client, fetchFn };
  }

  const happyFetch = [
    {
      match: (u) => u.includes("/get_metadata"),
      response: () => ({
        ok: true,
        json: async () => ({ id: FEE, ["base_amount"]: 1_000_000 }),
      }),
    },
    {
      match: (u) => u.includes("/pow"),
      response: () => ({
        ok: true,
        json: async () => ({
          challenge: "0102",
          target: "18446744073709551615",
        }),
      }),
    },
    {
      match: (u) => u.includes("/get_tokens"),
      response: () => ({
        ok: true,
        json: async () => ({ ["note_id"]: NOTE, ["tx_id"]: MINT_TX }),
      }),
    },
  ];

  it("requestFundingNote returns the faucet receipt", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    const receipt = await resource.requestFundingNote(ACC, {
      fetch: fetchFn,
      timeout: 5_000,
    });
    expect(receipt).toEqual({
      noteId: NOTE,
      transactionId: MINT_TX,
      faucetId: FEE,
      amount: 1_000_000n,
    });
    expect(client.syncChain).toHaveBeenCalled();
    expect(client.feeFaucetId).toHaveBeenCalled();
  });

  it("requestFundingNote requires faucetUrl outside testnet/devnet", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    client.endpoint.mockReturnValue("https://rpc.mainnet.miden.io");
    await expect(
      resource.requestFundingNote(ACC, { fetch: fetchFn, timeout: 5_000 })
    ).rejects.toThrow(/faucetUrl/);
  });

  it("fundAccount waits for the note, consumes it, and returns the balance", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    let polls = 0;
    client.notes.get.mockImplementation(async () => {
      polls += 1;
      return polls < 3 ? null : noteRecord("Committed");
    });
    client.transactions.consume.mockImplementation(async () => {
      if (polls < 3) throw new Error("consumed before the note committed");
      return { txId: { toHex: () => CONSUME_TX }, result: {} };
    });

    const result = await resource.fundAccount(ACC, {
      fetch: fetchFn,
      timeout: 5_000,
      pollInterval: 1,
    });

    expect(polls).toBe(3);
    expect(result).toEqual({
      noteId: NOTE,
      transactionId: CONSUME_TX,
      balance: 900_000n,
    });
    expect(client.transactions.consume).toHaveBeenCalledWith({
      account: ACC,
      notes: [NOTE],
    });
    expect(client.transactions.waitFor).toHaveBeenCalledWith(CONSUME_TX, {
      timeout: 5_000,
    });
  });

  it("fundAccount never consumes a note that is not a standard payment", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    client.notes.get.mockResolvedValue(noteRecord("Committed", OTHER_ROOT));

    await expect(
      resource.fundAccount(ACC, {
        fetch: fetchFn,
        timeout: 5_000,
        pollInterval: 1,
      })
    ).rejects.toMatchObject({
      code: "FundingAfterRequest",
      noteId: NOTE,
      sourceCode: "FundingInvalid",
    });
    expect(client.transactions.consume).not.toHaveBeenCalled();
  });

  it("fundAccount keeps the consumption transaction id when confirmation times out", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    client.notes.get.mockResolvedValue(noteRecord("Committed"));
    client.transactions.waitFor.mockRejectedValue(new Error("timed out"));

    await expect(
      resource.fundAccount(ACC, {
        fetch: fetchFn,
        timeout: 5_000,
        pollInterval: 1,
      })
    ).rejects.toMatchObject({
      code: "FundingAfterRequest",
      noteId: NOTE,
      transactionId: CONSUME_TX,
    });
  });

  it("fundAccount keeps the transaction id of a consume that fails after submission", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    client.notes.get.mockResolvedValue(noteRecord("Committed"));
    client.transactions.consume.mockRejectedValue(
      Object.assign(new Error("apply failed"), { transactionId: CONSUME_TX })
    );

    await expect(
      resource.fundAccount(ACC, {
        fetch: fetchFn,
        timeout: 5_000,
        pollInterval: 1,
      })
    ).rejects.toMatchObject({
      code: "FundingAfterRequest",
      noteId: NOTE,
      transactionId: CONSUME_TX,
    });
  });

  it("fundAccount frees the account wrapper it only used for the tracked check", async () => {
    const { resource, inner, client, fetchFn } = setup(happyFetch);
    const free = vi.fn();
    inner.getAccount.mockResolvedValue({ free });
    client.notes.get.mockResolvedValue(noteRecord("Committed"));

    await resource.fundAccount(ACC, {
      fetch: fetchFn,
      timeout: 5_000,
      pollInterval: 1,
    });
    expect(free).toHaveBeenCalledTimes(1);
  });

  it("fundAccount clears the poll timer when the note wait times out first", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    client.notes.get.mockResolvedValue(null);
    const created = [];
    const cleared = new Set();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const setSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn, ms, ...args) => {
        const handle = realSet(fn, ms, ...args);
        if (ms === 600_000) created.push(handle);
        return handle;
      });
    const clearSpy = vi
      .spyOn(globalThis, "clearTimeout")
      .mockImplementation((handle) => {
        cleared.add(handle);
        return realClear(handle);
      });
    try {
      await expect(
        resource.fundAccount(ACC, {
          fetch: fetchFn,
          timeout: 200,
          pollInterval: 600_000,
        })
      ).rejects.toMatchObject({ code: "FundingAfterRequest" });
      expect(created).toHaveLength(1);
      expect(cleared.has(created[0])).toBe(true);
    } finally {
      created.forEach((handle) => realClear(handle));
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("fundAccount stops syncing once the note wait times out", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    client.notes.get.mockResolvedValue(null);

    await expect(
      resource.fundAccount(ACC, {
        fetch: fetchFn,
        timeout: 50,
        pollInterval: 5,
      })
    ).rejects.toMatchObject({
      code: "FundingAfterRequest",
      sourceCode: "FundingTimeout",
    });
    const syncs = client.syncChain.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.syncChain.mock.calls.length).toBe(syncs);
  });

  it("fundAccount rejects an untracked account before calling the faucet", async () => {
    const { resource, inner, fetchFn } = setup(happyFetch);
    inner.getAccount.mockResolvedValue(null);
    await expect(
      resource.fundAccount(ACC, { fetch: fetchFn, timeout: 5_000 })
    ).rejects.toThrow(/not tracked/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fundAccount wraps post-mint failures with the note id", async () => {
    const { resource, client, fetchFn } = setup(happyFetch);
    client.notes.get.mockResolvedValue(noteRecord("ConsumedExternal"));

    await expect(
      resource.fundAccount(ACC, {
        fetch: fetchFn,
        timeout: 5_000,
        pollInterval: 1,
      })
    ).rejects.toMatchObject({
      code: "FundingAfterRequest",
      noteId: NOTE,
    });
  });
});
