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

  test("an external SDK call made during fn runs inline (documents the safety-contract hole)", async ({
    page,
  }) => {
    // Characterizes the documented limit of the re-entrancy fix. The
    // `_withInnerLockDepth` counter is GLOBAL on the inner client, not
    // scoped to `fn`'s async context — so while `fn` is mid-flight
    // (depth > 0), ANY `_serializeWasmCall` runs inline, including one
    // issued by code OUTSIDE `fn` that races in during one of `fn`'s
    // awaits. Such a caller does NOT queue behind the outer slot; it
    // interleaves. This is exactly why `_withInnerWebClient`'s SAFETY
    // CONTRACT requires callers to hold an external mutex preventing
    // concurrent access during `fn` (the Miden Wallet's
    // `withWasmClientLock` discipline satisfies it).
    //
    // This test deliberately violates that contract to pin the behavior:
    // if a future change made the depth counter context-scoped (closing
    // the hole) or reverted it (reintroducing the deadlock), this
    // assertion would flip and flag the semantic change for review.
    const result = await page.evaluate(async () => {
      const inner = window.client as any;
      const client = new (window as any).MidenClient(
        inner,
        (window as any).getWasmOrThrow,
        null
      );
      const order: string[] = [];

      const innerSlot = client._withInnerWebClient(async (inner: any) => {
        order.push("inner-start");
        // Long inline re-entrant call: a proxy-fallback read.
        await inner.getInputNote(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
        order.push("inner-middle");
        // Yield long enough for the external slot to race in during this
        // await — with the global depth counter it runs inline here.
        await new Promise((r) => setTimeout(r, 50));
        order.push("inner-end");
      });

      // Kick off an external SDK call that uses `_serializeWasmCall`.
      // Because depth > 0 while `fn` is awaiting, it runs inline rather
      // than queuing behind the outer slot. A cheap proxy-fallback read
      // (local store lookup, returns undefined for a bogus hex) keeps the
      // ordering deterministic — it completes well within the inner
      // slot's 50ms sleep, so "external-ran" reliably precedes
      // "inner-end" without depending on network latency. Uses the shared
      // inner client (the `MidenClient` wrapper has no proxy fallback).
      const externalSlot = (async () => {
        await Promise.resolve();
        order.push("external-queued");
        await inner.getInputNote(
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
        order.push("external-ran");
      })();

      await Promise.all([innerSlot, externalSlot]);
      return { order };
    });

    // The external call interleaves: it runs inline DURING `fn`'s await,
    // so "external-ran" lands before "inner-end".
    expect(result.order).toContain("inner-end");
    expect(result.order).toContain("external-ran");
    expect(result.order.indexOf("external-ran")).toBeLessThan(
      result.order.indexOf("inner-end")
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
