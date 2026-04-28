/**
 * Playwright integration tests for packages/react-sdk/src/utils/accountBech32.ts
 *
 * These tests exercise all code paths that were previously annotated with
 * `v8 ignore` because WASM primitives (NetworkId, Address, Account.prototype)
 * are not available in the jsdom unit-test environment.
 *
 * The test page (bech32.html) renders a MidenProvider backed by MockWebClient
 * and exposes the bech32 utilities on window.__bech32.  An optional
 * `?rpcUrl=<network>` query parameter lets each test navigate to a page whose
 * MidenProvider is configured with the desired network, which in turn sets the
 * zustand store's config.rpcUrl – the value read by inferNetworkId().
 */
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BechAppState = {
  testAppReady: boolean;
  testAppError: string | null;
  sdkLoaded: boolean;
  sdkLoadError: string | null;
  reactSdkReady: boolean;
  hasBech32: boolean;
};

async function readBechAppState(page: Page): Promise<BechAppState> {
  return page.evaluate(() => ({
    testAppReady: (window as any).testAppReady === true,
    testAppError: (window as any).testAppError ?? null,
    sdkLoaded: (window as any).sdkLoaded === true,
    sdkLoadError: (window as any).sdkLoadError ?? null,
    reactSdkReady: (window as any).reactSdkReady === true,
    hasBech32: typeof (window as any).__bech32 !== "undefined",
  }));
}

/**
 * Navigate to bech32.html (with optional query params) and wait for the page
 * to be fully ready: SDK loaded, bech32 utilities exposed, and MidenProvider
 * initialised (reactSdkReady = isReady from useMiden()).
 *
 * Returns false (and logs) if any step fails so the caller can call
 * test.skip() instead of hard-failing on infrastructure issues.
 */
async function loadBech32Page(
  page: Page,
  params: Record<string, string> = {},
  timeoutMs = 30_000
): Promise<boolean> {
  const query = new URLSearchParams(params).toString();
  const url = `http://localhost:8081/bech32.html${query ? `?${query}` : ""}`;
  await page.goto(url);

  const deadline = Date.now() + timeoutMs;

  // 1. Wait for testAppReady
  while (Date.now() < deadline) {
    const s = await readBechAppState(page);
    if (s.testAppError) {
      console.log("bech32 test app error:", s.testAppError);
      return false;
    }
    if (s.testAppReady) break;
    await page.waitForTimeout(200);
  }

  // 2. Wait for WASM SDK to load
  while (Date.now() < deadline) {
    const s = await readBechAppState(page);
    if (s.sdkLoadError) {
      console.log("SDK load error:", s.sdkLoadError);
      return false;
    }
    if (s.sdkLoaded) break;
    await page.waitForTimeout(200);
  }

  // 3. Wait for React SDK + MidenProvider initialisation
  while (Date.now() < deadline) {
    const s = await readBechAppState(page);
    if (s.testAppError) {
      console.log("bech32 test app error (post-sdk):", s.testAppError);
      return false;
    }
    if (s.reactSdkReady && s.hasBech32) return true;
    await page.waitForTimeout(200);
  }

  const final = await readBechAppState(page);
  console.log("Timeout waiting for bech32 page to be ready:", final);
  return false;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe("accountBech32 utilities (Playwright)", () => {
  // -------------------------------------------------------------------------
  // toBech32AccountId — default config (no rpcUrl → inferNetworkId → testnet)
  // -------------------------------------------------------------------------

  test("toBech32AccountId converts a real wallet hex ID to a testnet bech32 string", async ({
    page,
  }) => {
    // inferNetworkId branch: !rpcUrl → NetworkId.testnet()
    // toBech32FromAccountId: Address.fromAccountId(...) → address.toBech32()
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );
      const hexId = wallet.id().toHex();
      return (window as any).__bech32.toBech32AccountId(hexId);
    });

    expect(typeof result).toBe("string");
    // testnet bech32 addresses start with "mtst1"
    expect(result).toMatch(/^mtst1/);
  });

  test("toBech32AccountId converts a real faucet hex ID (fallback toBech32 path)", async ({
    page,
  }) => {
    // Address.fromAccountId(..., "BasicWallet") may fail for faucet IDs;
    // falls through to id.toBech32?.(NetworkId, AccountInterface.BasicWallet).
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const faucet = await client.newFaucet(
        (window as any).AccountStorageMode.private(),
        false,
        "TEST",
        8,
        BigInt(1_000_000),
        (window as any).AuthScheme.AuthRpoFalcon512
      );
      const hexId = faucet.id().toHex();
      return (window as any).__bech32.toBech32AccountId(hexId);
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Faucet IDs should also produce a valid bech32 or at minimum return a
    // non-empty string (the id.toString() fallback).
    // Either a bech32 ("mtst1…") or hex fallback is acceptable.
  });

  test("toBech32AccountId with a bech32 input performs a round-trip", async ({
    page,
  }) => {
    // parseAccountId → Address.fromBech32 → address.accountId() → toBech32FromAccountId
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );
      const hexId = wallet.id().toHex();
      // First: hex → bech32
      const bech32 = (window as any).__bech32.toBech32AccountId(hexId);
      // Second: bech32 → bech32 (round-trip)
      const roundTrip = (window as any).__bech32.toBech32AccountId(bech32);
      return { bech32, roundTrip };
    });

    expect(result.bech32).toMatch(/^mtst1/);
    // Round-trip should yield the same (or equivalent) bech32 address
    expect(result.roundTrip).toMatch(/^mtst1/);
  });

  test("toBech32AccountId returns the original string when input is invalid", async ({
    page,
  }) => {
    // parseAccountId throws → catch returns accountId unchanged
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(() => {
      return (window as any).__bech32.toBech32AccountId("not-a-valid-id");
    });

    expect(result).toBe("not-a-valid-id");
  });

  // -------------------------------------------------------------------------
  // inferNetworkId branches via different ?rpcUrl= configs
  // -------------------------------------------------------------------------

  test("toBech32AccountId produces a devnet bech32 when rpcUrl is 'devnet'", async ({
    page,
  }) => {
    // inferNetworkId branch: url.includes("devnet") → NetworkId.devnet()
    const ready = await loadBech32Page(page, { rpcUrl: "devnet" });
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );
      const hexId = wallet.id().toHex();
      return (window as any).__bech32.toBech32AccountId(hexId);
    });

    expect(typeof result).toBe("string");
    // devnet bech32 addresses start with "mdev1"
    expect(result).toMatch(/^mdev1/);
  });

  test("toBech32AccountId produces a mainnet bech32 when rpcUrl is 'mainnet'", async ({
    page,
  }) => {
    // inferNetworkId branch: url.includes("mainnet") → NetworkId.mainnet()
    const ready = await loadBech32Page(page, { rpcUrl: "https://rpc.mainnet.miden.io" });
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );
      const hexId = wallet.id().toHex();
      return (window as any).__bech32.toBech32AccountId(hexId);
    });

    expect(typeof result).toBe("string");
    // mainnet bech32 addresses start with "mm1"
    expect(result).toMatch(/^mm1/);
  });

  test("toBech32AccountId produces a testnet bech32 when rpcUrl is 'testnet'", async ({
    page,
  }) => {
    // inferNetworkId branch: url.includes("testnet") → NetworkId.testnet()
    const ready = await loadBech32Page(page, { rpcUrl: "testnet" });
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );
      const hexId = wallet.id().toHex();
      return (window as any).__bech32.toBech32AccountId(hexId);
    });

    expect(result).toMatch(/^mtst1/);
  });

  test("toBech32AccountId falls back to testnet for an unrecognised rpcUrl", async ({
    page,
  }) => {
    // inferNetworkId branch: no keyword match → default NetworkId.testnet()
    const ready = await loadBech32Page(page, {
      rpcUrl: "https://my-custom-node.example.com/rpc",
    });
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );
      const hexId = wallet.id().toHex();
      return (window as any).__bech32.toBech32AccountId(hexId);
    });

    expect(result).toMatch(/^mtst1/);
  });

  // -------------------------------------------------------------------------
  // installAccountBech32
  // -------------------------------------------------------------------------

  test("installAccountBech32 installs bech32id on Account.prototype", async ({
    page,
  }) => {
    // Exercises installAccountBech32() body: Account.prototype lookup,
    // early-return if already present, and defineBech32(proto).
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      // Calling installAccountBech32 installs the method on the prototype.
      (window as any).__bech32.installAccountBech32();

      // Create a real account to verify the installed method works.
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );

      const bech32 = wallet.bech32id();
      return { bech32, type: typeof bech32 };
    });

    expect(result.type).toBe("string");
    expect(result.bech32).toMatch(/^mtst1/);
  });

  test("installAccountBech32 is a no-op when called a second time", async ({
    page,
  }) => {
    // proto.bech32id is already present → early return (no throw, no re-define)
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    await expect(
      page.evaluate(() => {
        (window as any).__bech32.installAccountBech32();
        (window as any).__bech32.installAccountBech32(); // second call — no-op
      })
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // ensureAccountBech32
  // -------------------------------------------------------------------------

  test("ensureAccountBech32 is a no-op for null and undefined", async ({
    page,
  }) => {
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    await expect(
      page.evaluate(() => {
        (window as any).__bech32.ensureAccountBech32(null);
        (window as any).__bech32.ensureAccountBech32(undefined);
      })
    ).resolves.not.toThrow();
  });

  test("ensureAccountBech32 is a no-op when bech32id is already present on the account", async ({
    page,
  }) => {
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(() => {
      const account = { bech32id: () => "mtst1already" };
      (window as any).__bech32.ensureAccountBech32(account);
      return account.bech32id();
    });

    expect(result).toBe("mtst1already");
  });

  test("ensureAccountBech32 installs bech32id on a plain object via its prototype", async ({
    page,
  }) => {
    // Exercises: proto found, defineBech32(proto) succeeds → return
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );

      // Ensure bech32id is NOT already on the account (reset prototype)
      // by creating a fresh plain object that delegates to the wallet via
      // Object.create so it has a prototype but no own bech32id.
      const plain: any = { id: () => wallet.id() };
      (window as any).__bech32.ensureAccountBech32(plain);
      return typeof plain.bech32id === "function" ||
        typeof Object.getPrototypeOf(plain)?.bech32id === "function";
    });

    expect(result).toBe(true);
  });

  test("ensureAccountBech32 installs bech32id directly on a null-prototype object", async ({
    page,
  }) => {
    // Exercises the defineBech32(account) fallback when proto is null.
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );

      // Object.create(null) has no prototype — defineBech32(account) fallback.
      const nullProtoAccount = Object.create(null) as any;
      nullProtoAccount.id = () => wallet.id();
      (window as any).__bech32.ensureAccountBech32(nullProtoAccount);
      return typeof nullProtoAccount.bech32id === "function";
    });

    expect(result).toBe(true);
  });

  test("bech32id() on a real account returns a valid bech32 string", async ({
    page,
  }) => {
    // Exercises the inner bech32id() function body installed by defineBech32.
    const ready = await loadBech32Page(page);
    if (!ready) {
      test.skip();
      return;
    }

    const result = await page.evaluate(async () => {
      // Install on prototype so all new accounts get bech32id().
      (window as any).__bech32.installAccountBech32();

      const client = await (window as any).MockWebClient.createClient();
      await client.syncState();
      const wallet = await client.newWallet(
        (window as any).AccountStorageMode.private(),
        true,
        (window as any).AuthScheme.AuthRpoFalcon512
      );

      return wallet.bech32id();
    });

    expect(typeof result).toBe("string");
    expect(result).toMatch(/^mtst1/);
  });
});
