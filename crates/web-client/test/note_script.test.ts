// @ts-nocheck
import { test, expect } from "./test-setup";

// The standard well-known note scripts are exposed as static `NoteScript`
// constructors; a script's MAST root (`root().toHex()`) is its stable on-chain
// identifier. This exercises the exact chain shipped to consumers
// (`NoteScript.burn().root().toHex()`) and guards that each single-line
// constructor is wired to a *distinct* script — a copy-paste slip in the
// bodies would surface here as colliding roots.
test.describe("well-known note scripts", () => {
  test("swap/pswap/mint/burn expose stable, distinct MAST roots", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => ({
      swap: sdk.NoteScript.swap().root().toHex(),
      pswap: sdk.NoteScript.pswap().root().toHex(),
      mint: sdk.NoteScript.mint().root().toHex(),
      burn: sdk.NoteScript.burn().root().toHex(),
      burnAgain: sdk.NoteScript.burn().root().toHex(),
    }));

    // Each root is a well-formed 32-byte word hex string.
    for (const key of ["swap", "pswap", "mint", "burn"]) {
      expect(result[key]).toMatch(/^0x[0-9a-fA-F]{64}$/);
    }
    // Deterministic across calls (LazyLock-backed standard script).
    expect(result.burnAgain).toBe(result.burn);
    // Each constructor is wired to a distinct script — not accidentally aliased.
    const roots = [result.swap, result.pswap, result.mint, result.burn];
    expect(new Set(roots).size).toBe(roots.length);
  });
});
