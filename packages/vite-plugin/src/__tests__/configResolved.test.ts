import { describe, it, expect } from "vitest";
import { midenVitePlugin } from "../index.js";

function callConfigResolved(plugin: ReturnType<typeof midenVitePlugin>, config: any) {
  const fn = plugin.configResolved;
  if (typeof fn !== "function") throw new Error("configResolved hook missing");
  return fn(config);
}

function makeBaseConfig(overrides: any = {}) {
  return {
    optimizeDeps: { esbuildOptions: {} as any },
    resolve: { dedupe: [] as string[] },
    ...overrides,
  };
}

describe("configResolved() hook", () => {
  it("creates esbuildOptions when missing", () => {
    const config = { optimizeDeps: {}, resolve: { dedupe: [] } } as any;
    callConfigResolved(midenVitePlugin(), config);
    expect(config.optimizeDeps.esbuildOptions).toBeDefined();
    expect(Array.isArray(config.optimizeDeps.esbuildOptions.plugins)).toBe(true);
  });

  it("creates esbuildOptions.plugins array when missing", () => {
    const config = makeBaseConfig();
    callConfigResolved(midenVitePlugin(), config);
    expect(config.optimizeDeps.esbuildOptions.plugins).toBeDefined();
  });

  it("appends externalizeMidenReact plugin", () => {
    const config = makeBaseConfig();
    callConfigResolved(midenVitePlugin(), config);
    const plugins = config.optimizeDeps.esbuildOptions.plugins;
    expect(plugins.some((p: any) => p.name === "externalize-miden-react")).toBe(true);
  });

  it("does not duplicate externalizeMidenReact when already present", () => {
    const config = makeBaseConfig({
      optimizeDeps: {
        esbuildOptions: {
          plugins: [{ name: "externalize-miden-react", setup: () => {} }],
        },
      },
    });
    callConfigResolved(midenVitePlugin(), config);
    const matching = config.optimizeDeps.esbuildOptions.plugins.filter(
      (p: any) => p.name === "externalize-miden-react"
    );
    expect(matching.length).toBe(1);
  });

  it("preserves existing target if already set", () => {
    const config = makeBaseConfig({
      optimizeDeps: { esbuildOptions: { target: "es2020" } },
    });
    callConfigResolved(midenVitePlugin(), config);
    expect(config.optimizeDeps.esbuildOptions.target).toBe("es2020");
  });

  it("sets target to esnext when missing", () => {
    const config = makeBaseConfig();
    callConfigResolved(midenVitePlugin(), config);
    expect(config.optimizeDeps.esbuildOptions.target).toBe("esnext");
  });

  it("creates resolve.dedupe when missing", () => {
    const config = { optimizeDeps: {}, resolve: {} } as any;
    callConfigResolved(midenVitePlugin(), config);
    expect(Array.isArray(config.resolve.dedupe)).toBe(true);
  });

  it("appends required dedupe entries", () => {
    const config = makeBaseConfig();
    callConfigResolved(midenVitePlugin(), config);
    expect(config.resolve.dedupe).toEqual(
      expect.arrayContaining([
        "react",
        "react-dom",
        "react/jsx-runtime",
        "@miden-sdk/react",
      ])
    );
  });

  it("does not duplicate already-present dedupe entries", () => {
    const config = makeBaseConfig({ resolve: { dedupe: ["react"] } });
    callConfigResolved(midenVitePlugin(), config);
    const reactEntries = config.resolve.dedupe.filter((d: string) => d === "react");
    expect(reactEntries.length).toBe(1);
  });
});
