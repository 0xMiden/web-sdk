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

  test("out-of-range BigInt arguments to the other changed methods throw or fail verification", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      const attempt = (build) => {
        try {
          build();
          return "no error";
        } catch (error) {
          return String(error?.message ?? error);
        }
      };
      const tooBig = 2n ** 64n;
      const endpoint = "http://127.0.0.1:9";
      const path = sdk.NoteInclusionProof.mockAtBlock(0).notePath();
      const node = new sdk.Word(sdk.u64Array([0, 0, 0, 0]));
      const scriptRoot = sdk.NoteScript.p2id().root();

      return {
        // A depth-0 path whose root is the node verifies at index 0, which 2^64 used to reduce to.
        merkleVerifyWraps: path.verify(tooBig, node, node),
        computeRootWraps: attempt(() => path.computeRoot(tooBig, node)),
        proverWraps: attempt(() =>
          sdk.TransactionProver.newRemoteProver(endpoint, tooBig)
        ),
        proverNegative: attempt(() =>
          sdk.TransactionProver.newRemoteProver(endpoint, -1n)
        ),
        statusWraps: attempt(() => sdk.TransactionStatus.committed(1, tooBig)),
        feeWraps: attempt(() => new sdk.NoteScriptFee(scriptRoot, tooBig)),
        merkleVerify: path.verify(0n, node, node),
        merkleDepth: path.depth(),
        computeRootIsNode: path.computeRoot(0n, node).toHex() === node.toHex(),
        prover: sdk.TransactionProver.newRemoteProver(endpoint, 5n).serialize(),
        proverNoTimeout: sdk.TransactionProver.newRemoteProver(
          endpoint,
          null
        ).serialize(),
        statusTimestamp: String(
          sdk.TransactionStatus.committed(1, 5n).getCommitTimestamp()
        ),
        feeAmount: String(new sdk.NoteScriptFee(scriptRoot, 7n).amount),
      };
    });

    expect(result.merkleVerifyWraps, "merkleVerifyWraps").toBe(false);
    for (const key of [
      "computeRootWraps",
      "proverWraps",
      "proverNegative",
      "statusWraps",
      "feeWraps",
    ]) {
      expect(result[key], key).toContain("outside the u64 range");
    }
    expect(result.merkleVerify).toBe(true);
    expect(result.merkleDepth).toBe(0);
    expect(result.computeRootIsNode).toBe(true);
    expect(result.prover).toBe("remote|http://127.0.0.1:9|5");
    expect(result.proverNoTimeout).toBe("remote|http://127.0.0.1:9");
    expect(result.statusTimestamp).toBe("5");
    expect(result.feeAmount).toBe("7");
  });

  // A plain array is not a BigUint64Array, so the binding must check each element itself.
  test("a plain-array element outside 0..2^64 throws like a scalar argument", async ({
    run,
  }, testInfo) => {
    const result = await run(async ({ sdk }) => {
      const attempt = (build) => {
        try {
          build();
          return "no error";
        } catch (error) {
          return String(error?.message ?? error);
        }
      };
      const wraps = 2n ** 64n + 5n;
      const firstValue = (attachment) =>
        String(attachment.toWords()[0].toU64s()[0]);

      return {
        wordWraps: attempt(() => new sdk.Word([wraps, 0n, 0n, 0n])),
        wordNegative: attempt(() => new sdk.Word([-1n, 0n, 0n, 0n])),
        attachmentWraps: attempt(() => new sdk.NoteAttachment([wraps])),
        attachmentNegative: attempt(() => new sdk.NoteAttachment([-1n])),
        wordNumber: attempt(() => new sdk.Word([5, 0n, 0n, 0n])),
        wordInRange: new sdk.Word([1n, 2n, 3n, 4n]).toU64s()[0].toString(),
        wordTypedSame:
          new sdk.Word([1n, 2n, 3n, 4n]).toHex() ===
          new sdk.Word(sdk.u64Array([1, 2, 3, 4])).toHex(),
        attachmentEmpty: new sdk.NoteAttachment().numWords(),
        attachmentNull: new sdk.NoteAttachment(null).numWords(),
        attachmentUndefined: new sdk.NoteAttachment(undefined).numWords(),
        attachmentValue: firstValue(new sdk.NoteAttachment([7n])),
        attachmentTyped: firstValue(new sdk.NoteAttachment(sdk.u64Array([7]))),
      };
    });

    for (const key of [
      "wordWraps",
      "wordNegative",
      "attachmentWraps",
      "attachmentNegative",
    ]) {
      expect(result[key], key).toContain("outside the u64 range");
    }
    expect(result.wordNumber, "wordNumber").not.toBe("no error");
    if (testInfo.project.name !== "nodejs") {
      expect(result.wordNumber, "wordNumber").toContain("must be a BigInt");
    }
    expect(result.wordInRange).toBe("1");
    expect(result.wordTypedSame).toBe(true);
    expect(result.attachmentEmpty).toBe(1);
    expect(result.attachmentNull).toBe(1);
    expect(result.attachmentUndefined).toBe(1);
    expect(result.attachmentValue).toBe("7");
    expect(result.attachmentTyped).toBe("7");
  });
});
