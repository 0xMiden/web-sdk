import { describe, it, expect } from "vitest";
import { midenVitePlugin } from "../index.js";

function getExternalizePlugin() {
  const config: any = { optimizeDeps: {}, resolve: {} };
  const fn = midenVitePlugin().configResolved;
  if (typeof fn !== "function") throw new Error("configResolved missing");
  fn(config);
  const plugin = config.optimizeDeps.esbuildOptions.plugins.find(
    (p: any) => p.name === "externalize-miden-react"
  );
  if (!plugin) throw new Error("externalize-miden-react plugin not found");
  return plugin;
}

describe("externalizeMidenReact esbuild plugin", () => {
  it("has the expected name", () => {
    expect(getExternalizePlugin().name).toBe("externalize-miden-react");
  });

  it("registers an onResolve callback that returns external for @miden-sdk/react", () => {
    const plugin = getExternalizePlugin();
    let registered: { filter: RegExp; cb: (a: any) => any } | null = null;
    const fakeBuild = {
      onResolve: (opts: { filter: RegExp }, cb: (a: any) => any) => {
        registered = { filter: opts.filter, cb };
      },
    };
    plugin.setup(fakeBuild);
    expect(registered).not.toBeNull();
    expect(registered!.filter.test("@miden-sdk/react")).toBe(true);
    expect(registered!.filter.test("@miden-sdk/react/lazy")).toBe(false);
    const result = registered!.cb({ path: "@miden-sdk/react" });
    expect(result).toEqual({ path: "@miden-sdk/react", external: true });
  });
});
