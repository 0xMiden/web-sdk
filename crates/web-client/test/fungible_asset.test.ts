// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("fungible asset vault keys", () => {
  test("round-trips callback metadata and encodes the amount", async ({
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
      const disabledRoundTripped = sdk.FungibleAsset.fromVaultKey(
        asset.vaultKey(),
        asset.amount()
      );
      const enabledRoundTripped = sdk.FungibleAsset.fromVaultKey(
        enabled.vaultKey(),
        enabled.amount()
      );

      let oversizedAmountRejected = false;
      try {
        sdk.FungibleAsset.fromVaultKey(enabled.vaultKey(), sdk.u64(1n << 63n));
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
    expect(result.oversizedAmountRejected).toBe(true);
  });

  test("rejects an invalid vault key", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const invalidKey = new sdk.Word(sdk.u64Array([0, 0, 0, 0]));

      try {
        sdk.FungibleAsset.fromVaultKey(invalidKey, sdk.u64(10));
        return { threw: false, message: "" };
      } catch (error) {
        return { threw: true, message: String(error) };
      }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toContain("Failed to create FungibleAsset");
  });
});
