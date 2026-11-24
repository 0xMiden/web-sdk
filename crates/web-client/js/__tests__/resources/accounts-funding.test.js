import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountsResource } from "../../resources/accounts.js";

const FEE = "0xfee";
const ACC = "0xacc";
const NOTE = "0x".padEnd(66, "a");
const MINT_TX = "0x".padEnd(66, "b");
const CONSUME_TX = "0x".padEnd(66, "c");

function makeWasm() {
  return {
    AccountId: {
      fromHex: vi.fn((hex) => ({ hex, toString: () => hex })),
      fromBech32: vi.fn((b) => ({ bech32: b, toString: () => FEE })),
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
          return { state: () => noteState };
        }),
      },
      transactions: {
        consume: vi.fn().mockResolvedValue({
          txId: { toHex: () => CONSUME_TX },
          result: {},
        }),
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
      if (polls < 2) return null;
      return { state: () => "Committed" };
    });

    const result = await resource.fundAccount(ACC, {
      fetch: fetchFn,
      timeout: 5_000,
      pollInterval: 1,
    });

    expect(result).toEqual({
      noteId: NOTE,
      transactionId: CONSUME_TX,
      balance: 900_000n,
    });
    expect(client.transactions.consume).toHaveBeenCalledWith({
      account: ACC,
      noteIds: [NOTE],
      waitForConfirmation: true,
      timeout: 5_000,
    });
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
    client.notes.get.mockResolvedValue({
      state: () => "ConsumedExternal",
    });

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
