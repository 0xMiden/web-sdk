// @ts-nocheck
import { test, expect } from "./test-setup";

// The standard well-known note scripts are exposed as static `NoteScript`
// constructors; a script's MAST root (`root().toHex()`) is its stable
// identifier for a given protocol / standards-library version. This guards
// that each single-line constructor is wired to a *distinct* well-known
// script — a copy-paste slip in the bodies would surface here as colliding
// roots — and exercises the newly added 0.16 governance/action notes.
test.describe("well-known note scripts", () => {
  test("the well-known scripts expose well-formed, distinct MAST roots", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => ({
      p2id: sdk.NoteScript.p2id().root().toHex(),
      p2ide: sdk.NoteScript.p2ide().root().toHex(),
      swap: sdk.NoteScript.swap().root().toHex(),
      faucetPolicyAction: sdk.NoteScript.faucetPolicyAction().root().toHex(),
      pauseAction: sdk.NoteScript.pauseAction().root().toHex(),
      ownerAction: sdk.NoteScript.ownerAction().root().toHex(),
      rbacAction: sdk.NoteScript.rbacAction().root().toHex(),
      rbacAgain: sdk.NoteScript.rbacAction().root().toHex(),
    }));

    const keys = [
      "p2id",
      "p2ide",
      "swap",
      "faucetPolicyAction",
      "pauseAction",
      "ownerAction",
      "rbacAction",
    ];
    // Each root is a well-formed 32-byte word hex string.
    for (const key of keys) {
      expect(result[key]).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
    // Deterministic across calls (LazyLock-backed standard script).
    expect(result.rbacAgain).toBe(result.rbacAction);
    // Every constructor is wired to a distinct script — not accidentally aliased.
    const roots = keys.map((k) => result[k]);
    expect(new Set(roots).size).toBe(roots.length);
  });
});
