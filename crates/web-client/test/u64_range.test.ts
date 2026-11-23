// @ts-nocheck
import { test, expect } from "./test-setup";

// U64 ARGUMENT RANGE
// =======================================================================================================
//
// A BigInt argument outside 0..2^64 must throw a catchable error on both builds. The browser used to
// reduce it modulo 2^64 and Node aborted the process. See issue #466.

test.describe("u64 argument range", () => {
  test("out-of-range BigInt arguments throw and in-range ones are unchanged", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const faucetId = sdk.AccountId.fromHex(
        "0x4cbdcaffe75f0a317482224dae6436"
      );
      const attempt = (build) => {
        try {
          build();
          return "no error";
        } catch (error) {
          return String(error?.message ?? error);
        }
      };

      const tooBig = 2n ** 64n;
      const wraps = 2n ** 64n + 5n;
      return {
        feltNegative: attempt(() => new sdk.Felt(-1n)),
        feltTooBig: attempt(() => new sdk.Felt(tooBig)),
        feltWraps: attempt(() => new sdk.Felt(wraps)),
        assetWraps: attempt(() => new sdk.FungibleAsset(faucetId, wraps)),
        assetNegative: attempt(() => new sdk.FungibleAsset(faucetId, -1n)),
        feltInRange: new sdk.Felt(5n).asInt().toString(),
        assetInRange: new sdk.FungibleAsset(faucetId, 10n).amount().toString(),
      };
    });

    for (const key of [
      "feltNegative",
      "feltTooBig",
      "feltWraps",
      "assetWraps",
      "assetNegative",
    ]) {
      expect(result[key], key).toContain("outside the u64 range");
    }
    expect(result.feltInRange).toBe("5");
    expect(result.assetInRange).toBe("10");
  });

  // A Number must be rejected without throwing through the Rust frames: an exception there skips the
  // destructors, so the call never settles and the borrows it holds are never released.
  test("a Number argument throws and leaves the client and its arguments usable", async ({
    run,
  }, testInfo) => {
    const result = await run(async ({ client, sdk }) => {
      const settle = (call) =>
        Promise.race([
          Promise.resolve()
            .then(call)
            .then(
              () => "no error",
              (error) => String(error?.message ?? error)
            ),
          new Promise((resolve) =>
            setTimeout(() => resolve("timeout"), 10_000)
          ),
        ]);
      const id = sdk.AccountId.fromHex("0x4cbdcaffe75f0a317482224dae6436");

      const sendResult = await settle(() =>
        client.newSendTransactionRequest(
          id,
          id,
          id,
          sdk.NoteType.Private,
          5,
          null,
          null
        )
      );
      const heightResult = await settle(() => client.getSyncHeight());
      let assetError = "no error";
      try {
        new sdk.FungibleAsset(id, 5);
      } catch (error) {
        assetError = String(error?.message ?? error);
      }
      let freed = "skipped";
      if (typeof id.free === "function") {
        try {
          id.free();
          freed = "freed";
        } catch (error) {
          freed = String(error?.message ?? error);
        }
      }
      return {
        sendResult,
        heightResult,
        assetError,
        freed,
        felt: new sdk.Felt(2n ** 63n).asInt().toString(),
      };
    });

    expect(result.sendResult, "sendResult").not.toBe("timeout");
    expect(result.heightResult, "heightResult").toBe("no error");
    expect(result.sendResult, "sendResult").not.toBe("no error");
    expect(result.assetError, "assetError").not.toBe("no error");
    // napi rejects a Number before the Rust body runs, so only the browser build reaches the converter.
    if (testInfo.project.name !== "nodejs") {
      expect(result.sendResult, "sendResult").toContain("must be a BigInt");
      expect(result.assetError, "assetError").toContain("must be a BigInt");
      expect(result.freed, "freed").toBe("freed");
    }
    expect(result.felt).toBe("9223372036854775808");
  });
});
