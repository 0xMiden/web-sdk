import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

process.env.VITE_CJS_IGNORE_WARNING = "1";

export default defineConfig({
  resolve: {
    alias: [
      // Match both the eager default (`@miden-sdk/miden-sdk`) and the lazy
      // subpath (`@miden-sdk/miden-sdk/lazy`) — tests mock them identically
      // via `vi.mock` in setup.ts.
      {
        find: /^@miden-sdk\/miden-sdk(\/lazy)?$/,
        replacement: fileURLToPath(
          new URL("./src/__tests__/mocks/miden-sdk-entry.ts", import.meta.url)
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // json-summary writes coverage/coverage-summary.json with the
      // aggregate { total: { lines: { pct, ... }, ... } } that the
      // CI badge job parses to publish a shields.io endpoint JSON.
      // lcov is consumed by codecov-style integrations.
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/__tests__/**",
        "src/index.ts",
        "src/types/**",
        "src/**/*.d.ts",
        // Pure WASM proxy — covered by Playwright integration tests in
        // test/accountBech32.test.ts. Cannot be unit-tested in jsdom because
        // NetworkId, Address, and Account.prototype come from the real WASM bundle.
        "src/utils/accountBech32.ts",
        // WASM-dependent hook — covered by Playwright integration tests in
        // test/useAssetMetadata.test.ts. Cannot be unit-tested in jsdom because
        // RpcClient, Endpoint, and BasicFungibleFaucetComponent come from the
        // real WASM bundle and don't behave like the mocked SDK in jsdom.
        "src/hooks/useAssetMetadata.ts",
      ],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
