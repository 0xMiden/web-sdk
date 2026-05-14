import { expect, Page } from "@playwright/test";
import test from "./playwright.global.setup";

/**
 * Regression test for `miden-client#2183`.
 *
 * The wasm-bindgen wrapper classes `JsAccountUpdate`,
 * `JsStorageMapEntry`, `JsStorageSlot`, and `JsVaultAsset` (defined in
 * `crates/idxdb-store/src/{account,sync}/js_bindings.rs`) used to be
 * declared with `#[wasm_bindgen(getter_with_clone, inspectable)]`. The
 * `inspectable` attribute made wasm-bindgen auto-emit a `toJSON()`
 * method on the JS wrapper that read every public field through a
 * round-trip into WASM (`wasm.__wbg_get_<class>_<field>(this.__wbg_ptr)`).
 *
 * Next.js 16.2+ dev-mode patches `console.*` and runs every non-primitive
 * argument through `safe-stable-stringify`, which invokes `toJSON()`
 * automatically. If the underlying pointer was freed or another WASM
 * call was in flight, the resulting `"null pointer passed to rust"`
 * trap propagated out of the user's `console.log` call site and crashed
 * the caller.
 *
 * The fix dropped `inspectable` on these four structs. The contract this
 * test enforces: **the wasm-bindgen JS wrapper classes for these four
 * structs MUST NOT expose a `toJSON` method.** Without it,
 * `JSON.stringify` / `safe-stable-stringify` fall back to `{}` (the
 * wrapper carries no own enumerable data — it's all behind `__wbg_ptr`),
 * and the dev-mode console patch can never trigger the re-entry.
 *
 * If a future change adds `inspectable` back (or otherwise emits a
 * field-reading `toJSON`), this test fails immediately.
 */

const collectToJsonState = async (page: Page) => {
  return await page.evaluate(() => {
    const classes = [
      "JsAccountUpdate",
      "JsStorageMapEntry",
      "JsStorageSlot",
      "JsVaultAsset",
    ] as const;
    const result: Record<string, { exists: boolean; toJSON: string }> = {};
    for (const name of classes) {
      const ctor = (window as Record<string, unknown>)[name] as
        | { prototype?: { toJSON?: unknown } }
        | undefined;
      result[name] = {
        exists: typeof ctor === "function",
        toJSON: typeof ctor?.prototype?.toJSON,
      };
    }
    return result;
  });
};

test.describe("idxdb-store wrapper classes — no auto-generated toJSON (regression for miden-client#2183)", () => {
  test("JsAccountUpdate / JsStorageMapEntry / JsStorageSlot / JsVaultAsset prototypes have no toJSON method", async ({
    page,
  }) => {
    const state = await collectToJsonState(page);

    // Sanity check — all four classes must be exported from the SDK,
    // otherwise the assertions below could pass vacuously (no ctor →
    // `ctor?.prototype?.toJSON` is `undefined` regardless of bindgen
    // settings). If this fires, either the class was removed or the
    // SDK export plumbing changed and the test needs updating.
    for (const [name, info] of Object.entries(state)) {
      expect(info.exists, `${name} should be exported on window`).toBe(true);
    }

    // The actual regression assertion: no toJSON method on any of the
    // four wrapper-class prototypes. wasm-bindgen emits toJSON only when
    // the source struct has `#[wasm_bindgen(inspectable)]`; the fix in
    // crates/idxdb-store removed that attribute, so toJSON should be
    // absent. If someone re-adds `inspectable`, this assertion fails.
    for (const [name, info] of Object.entries(state)) {
      expect(
        info.toJSON,
        `${name}.prototype.toJSON must be absent — otherwise safe-stable-stringify ` +
          `under Next.js dev-mode console will re-enter WASM via field getters ` +
          `(see miden-client#2183).`
      ).toBe("undefined");
    }
  });

  test("JSON.stringify on a fabricated JsAccountUpdate-prototype instance returns '{}'", async ({
    page,
  }) => {
    // The most direct check: build an object whose prototype is one of
    // these wrapper classes' prototypes, give it a `__wbg_ptr` field
    // (matching the wasm-bindgen shape), and JSON.stringify it. With no
    // `toJSON` on the prototype and no own enumerable properties besides
    // `__wbg_ptr`, the output must be the empty object. (Note we expect
    // `__wbg_ptr` to be excluded because wasm-bindgen marks it as
    // non-enumerable; JSON.stringify skips non-enumerables.)
    const result = await page.evaluate(() => {
      const ctor = (
        window as unknown as { JsAccountUpdate: { prototype: object } }
      ).JsAccountUpdate;
      const fake = Object.create(ctor.prototype);
      Object.defineProperty(fake, "__wbg_ptr", {
        value: 0,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      return JSON.stringify(fake);
    });

    // Empty object — confirms the dev-mode console-patch path is safe
    // even when the underlying pointer is zero/freed.
    expect(result).toBe("{}");
  });
});
