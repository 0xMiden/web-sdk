// @ts-nocheck
import { test, expect } from "./test-setup";

// WORKER INIT FAILURE TESTS
// =======================================================================================================
//
// When the method worker's INIT fails (e.g. the eager genesis fetch in
// `createClient` can't reach the RPC endpoint), the wrapper's `ready` promise
// must reject with the underlying error. Every worker-forwarded method awaits
// `ready` first, so leaving it pending turns one failed INIT into an infinite,
// silent hang on the first method call.

test.describe("worker init failure", () => {
  test("a failed worker INIT rejects `ready` instead of hanging", async ({
    run,
  }, testInfo) => {
    test.skip(
      testInfo.project.name === "nodejs",
      "the worker shim is browser-only"
    );

    const result = await run(async ({ sdk }) => {
      // Construct the worker-shim wrapper directly against an endpoint that
      // refuses connections, so the worker-side createClient fails fast.
      const wrapper = new sdk.WasmWebClient("http://127.0.0.1:9");
      try {
        await Promise.race([
          wrapper.ready,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("ready did not settle within 60s")),
              60_000
            )
          ),
        ]);
        return { settled: "resolved" };
      } catch (error) {
        return {
          settled: "rejected",
          message: String(error?.message ?? error),
        };
      } finally {
        wrapper.worker?.terminate();
      }
    });

    expect(result.settled).toBe("rejected");
    expect(result.message).not.toContain("ready did not settle");
    expect(result.message.length).toBeGreaterThan(0);
  });
});
