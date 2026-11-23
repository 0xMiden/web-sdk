// @ts-nocheck
import { test, expect } from "./test-setup";

// U64 ARGUMENT RANGE
// =======================================================================================================
//
// Expected-red proof for PR #575 C-02: these assertions run against the pre-#466 binding, which reduces a
// browser BigInt modulo 2^64 and aborts Node on an out-of-range value.

test.describe("u64 argument range", () => {
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
});
