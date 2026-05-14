// @ts-nocheck
import { expect } from "@playwright/test";
import test from "./playwright.global.setup";

/**
 * Regression test for the `_withInnerWebClient` re-entrancy deadlock.
 *
 * Before the fix, `_withInnerWebClient(fn)` wrapped `fn` in
 * `_serializeWasmCall(() => fn(inner))`. Any SDK call made BY `fn` —
 * either directly on the inner proxy (`inner.getInputNote(...)`) or on
 * a wrapper method that internally uses `_serializeWasmCall`
 * (`inner.executeTransaction(...)`, `inner.applyTransaction(...)`,
 * etc.) — enqueued onto the same promise chain. Because the outer
 * `_serializeWasmCall` slot was already awaiting `fn`, the inner slot
 * could not run until `fn` resolved, and `fn` could not resolve until
 * the inner slot ran. Result: the promise returned by
 * `_withInnerWebClient` hung forever.
 *
 * The fix adds a `_withInnerLockDepth` counter on the inner WebClient.
 * `_withInnerWebClient` bumps it around the `await fn(inner)`, and
 * `_serializeWasmCall` runs its callback inline (no chain enqueue) when
 * the counter is > 0. This breaks the re-entry deadlock while preserving
 * serialization against external callers — they still queue behind the
 * outer slot, which only resolves after `fn` (including all its inline
 * re-entries) settles. See the SAFETY CONTRACT comment on
 * `_withInnerWebClient` for the external-mutex requirement.
 *
 * These tests cover the three call shapes the wallet (Miden Wallet's
 * MV3 extension) actually uses inside `_withInnerWebClient`, plus the
 * external-serialization invariant.
 */
test.describe("_withInnerWebClient re-entrancy", () => {
  test("calling a proxy-fallback read (getInputNote) from inside fn does not deadlock", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const client = window.client as any;
      const completed = await Promise.race([
        client._withInnerWebClient(async (inner: any) => {
          // Any proxied async wasm method — `getInputNote` is a READ_METHOD
          // that the proxy fallback wraps in `_serializeWasmCall`. Pass a
          // bogus hex so the WASM side returns `undefined` cheaply.
          const note = await inner.getInputNote(
            "0x0000000000000000000000000000000000000000000000000000000000000000"
          );
          return { reached: "inside-fn", note: note ?? null };
        }),
        new Promise((resolve) =>
          setTimeout(() => resolve({ reached: "TIMEOUT" }), 8_000)
        ),
      ]);
      return completed as { reached: string };
    });

    expect(result.reached).toBe("inside-fn");
  });

  test("calling a wrapper write (executeTransaction-style serialized method) from inside fn does not deadlock", async ({
    page,
  }) => {
    // Verifies the re-entrancy fix for methods defined on the WebClient
    // wrapper itself (which call `this._serializeWasmCall` directly,
    // bypassing the proxy fallback). We can't invoke executeTransaction
    // without a valid request, so we exercise a representative wrapper
    // path that also funnels through `_serializeWasmCall`: `syncState`.
    const result = await page.evaluate(async () => {
      const client = window.client as any;
      const completed = await Promise.race([
        client._withInnerWebClient(async (inner: any) => {
          // syncState is defined on the wrapper class and uses
          // `this._serializeWasmCall(async () => { ... })` internally.
          // Without the re-entrancy fix this hangs.
          const summary = await inner.syncState();
          return { reached: "inside-fn", blockNum: summary.blockNum() };
        }),
        new Promise((resolve) =>
          setTimeout(() => resolve({ reached: "TIMEOUT" }), 30_000)
        ),
      ]);
      return completed as { reached: string; blockNum?: number };
    });

    expect(result.reached).toBe("inside-fn");
    expect(typeof result.blockNum).toBe("number");
  });

  test("external SDK callers still queue behind an in-flight _withInnerWebClient slot", async ({
    page,
  }) => {
    // The fix MUST NOT break the SDK's outer serialization contract.
    // An external caller (e.g. a concurrent `client.syncState()`)
    // starting WHILE `_withInnerWebClient(fn)` is mid-execution must
    // wait for `fn` to settle — it cannot interleave on the same WASM
    // instance.
    const result = await page.evaluate(async () => {
      const client = window.client as any;
      const order: string[] = [];
      const innerFinished = Promise.withResolvers
        ? Promise.withResolvers<void>()
        : (() => {
            let r!: () => void;
            const p = new Promise<void>((res) => (r = res));
            return { promise: p, resolve: r };
          })();

      const innerSlot = client._withInnerWebClient(async (inner: any) => {
        order.push("inner-start");
        // Long inline re-entrant call: a proxy-fallback read.
        await inner.getInputNote(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
        order.push("inner-middle");
        // Yield once to give the external slot a chance to interleave
        // (it must not — the chain holds the outer slot).
        await new Promise((r) => setTimeout(r, 50));
        order.push("inner-end");
        innerFinished.resolve();
      });

      // Kick off an external SDK call that uses `_serializeWasmCall`.
      // It should NOT run until `innerSlot` resolves.
      const externalSlot = (async () => {
        await Promise.resolve();
        // Acquire the chain via syncState's `_serializeWasmCall`.
        order.push("external-queued");
        const summary = await client.syncState();
        order.push("external-ran");
        return summary.blockNum();
      })();

      await Promise.all([innerSlot, externalSlot]);
      return { order };
    });

    // The external slot must run AFTER the inner slot finishes.
    expect(result.order).toContain("inner-end");
    expect(result.order).toContain("external-ran");
    expect(result.order.indexOf("inner-end")).toBeLessThan(
      result.order.indexOf("external-ran")
    );
  });

  test("rejection in fn propagates and releases the chain so subsequent calls work", async ({
    page,
  }) => {
    // Throwing from inside fn must not leave _withInnerLockDepth >0
    // permanently (which would silently disable serialization for all
    // future calls). After a rejected fn, subsequent SDK calls should
    // see normal queueing behavior.
    const result = await page.evaluate(async () => {
      const client = window.client as any;
      let threw = false;
      try {
        await client._withInnerWebClient(async () => {
          throw new Error("intentional");
        });
      } catch (err: unknown) {
        threw = (err as Error).message === "intentional";
      }

      // Now do a normal SDK call and an external call to verify the
      // chain is still healthy.
      const a = client.syncState();
      const b = client.syncState();
      const [r1, r2] = await Promise.all([a, b]);
      return {
        threw,
        sameBlock: r1.blockNum() === r2.blockNum(),
      };
    });

    expect(result.threw).toBe(true);
    expect(result.sameBlock).toBe(true);
  });
});
