import { describe, expect, it, vi } from "vitest";

// These exports are JS polyfills and must work independently of native exports.
vi.mock("../node/loader.js", () => ({ loadNativeModule: () => ({}) }));

import { AccountInputsArray } from "../node-index.js";

describe("Node array exports", () => {
  it.each([["AccountInputsArray", AccountInputsArray]])(
    "exports a usable %s constructor",
    (_name, ArrayType) => {
      const item = {};
      const items = new ArrayType([item]);

      expect(Array.isArray(items)).toBe(true);
      expect(items).toHaveLength(1);
      expect(items[0]).toBe(item);
      expect(items.get(0)).toBe(item);
    }
  );
});
