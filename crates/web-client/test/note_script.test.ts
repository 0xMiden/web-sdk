// @ts-nocheck
import { test, expect } from "./test-setup";

// The standard well-known note scripts are exposed as static `NoteScript`
// constructors; a script's MAST root (`root().toHex()`) is its stable on-chain
// identifier. This exercises the exact chain shipped to consumers
// (`NoteScript.burn().root().toHex()`) and guards that each single-line
// constructor is wired to a *distinct* script — a copy-paste slip in the
// bodies would surface here as colliding roots.
test.describe("well-known note scripts", () => {
  test("the well-known scripts expose well-formed, distinct MAST roots", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => ({
      p2id: sdk.NoteScript.p2id().root().toHex(),
      p2ide: sdk.NoteScript.p2ide().root().toHex(),
      swap: sdk.NoteScript.swap().root().toHex(),
      pswap: sdk.NoteScript.pswap().root().toHex(),
      mint: sdk.NoteScript.mint().root().toHex(),
      burn: sdk.NoteScript.burn().root().toHex(),
      networkAccountConfig: sdk.NoteScript.networkAccountConfig()
        .root()
        .toHex(),
      feeSponsorship: sdk.NoteScript.feeSponsorship().root().toHex(),
      faucetPolicyConfig: sdk.NoteScript.faucetPolicyConfig().root().toHex(),
      pauseConfig: sdk.NoteScript.pauseConfig().root().toHex(),
      ownerConfig: sdk.NoteScript.ownerConfig().root().toHex(),
      rbacConfig: sdk.NoteScript.rbacConfig().root().toHex(),
      constantFeePolicyConfig: sdk.NoteScript.constantFeePolicyConfig()
        .root()
        .toHex(),
      faucetMetadataConfig: sdk.NoteScript.faucetMetadataConfig()
        .root()
        .toHex(),
      minBurnAmountConfig: sdk.NoteScript.minBurnAmountConfig().root().toHex(),
      allowlistConfig: sdk.NoteScript.allowlistConfig().root().toHex(),
      blocklistConfig: sdk.NoteScript.blocklistConfig().root().toHex(),
      upgrade: sdk.NoteScript.upgrade().root().toHex(),
      txFee: sdk.NoteScript.txFee().root().toHex(),
      burnAgain: sdk.NoteScript.burn().root().toHex(),
      rbacConfigAgain: sdk.NoteScript.rbacConfig().root().toHex(),
    }));

    const keys = [
      "p2id",
      "p2ide",
      "swap",
      "pswap",
      "mint",
      "burn",
      "networkAccountConfig",
      "feeSponsorship",
      "faucetPolicyConfig",
      "pauseConfig",
      "ownerConfig",
      "rbacConfig",
      "constantFeePolicyConfig",
      "faucetMetadataConfig",
      "minBurnAmountConfig",
      "allowlistConfig",
      "blocklistConfig",
      "upgrade",
      "txFee",
    ];
    // Each root is a well-formed 32-byte word hex string.
    for (const key of keys) {
      expect(result[key]).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
    // Deterministic across calls (LazyLock-backed standard script).
    expect(result.burnAgain).toBe(result.burn);
    expect(result.rbacConfigAgain).toBe(result.rbacConfig);
    // Every constructor is wired to a distinct script — not accidentally aliased.
    const roots = keys.map((key) => result[key]);
    expect(new Set(roots).size).toBe(roots.length);
  });
});
