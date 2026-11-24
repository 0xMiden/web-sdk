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
 * The fix hands `fn` a trusted handle on the inner WebClient: calls made
 * through it run inline in the slot `fn` holds, while every other caller,
 * including one that runs during an await inside `fn`, queues behind it.
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
      // `window.client` is the proxy-wrapped inner WebClient (it owns
      // `_serializeWasmCall`); `_withInnerWebClient` lives on the
      // `MidenClient` wrapper. Wrap the existing inner so the test drives
      // the real shipped method against the same chain.
      const inner = window.client as any;
      const client = new (window as any).MidenClient(
        inner,
        (window as any).getWasmOrThrow,
        null
      );
      const completed = await Promise.race([
        client._withInnerWebClient(async (inner: any) => {
          // `getInputNote` reaches the WASM client via the proxy fallback,
          // which binds it directly (NOT through `_serializeWasmCall`), so
          // this call can never enqueue behind the outer slot. It guards
          // the weaker invariant that a fallback read issued mid-callback
          // completes against the held WASM instance without tripping
          // wasm-bindgen's borrow check. The wrapper-method re-entrancy
          // (the depth-counter path) is exercised by the syncState cases
          // below. Pass a bogus hex so the WASM side returns `undefined`
          // cheaply.
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
      const inner = window.client as any;
      const client = new (window as any).MidenClient(
        inner,
        (window as any).getWasmOrThrow,
        null
      );
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

  test("an external SDK call made during fn queues behind fn", async ({
    page,
  }) => {
    // `fn` parks until the external call, issued while `fn` is mid-flight,
    // has had 500 ms to run. It must still be pending then and settle only
    // after `fn` does.
    const result = await page.evaluate(async () => {
      const inner = window.client as any;
      const client = new (window as any).MidenClient(
        inner,
        (window as any).getWasmOrThrow,
        null
      );
      const order: string[] = [];
      // Bogus hex: the proxy-fallback read returns undefined cheaply.
      const ZERO_HEX = "0x" + "0".repeat(64);

      const defer = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        return { promise, resolve };
      };
      const fnEntered = defer();
      const releaseFn = defer();

      const innerSlot = client._withInnerWebClient(async (innerArg: any) => {
        order.push("inner-start");
        await innerArg.getInputNote(ZERO_HEX);
        fnEntered.resolve();
        await releaseFn.promise;
        order.push("inner-end");
      });

      const externalSlot = (async () => {
        await fnEntered.promise;
        const ran = inner
          .getInputNote(ZERO_HEX)
          .then(() => order.push("external-ran"));
        await new Promise((r) => setTimeout(r, 500));
        order.push("external-waited");
        releaseFn.resolve();
        await ran;
      })();

      await Promise.all([innerSlot, externalSlot]);
      return { order };
    });

    expect(result.order).toEqual([
      "inner-start",
      "external-waited",
      "inner-end",
      "external-ran",
    ]);
  });

  test("rejection in fn propagates and releases the chain so subsequent calls work", async ({
    page,
  }) => {
    // Throwing from inside fn must release the chain slot. After a
    // rejected fn, subsequent SDK calls should see normal queueing behavior.
    const result = await page.evaluate(async () => {
      const inner = window.client as any;
      const client = new (window as any).MidenClient(
        inner,
        (window as any).getWasmOrThrow,
        null
      );
      let threw = false;
      try {
        await client._withInnerWebClient(async () => {
          throw new Error("intentional");
        });
      } catch (err: unknown) {
        threw = (err as Error).message === "intentional";
      }

      // Now do a normal SDK call and an external call to verify the
      // chain is still healthy. Issued on the shared inner client (the
      // `MidenClient` wrapper exposes `sync()`, not `syncState()`).
      const a = inner.syncState();
      const b = inner.syncState();
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
