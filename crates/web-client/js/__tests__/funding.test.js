import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_FAUCET_URLS,
  classifyInputNoteState,
  defaultFaucetUrl,
  fundingInvalid,
  networkFromBech32,
  networkFromEndpoint,
  normalizeFundingOptions,
  requestNoteFromFaucet,
  sleep,
  solvePow,
  withinTimeout,
} from "../funding.js";

describe("normalizeFundingOptions", () => {
  it("applies defaults", () => {
    const opts = normalizeFundingOptions();
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.pollIntervalMs).toBe(5_000);
    expect(opts.amount).toBeNull();
    expect(opts.faucetUrl).toBeNull();
  });

  it("rejects zero amount and out-of-range timers", () => {
    expect(() => normalizeFundingOptions({ amount: 0 })).toThrow(/positive/);
    expect(() => normalizeFundingOptions({ timeout: 0 })).toThrow(/timeout/);
    expect(() => normalizeFundingOptions({ pollInterval: 0 })).toThrow(
      /pollInterval/
    );
    expect(() => normalizeFundingOptions({ timeout: 2_147_483_648 })).toThrow(
      /timeout/
    );
  });

  it("rejects numbers above Number.MAX_SAFE_INTEGER but keeps bigint and string amounts exact", () => {
    expect(() =>
      normalizeFundingOptions({ amount: Number.MAX_SAFE_INTEGER + 2 })
    ).toThrow(/safe integer/);
    expect(normalizeFundingOptions({ amount: "9007199254740993" }).amount).toBe(
      9_007_199_254_740_993n
    );
    expect(
      normalizeFundingOptions({ amount: Number.MAX_SAFE_INTEGER }).amount
    ).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("accepts bigint amounts above Number.MAX_SAFE_INTEGER", () => {
    const opts = normalizeFundingOptions({
      amount: 9_007_199_254_740_993n,
    });
    expect(opts.amount).toBe(9_007_199_254_740_993n);
  });
});

describe("network helpers", () => {
  it("infers network from endpoint and bech32", () => {
    expect(networkFromEndpoint("https://rpc.testnet.miden.io")).toBe("testnet");
    expect(networkFromEndpoint("https://rpc.devnet.miden.io")).toBe("devnet");
    expect(networkFromEndpoint("https://rpc.mainnet.miden.io")).toBe("mainnet");
    expect(networkFromEndpoint("https://rpc.cedar.miden.io")).toBeNull();
    expect(networkFromBech32("mtst1qq...")).toBe("testnet");
    expect(networkFromBech32("mdev1qq...")).toBe("devnet");
    expect(networkFromBech32("mm1qq...")).toBe("mainnet");
  });

  it("defaultFaucetUrl covers testnet and devnet only", () => {
    expect(defaultFaucetUrl("testnet")).toBe(DEFAULT_FAUCET_URLS.testnet);
    expect(defaultFaucetUrl("devnet")).toBe(DEFAULT_FAUCET_URLS.devnet);
    expect(() => defaultFaucetUrl("mainnet")).toThrow(/faucetUrl/);
  });
});

describe("solvePow", () => {
  it("matches the faucet byte order (rust-sdk funding vector)", async () => {
    const nonce = await solvePow("0102ff", (2n ** 64n - 1n) / 8n);
    expect(nonce).toBe(20n);
    expect(await solvePow("0x0102ff", (2n ** 64n - 1n) / 8n)).toBe(20n);
  });

  it("stops searching once its signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(solvePow("0102", 1n, controller.signal)).rejects.toThrow(
      /aborted/
    );
  });

  it("rejects invalid challenges", async () => {
    for (const [challenge, target] of [
      ["00", 0],
      ["", 1],
      ["0", 1],
      ["zz", 1],
    ]) {
      await expect(solvePow(challenge, target)).rejects.toThrow(/invalid/);
    }
  });
});

describe("withinTimeout", () => {
  it("rejects when the work stalls past the deadline", async () => {
    await expect(
      withinTimeout(20, "the funding note", () => new Promise(() => {}))
    ).rejects.toMatchObject({
      code: "FundingTimeout",
      stage: "the funding note",
    });
  });

  it("aborts the work's signal at the deadline so loops stop", async () => {
    let signal;
    await expect(
      withinTimeout(20, "stage", (s) => {
        signal = s;
        return new Promise(() => {});
      })
    ).rejects.toMatchObject({ code: "FundingTimeout" });
    expect(signal.aborted).toBe(true);
  });

  it("returns the work result when it finishes in time", async () => {
    await expect(withinTimeout(1_000, "stage", async () => 42)).resolves.toBe(
      42
    );
  });
});

describe("classifyInputNoteState", () => {
  it("classifies string and numeric states", () => {
    expect(classifyInputNoteState("Committed")).toBe("committed");
    expect(classifyInputNoteState("ProcessingAuthenticated")).toBe(
      "processing"
    );
    expect(classifyInputNoteState("ConsumedExternal")).toBe("consumed");
    expect(classifyInputNoteState(2)).toBe("committed");
    expect(classifyInputNoteState(4)).toBe("processing");
    expect(classifyInputNoteState(6)).toBe("consumed");
  });

  it("uses wasm enum constants when provided", () => {
    // Values chosen outside the numeric fallback so only the enum branch can match.
    const wasm = {
      InputNoteState: {
        Committed: 20,
        ProcessingAuthenticated: 40,
        ProcessingUnauthenticated: 41,
        ConsumedAuthenticatedLocal: 60,
        ConsumedUnauthenticatedLocal: 61,
        ConsumedExternal: 80,
      },
    };
    expect(classifyInputNoteState(20, wasm)).toBe("committed");
    expect(classifyInputNoteState(41, wasm)).toBe("processing");
    expect(classifyInputNoteState(80, wasm)).toBe("consumed");
    expect(classifyInputNoteState(2, wasm)).toBe("committed");
  });

  it("classifies an invalid note", () => {
    expect(classifyInputNoteState("Invalid")).toBe("invalid");
    expect(classifyInputNoteState(3)).toBe("invalid");
    expect(
      classifyInputNoteState(30, { InputNoteState: { Invalid: 30 } })
    ).toBe("invalid");
  });
});

describe("sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects on abort and clears its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "FundingAborted",
    });
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(60_000, controller.signal)).rejects.toMatchObject({
      code: "FundingAborted",
    });
  });
});

describe("requestNoteFromFaucet", () => {
  const faucetHex = "0xfee";
  const accountHex = "0xacc";
  const noteId = "0x".padEnd(66, "1");
  const txId = "0x".padEnd(66, "2");

  const wasm = {
    AccountId: {
      fromHex: (hex) => ({ toString: () => hex }),
      fromBech32: (b) => ({ toString: () => faucetHex }),
    },
  };

  function mockFetch(handlers) {
    return vi.fn(async (url) => {
      const href = typeof url === "string" ? url : url.href;
      for (const handler of handlers) {
        if (handler.match(href)) {
          return handler.response();
        }
      }
      return {
        ok: false,
        status: 404,
        text: async () => `no handler for ${href}`,
        json: async () => ({}),
      };
    });
  }

  it("preserves large integer amounts and endpoint paths", async () => {
    // Above Number.MAX_SAFE_INTEGER: faucets that need this should send a string.
    const baseAmount = 9_007_199_254_740_993n;
    const fetchFn = mockFetch([
      {
        match: (u) => u.includes("/get_metadata"),
        response: () => ({
          ok: true,
          json: async () => ({
            id: faucetHex,
            // Faucet JSON wire fields.
            ["base_amount"]: baseAmount.toString(),
          }),
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
          json: async () => ({ ["note_id"]: noteId, ["tx_id"]: txId }),
        }),
      },
    ]);

    const result = await requestNoteFromFaucet({
      faucetUrl: "http://127.0.0.1:9/api",
      accountIdHex: accountHex,
      feeFaucetIdHex: faucetHex,
      network: "testnet",
      amount: null,
      wasm,
      fetch: fetchFn,
    });

    expect(result.amount).toBe(baseAmount);
    expect(result.noteId).toBe(noteId);
    expect(result.transactionId).toBe(txId);

    const tokensCall = fetchFn.mock.calls
      .map(([u]) => (typeof u === "string" ? u : u.href))
      .find((u) => u.includes("get_tokens"));
    const paths = fetchFn.mock.calls.map(
      ([u]) => new URL(typeof u === "string" ? u : u.href).pathname
    );
    expect(paths).toEqual(["/api/get_metadata", "/api/pow", "/api/get_tokens"]);
    expect(tokensCall).toContain(`asset_amount=${baseAmount.toString()}`);
    expect(tokensCall).toContain("is_private_note=false");
    expect(tokensCall).toContain(`account_id=${accountHex}`);
  });

  it("sends no request once its signal has aborted", async () => {
    const fetchFn = mockFetch([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestNoteFromFaucet({
        faucetUrl: "http://127.0.0.1:9/api",
        accountIdHex: accountHex,
        feeFaucetIdHex: faucetHex,
        network: "testnet",
        amount: null,
        wasm,
        fetch: fetchFn,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "FundingAborted" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an unsafe numeric faucet base_amount", async () => {
    const fetchFn = mockFetch([
      {
        match: (u) => u.includes("/get_metadata"),
        response: () => ({
          ok: true,
          json: async () => ({
            id: faucetHex,
            ["base_amount"]: Number.MAX_SAFE_INTEGER + 2,
          }),
        }),
      },
    ]);
    await expect(
      requestNoteFromFaucet({
        faucetUrl: "http://127.0.0.1:9/api",
        accountIdHex: accountHex,
        feeFaucetIdHex: faucetHex,
        network: "testnet",
        amount: null,
        wasm,
        fetch: fetchFn,
      })
    ).rejects.toThrow(/safe integer/);
  });

  it("accepts a JSON number target that rounds above u64::MAX", async () => {
    const fetchFn = mockFetch([
      {
        match: (u) => u.includes("/get_metadata"),
        response: () => ({
          ok: true,
          json: async () => ({ id: faucetHex, ["base_amount"]: 100 }),
        }),
      },
      {
        match: (u) => u.includes("/pow"),
        response: () => ({
          ok: true,
          // The faucet sends a bare u64; JSON.parse rounds u64::MAX up to 2 ** 64.
          json: async () =>
            JSON.parse('{"challenge":"0102","target":18446744073709551615}'),
        }),
      },
      {
        match: (u) => u.includes("/get_tokens"),
        response: () => ({
          ok: true,
          json: async () => ({ ["note_id"]: noteId, ["tx_id"]: txId }),
        }),
      },
    ]);

    const result = await requestNoteFromFaucet({
      faucetUrl: "http://127.0.0.1:9/api",
      accountIdHex: accountHex,
      feeFaucetIdHex: faucetHex,
      network: "testnet",
      amount: null,
      wasm,
      fetch: fetchFn,
    });
    expect(result.noteId).toBe(noteId);
  });

  it("stops before get_tokens when the faucet asset mismatches", async () => {
    const fetchFn = mockFetch([
      {
        match: (u) => u.includes("/get_metadata"),
        response: () => ({
          ok: true,
          json: async () => ({ id: "0xother", ["base_amount"]: 1_000_000 }),
        }),
      },
    ]);

    await expect(
      requestNoteFromFaucet({
        faucetUrl: "http://127.0.0.1:9/api",
        accountIdHex: accountHex,
        feeFaucetIdHex: faucetHex,
        network: "testnet",
        amount: null,
        wasm,
        fetch: fetchFn,
      })
    ).rejects.toThrow(/fee asset/);

    expect(
      fetchFn.mock.calls.some(([u]) =>
        String(typeof u === "string" ? u : u.href).includes("get_tokens")
      )
    ).toBe(false);
  });

  it("reports HTTP failures without retrying", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        text: async () => "rate limited",
        json: async () => ({}),
      };
    });

    await expect(
      requestNoteFromFaucet({
        faucetUrl: "http://127.0.0.1:9/api",
        accountIdHex: accountHex,
        feeFaucetIdHex: faucetHex,
        network: "testnet",
        amount: null,
        wasm,
        fetch: fetchFn,
      })
    ).rejects.toMatchObject({ code: "FundingHttp", status: 429 });

    expect(calls).toBe(1);
  });

  it("rejects invalid faucet URLs before HTTP", async () => {
    for (const endpoint of [
      "ftp://localhost",
      "http://localhost/?key=value",
      "http://localhost/#fragment",
      "not a URL",
    ]) {
      await expect(
        requestNoteFromFaucet({
          faucetUrl: endpoint,
          accountIdHex: accountHex,
          feeFaucetIdHex: faucetHex,
          network: "testnet",
          amount: null,
          wasm,
          fetch: vi.fn(),
        })
      ).rejects.toThrow(/faucet_url|URL/);
    }
  });

  it("rejects a bech32 faucet id from another network", async () => {
    const fetchFn = mockFetch([
      {
        match: (u) => u.includes("/get_metadata"),
        response: () => ({
          ok: true,
          json: async () => ({
            id: "mdev1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            ["base_amount"]: 1_000_000,
          }),
        }),
      },
    ]);

    await expect(
      requestNoteFromFaucet({
        faucetUrl: "http://127.0.0.1:9/api",
        accountIdHex: accountHex,
        feeFaucetIdHex: faucetHex,
        network: "testnet",
        amount: null,
        wasm,
        fetch: fetchFn,
      })
    ).rejects.toThrow(/different network/);
  });
});

describe("fundingInvalid", () => {
  it("sets FundingInvalid code", () => {
    expect(fundingInvalid("x")).toMatchObject({
      code: "FundingInvalid",
      message: "x",
    });
  });
});
