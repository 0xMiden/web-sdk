import { expect } from "@playwright/test";
import test from "./playwright.global.setup";

/**
 * Regression test for `miden-client#2183` — broader contract.
 *
 * Originally, `JsAccountUpdate`, `JsStorageMapEntry`, `JsStorageSlot`,
 * and `JsVaultAsset` were declared `#[wasm_bindgen(getter_with_clone,
 * inspectable)]` with public fields. `inspectable` makes wasm-bindgen
 * auto-emit a `toJSON()` whose body reads every public field through
 * a WASM round-trip
 * (`wasm.__wbg_get_<class>_<field>(this.__wbg_ptr)`).
 *
 * Under Next.js 16.2 dev-mode, the patched `console.*` runs every
 * non-primitive argument through `safe-stable-stringify`, which
 * invokes `toJSON()` automatically. If the underlying pointer has
 * been freed (or another WASM call is in flight), the resulting
 * `"null pointer passed to rust"` trap propagates out of the user's
 * `console.log` call site and crashes the caller.
 *
 * The fix dropped `inspectable` on those four structs. wasm-bindgen
 * then either emits no `toJSON()` at all, or — for inspectable
 * structs with no `pub` fields, like `Address`, `NoteFile`,
 * `CodeBuilder`, and the array wrappers — emits the safe
 * `toJSON() { return {}; }` shape.
 *
 * The contract this test enforces is therefore not "no class has
 * `toJSON`" (many do, with empty bodies and that's fine) but rather
 * the stronger and more semantic property: **for every wasm-bindgen
 * wrapper class exported from the SDK, `JSON.stringify` of a
 * fabricated instance with `__wbg_ptr = 0` must return `"{}"`.**
 *
 * That property holds in three legitimate cases:
 *   1. The class has no `toJSON` — default `JSON.stringify` finds no
 *      own enumerable properties and returns `"{}"`.
 *   2. The class has `toJSON() { return {}; }` (wasm-bindgen's output
 *      for `inspectable` structs with no `pub` fields).
 *   3. The class has an explicit hand-written `toJSON` that doesn't
 *      read fields via WASM getters.
 *
 * It fails in the dangerous case: a `toJSON` that reads each public
 * field via `__wbg_get_<class>_<field>(this.__wbg_ptr)`. With
 * `__wbg_ptr = 0`, those getters either throw "null pointer passed
 * to rust" out of WASM or return garbage — neither produces `"{}"`,
 * so the assertion catches the regression.
 *
 * If a future change re-introduces `#[wasm_bindgen(inspectable)]`
 * on any struct that also has public fields (the exact shape that
 * caused #2183), this test fails immediately and names the offender.
 */

test.describe("wasm-bindgen wrapper classes — safe JSON.stringify contract (regression for miden-client#2183)", () => {
  test("no exported wrapper class re-enters WASM under JSON.stringify with __wbg_ptr = 0", async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      // Snapshot every export on `window` placed there by the global
      // setup's `Object.entries(sdkExports)` copy.
      const candidates: { name: string; ctor: Function }[] = [];
      for (const [name, value] of Object.entries(
        window as unknown as Record<string, unknown>
      )) {
        if (typeof value !== "function") continue;
        const ctor = value as unknown as {
          __wrap?: unknown;
          prototype?: { __destroy_into_raw?: unknown };
        };
        // Standard wasm-bindgen wrapper signature: static `__wrap` to
        // construct from a pointer, and `__destroy_into_raw` on the
        // prototype to release it. Anything matching both is a
        // pointer-backed wrapper and must satisfy the JSON-safe
        // contract. Enums, plain helpers, hand-written JS classes,
        // and TS-side facades are correctly filtered out.
        if (typeof ctor.__wrap !== "function") continue;
        if (typeof ctor.prototype?.__destroy_into_raw !== "function") continue;
        candidates.push({ name, ctor: value as Function });
      }

      // Sanity: at least the four originally-affected classes plus the
      // major wallet wrappers must be present. If the SDK ever stops
      // exporting these, the test's coverage is silently smaller — fail
      // loudly so the maintainer notices.
      const mustHave = [
        "JsAccountUpdate",
        "JsStorageMapEntry",
        "JsStorageSlot",
        "JsVaultAsset",
        "Account",
        "Note",
        "WebClient",
      ];

      const offenders: { name: string; reason: string; output?: string }[] = [];
      for (const { name, ctor } of candidates) {
        const proto = (ctor as unknown as { prototype: object }).prototype;
        const fake = Object.create(proto);
        // wasm-bindgen wrapper instances always carry `__wbg_ptr`.
        // Setting it to 0 makes any field-getter call into WASM either
        // throw "null pointer passed to rust" or return garbage — both
        // diverge from `"{}"`, which is the assertion below.
        Object.defineProperty(fake, "__wbg_ptr", {
          value: 0,
          enumerable: false,
          writable: true,
          configurable: true,
        });
        try {
          const stringified = JSON.stringify(fake);
          if (stringified !== "{}") {
            offenders.push({
              name,
              reason: "JSON.stringify returned non-empty payload",
              output: stringified.slice(0, 200),
            });
          }
        } catch (err) {
          offenders.push({
            name,
            reason: "JSON.stringify threw",
            output: (err as Error)?.message?.slice(0, 200) ?? String(err),
          });
        }
      }

      const presentMustHave = mustHave.filter((name) =>
        candidates.some((c) => c.name === name)
      );

      return {
        totalCandidates: candidates.length,
        candidateNames: candidates.map((c) => c.name).sort(),
        mustHavePresent: presentMustHave,
        mustHaveMissing: mustHave.filter((n) => !presentMustHave.includes(n)),
        offenders,
      };
    });

    expect(
      result.mustHaveMissing,
      `Lost SDK exports the test relies on: ${result.mustHaveMissing.join(", ")}. ` +
        `Either the SDK no longer exports these (update the list) or the global ` +
        `setup is no longer copying exports onto window.`
    ).toEqual([]);

    expect(
      result.totalCandidates,
      "Expected dozens of wasm-bindgen wrapper classes on window; got too few. " +
        "Did the global setup stop attaching SDK exports?"
    ).toBeGreaterThan(20);

    expect(
      result.offenders,
      // Long, deliberately self-explanatory message — this assertion fires when
      // someone re-adds `inspectable` to a struct with `pub` fields, and the
      // person reading the failure may not have the #2183 history in mind.
      `One or more wasm-bindgen wrapper classes expose a toJSON that reads ` +
        `their fields via __wbg_get_<class>_<field>(this.__wbg_ptr). Under ` +
        `Next.js 16.2 dev-mode console patching (safe-stable-stringify invokes ` +
        `toJSON automatically), this re-enters WASM and crashes the caller ` +
        `when the pointer is freed or another WASM call is in flight — see ` +
        `miden-client#2183. Fix: remove #[wasm_bindgen(inspectable)] from the ` +
        `Rust struct, or — if you really need fields visible in DevTools — ` +
        `keep inspectable but make all fields private to wasm-bindgen ` +
        `(no #[wasm_bindgen] getters), so the auto-emitted toJSON is empty.`
    ).toEqual([]);
  });
});
