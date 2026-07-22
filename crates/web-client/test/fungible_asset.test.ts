// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("fungible asset vault entries", () => {
  test("round-trips a vault entry (key + value words) preserving callbacks", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk }) => {
      const faucet = await client.newFaucet(
        sdk.AccountStorageMode.tryFromStr("public"),
        false,
        "DAG Token",
        "DAG",
        8,
        sdk.u64(10000000),
        sdk.AuthScheme.AuthRpoFalcon512
      );
      const faucetId = faucet.id();

      const asset = new sdk.FungibleAsset(faucetId, sdk.u64(10));
      const enabled = asset.withCallbacks(sdk.AssetCallbackFlag.Enabled);
      // The two getters feed straight back into fromVaultEntry — no decoding.
      const disabledRoundTripped = sdk.FungibleAsset.fromVaultEntry(
        asset.vaultKey(),
        asset.intoWord()
      );
      const enabledRoundTripped = sdk.FungibleAsset.fromVaultEntry(
        enabled.vaultKey(),
        enabled.intoWord()
      );
      // The key + scalar amount convenience yields the same asset.
      const enabledFromKey = sdk.FungibleAsset.fromVaultKey(
        enabled.vaultKey(),
        enabled.amount()
      );

      // An amount above the 2^63 - 1 maximum, encoded into the value word, is rejected.
      let oversizedAmountRejected = false;
      try {
        const oversizedValue = new sdk.Word(sdk.u64Array([1n << 63n, 0n, 0n, 0n]));
        sdk.FungibleAsset.fromVaultEntry(enabled.vaultKey(), oversizedValue);
      } catch (_error) {
        oversizedAmountRejected = true;
      }

      return {
        // The constructor never enables callbacks.
        defaultDisabled: asset.callbacks() === sdk.AssetCallbackFlag.Disabled,
        // withCallbacks reflects the requested flag.
        enabledFlag: enabled.callbacks() === sdk.AssetCallbackFlag.Enabled,
        // withCallbacks returns a copy — the original is unchanged.
        originalUntouched: asset.callbacks() === sdk.AssetCallbackFlag.Disabled,
        // The flag is the only thing that changes; faucet and amount survive.
        faucetPreserved: enabled.faucetId().toString() === faucetId.toString(),
        amountPreserved: enabled.amount() === asset.amount(),
        disabledCallbacksPreserved:
          disabledRoundTripped.callbacks() === sdk.AssetCallbackFlag.Disabled,
        disabledVaultKeyPreserved:
          disabledRoundTripped.vaultKey().toHex() === asset.vaultKey().toHex(),
        vaultKeyPreserved:
          enabledRoundTripped.vaultKey().toHex() === enabled.vaultKey().toHex(),
        valuePreserved:
          enabledRoundTripped.intoWord().toHex() === enabled.intoWord().toHex(),
        encodedValue: Array.from(
          enabledRoundTripped.intoWord().toU64s(),
          String
        ),
        roundTrippedCallbacks:
          enabledRoundTripped.callbacks() === sdk.AssetCallbackFlag.Enabled,
        // fromVaultKey(key, amount) matches fromVaultEntry(key, value).
        fromVaultKeyMatches:
          enabledFromKey.vaultKey().toHex() === enabled.vaultKey().toHex() &&
          enabledFromKey.intoWord().toHex() === enabled.intoWord().toHex() &&
          enabledFromKey.callbacks() === sdk.AssetCallbackFlag.Enabled,
        oversizedAmountRejected,
      };
    });

    expect(result.defaultDisabled).toBe(true);
    expect(result.enabledFlag).toBe(true);
    expect(result.originalUntouched).toBe(true);
    expect(result.faucetPreserved).toBe(true);
    expect(result.amountPreserved).toBe(true);
    expect(result.disabledCallbacksPreserved).toBe(true);
    expect(result.disabledVaultKeyPreserved).toBe(true);
    expect(result.vaultKeyPreserved).toBe(true);
    expect(result.valuePreserved).toBe(true);
    expect(result.encodedValue).toEqual(["10", "0", "0", "0"]);
    expect(result.roundTrippedCallbacks).toBe(true);
    expect(result.fromVaultKeyMatches).toBe(true);
    expect(result.oversizedAmountRejected).toBe(true);
  });

  test("rejects an invalid vault entry", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const invalidKey = new sdk.Word(sdk.u64Array([0, 0, 0, 0]));
      const value = new sdk.Word(sdk.u64Array([10, 0, 0, 0]));

      try {
        sdk.FungibleAsset.fromVaultEntry(invalidKey, value);
        return { threw: false, message: "" };
      } catch (error) {
        return { threw: true, message: String(error) };
      }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toContain("Failed to create FungibleAsset");
  });
});
