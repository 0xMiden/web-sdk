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
      // The two getters feed straight back into fromVaultEntry — no decoding.
      const roundTripped = sdk.FungibleAsset.fromVaultEntry(
        asset.vaultKey(),
        asset.intoWord()
      );
      // The key + scalar amount convenience yields the same asset.
      const fromKey = sdk.FungibleAsset.fromVaultKey(
        asset.vaultKey(),
        asset.amount()
      );

      // An amount above the maximum (2^63 - 2^31), encoded into the value word, is rejected.
      let oversizedAmountRejected = false;
      try {
        const oversizedValue = new sdk.Word(
          sdk.u64Array([1n << 63n, 0n, 0n, 0n])
        );
        sdk.FungibleAsset.fromVaultEntry(asset.vaultKey(), oversizedValue);
      } catch (_error) {
        oversizedAmountRejected = true;
      }

      // fromVaultKey's own amount guard rejects an over-maximum scalar amount.
      let oversizedScalarRejected = false;
      try {
        sdk.FungibleAsset.fromVaultKey(asset.vaultKey(), sdk.u64(1n << 63n));
      } catch (_error) {
        oversizedScalarRejected = true;
      }

      // A value word with non-zero upper limbs is not a valid fungible asset value.
      let dirtyValueRejected = false;
      try {
        const dirtyValue = new sdk.Word(sdk.u64Array([10, 1, 0, 0]));
        sdk.FungibleAsset.fromVaultEntry(asset.vaultKey(), dirtyValue);
      } catch (_error) {
        dirtyValueRejected = true;
      }

      return {
        // A faucet without transfer policies issues assets that skip callbacks.
        defaultDisabled: asset.callbacks() === sdk.AssetCallbackFlag.Disabled,
        faucetPreserved:
          roundTripped.faucetId().toString() === faucetId.toString(),
        amountPreserved: roundTripped.amount() === asset.amount(),
        vaultKeyPreserved:
          roundTripped.vaultKey().toHex() === asset.vaultKey().toHex(),
        valuePreserved:
          roundTripped.intoWord().toHex() === asset.intoWord().toHex(),
        encodedValue: Array.from(roundTripped.intoWord().toU64s(), String),
        roundTrippedCallbacks: roundTripped.callbacks() === asset.callbacks(),
        // fromVaultKey(key, amount) matches fromVaultEntry(key, value).
        fromVaultKeyMatches:
          fromKey.vaultKey().toHex() === asset.vaultKey().toHex() &&
          fromKey.intoWord().toHex() === asset.intoWord().toHex() &&
          fromKey.callbacks() === asset.callbacks(),
        oversizedAmountRejected,
        oversizedScalarRejected,
        dirtyValueRejected,
      };
    });

    expect(result.defaultDisabled).toBe(true);
    expect(result.faucetPreserved).toBe(true);
    expect(result.amountPreserved).toBe(true);
    expect(result.vaultKeyPreserved).toBe(true);
    expect(result.valuePreserved).toBe(true);
    expect(result.encodedValue).toEqual(["10", "0", "0", "0"]);
    expect(result.roundTrippedCallbacks).toBe(true);
    expect(result.fromVaultKeyMatches).toBe(true);
    expect(result.oversizedAmountRejected).toBe(true);
    expect(result.oversizedScalarRejected).toBe(true);
    expect(result.dirtyValueRejected).toBe(true);
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
