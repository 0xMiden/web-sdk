import { describe, it, expect } from "vitest";
import type { ConfigEnv, UserConfig } from "vite";
import { existsSync } from "node:fs";
import { midenVitePlugin } from "../index.js";

function callConfig(
  plugin: ReturnType<typeof midenVitePlugin>,
  userConfig: UserConfig = {},
  env: ConfigEnv = { command: "serve", mode: "development" }
) {
  const fn = plugin.config;
  if (typeof fn !== "function") throw new Error("config hook missing");
  return fn(userConfig, env) as Record<string, any>;
}

describe("config() hook", () => {
  it("includes default wasmPackages in dedupe", () => {
    const result = callConfig(midenVitePlugin());
    expect(result.resolve.dedupe).toContain("@miden-sdk/miden-sdk");
    expect(result.resolve.dedupe).toContain("react");
    expect(result.resolve.dedupe).toContain("react-dom");
    expect(result.resolve.dedupe).toContain("react/jsx-runtime");
    expect(result.resolve.dedupe).toContain("@miden-sdk/react");
  });

  it("excludes wasmPackages from optimizeDeps", () => {
    const result = callConfig(
      midenVitePlugin({ wasmPackages: ["pkg-a", "pkg-b"] })
    );
    expect(result.optimizeDeps.exclude).toEqual(["pkg-a", "pkg-b"]);
    expect(result.resolve.dedupe).toContain("pkg-a");
    expect(result.resolve.dedupe).toContain("pkg-b");
  });

  it("falls back to <root>/node_modules/<pkg> when require.resolve throws", () => {
    const result = callConfig(
      midenVitePlugin({ wasmPackages: ["definitely-not-installed-xyz"] })
    );
    const alias = result.resolve.alias;
    expect(Array.isArray(alias)).toBe(true);
    expect(alias.length).toBe(1);
    expect(alias[0].replacement).toMatch(
      /node_modules.+definitely-not-installed-xyz$/
    );
    expect(existsSync(alias[0].replacement)).toBe(false);
  });

  it("uses an existing resolved directory when require.resolve succeeds", () => {
    const result = callConfig(midenVitePlugin({ wasmPackages: ["vitest"] }));
    const alias = result.resolve.alias;
    expect(alias[0].replacement).toMatch(/vitest/);
    // Whether the resolved path equals <root>/node_modules/vitest or differs
    // depends on the install layout (flat vs hoisted vs pnpm). The robust
    // assertion is simply that the resolved directory exists on disk.
    expect(existsSync(alias[0].replacement)).toBe(true);
  });

  it("escapes regex metacharacters in package names", () => {
    const result = callConfig(
      midenVitePlugin({ wasmPackages: ["@scope/pkg-with.dots"] })
    );
    const alias = result.resolve.alias;
    const regex: RegExp = alias[0].find;
    expect(regex.test("@scope/pkg-with.dots")).toBe(true);
    expect(regex.test("@scope/pkg-withXdots")).toBe(false);
  });

  it("does not set COOP/COEP headers by default", () => {
    const result = callConfig(midenVitePlugin());
    expect(result.server.headers).toBeUndefined();
    expect(result.preview.headers).toBeUndefined();
  });

  it("sets COOP/COEP headers when crossOriginIsolation is true", () => {
    const result = callConfig(midenVitePlugin({ crossOriginIsolation: true }));
    expect(result.server.headers).toEqual({
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    expect(result.preview.headers).toEqual({
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
  });

  it("configures the gRPC-web proxy on serve with default target/path", () => {
    const result = callConfig(
      midenVitePlugin(),
      {},
      {
        command: "serve",
        mode: "development",
      }
    );
    expect(result.server.proxy).toEqual({
      "/rpc.Api": {
        target: "https://rpc.testnet.miden.io",
        changeOrigin: true,
      },
    });
  });

  it("respects custom rpcProxyTarget and rpcProxyPath", () => {
    const result = callConfig(
      midenVitePlugin({
        rpcProxyTarget: "https://example.com",
        rpcProxyPath: "/api",
      })
    );
    expect(result.server.proxy).toEqual({
      "/api": { target: "https://example.com", changeOrigin: true },
    });
  });

  it("skips proxy config when rpcProxyTarget is false", () => {
    const result = callConfig(midenVitePlugin({ rpcProxyTarget: false }));
    expect(result.server.proxy).toBeUndefined();
  });

  it("skips proxy config when env.command !== 'serve'", () => {
    const result = callConfig(
      midenVitePlugin(),
      {},
      {
        command: "build",
        mode: "production",
      }
    );
    expect(result.server.proxy).toBeUndefined();
  });

  it("uses userConfig.root when provided", () => {
    const result = callConfig(midenVitePlugin({ wasmPackages: ["nope-xyz"] }), {
      root: "/custom/root",
    });
    expect(result.resolve.alias[0].replacement).toBe(
      "/custom/root/node_modules/nope-xyz"
    );
  });

  it("sets build.target to esnext for top-level await", () => {
    const result = callConfig(midenVitePlugin());
    expect(result.build.target).toBe("esnext");
  });

  it("sets worker.format to es", () => {
    const result = callConfig(midenVitePlugin());
    expect(result.worker.format).toBe("es");
    expect(result.worker.rollupOptions.output.format).toBe("es");
  });

  it("sets resolve.preserveSymlinks", () => {
    const result = callConfig(midenVitePlugin());
    expect(result.resolve.preserveSymlinks).toBe(true);
  });
});
