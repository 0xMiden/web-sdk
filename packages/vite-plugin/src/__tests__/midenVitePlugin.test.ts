import { describe, it, expect } from "vitest";
import { midenVitePlugin } from "../index.js";

describe("midenVitePlugin", () => {
  it("returns a Vite plugin object with the expected name and enforce", () => {
    const plugin = midenVitePlugin();
    expect(plugin.name).toBe("@miden-sdk/vite-plugin");
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.config).toBe("function");
    expect(typeof plugin.configResolved).toBe("function");
  });
});
