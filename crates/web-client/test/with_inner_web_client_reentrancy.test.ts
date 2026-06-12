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

  test("an external SDK call made during fn runs inline (documents the safety-contract hole)", async ({
    page,
  }) => {
    // Characterizes the documented limit of the re-entrancy fix. The
    // `_withInnerLockDepth` counter is GLOBAL on the inner client, not
    // scoped to `fn`'s async context — so while `fn` is mid-flight
    // (depth > 0), ANY `_serializeWasmCall` runs inline, including one
    // issued by code OUTSIDE `fn`. Such a caller does NOT queue behind the
    // outer slot; it interleaves. This is exactly why `_withInnerWebClient`'s
    // SAFETY CONTRACT requires callers to hold an external mutex preventing
    // concurrent access during `fn` (the Miden Wallet's `withWasmClientLock`
    // discipline satisfies it).
    //
    // The interleaving is pinned with explicit handshakes rather than timer
    // races: `_serializeWasmCall`'s inline path is `Promise.resolve().then`,
    // so whether an external call runs inline vs queued hinges on whether
    // `depth > 0` at the exact microtask it fires — not something a `setTimeout`
    // can order reliably. `fnEntered` guarantees the external call is issued
    // only once `fn` is mid-flight (depth = 1, so it MUST take the inline
    // path), and `fn` parks on `externalDone` until the external call returns.
    //
    // If a regression closed the hole (context-scoped depth) or reverted the
    // fix (re-queuing the call), the external read would queue behind the
    // outer slot — which is parked on `externalDone` — and deadlock. The
    // 5s race below converts that hang into a fast, explicit failure:
    // "external-blocked" instead of "external-ran".
    const result = await page.evaluate(async () => {
      const inner = window.client as any;
      const client = new (window as any).MidenClient(
        inner,
        (window as any).getWasmOrThrow,
        null
      );
      const order: string[] = [];
      // Bogus hex → the proxy-fallback read returns undefined cheaply.
      const ZERO_HEX = "0x" + "0".repeat(64);

      const defer = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        return { promise, resolve };
      };
      const fnEntered = defer();
      const externalDone = defer();

      const innerSlot = client._withInnerWebClient(async (innerArg: any) => {
        order.push("inner-start");
        // Inline re-entrant call FROM fn: a proxy-fallback read.
        await innerArg.getInputNote(ZERO_HEX);
        order.push("inner-middle");
        // Signal that fn is mid-flight (depth = 1), then park until the
        // external call has run, so its inline execution is observable
        // BEFORE this slot resolves.
        fnEntered.resolve();
        await externalDone.promise;
        order.push("inner-end");
      });

      // External SDK call issued only after `fn` is mid-flight, so depth > 0
      // and `_serializeWasmCall` MUST take the inline path. Uses the shared
      // inner client (the `MidenClient` wrapper has no proxy fallback). The
      // race guards against a regression that would queue this call and
      // deadlock against the parked outer slot.
      const externalSlot = (async () => {
        await fnEntered.promise;
        order.push("external-queued");
        const ran = inner.getInputNote(ZERO_HEX).then(() => "ran");
        const blocked = new Promise((r) => setTimeout(r, 5_000, "blocked"));
        const outcome = await Promise.race([ran, blocked]);
        order.push("external-" + outcome);
        externalDone.resolve();
      })();

      await Promise.all([innerSlot, externalSlot]);
      return { order };
    });

    // The external call ran inline DURING `fn` (not blocked behind the outer
    // slot), and did so before this slot resolved — so "external-ran" lands
    // before "inner-end".
    expect(result.order).toContain("external-ran");
    expect(result.order).not.toContain("external-blocked");
    expect(result.order).toContain("inner-end");
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
