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
      // `branches` is set 1pp lower than the others because v8's branch
      // instrumentation marks `} finally {` blocks as partially-covered even
      // when both try-success and catch-rethrow paths are exercised by tests
      // (it appears to expect a third path that doesn't exist in this code).
      // The remaining gap to 95 is concentrated in those finally blocks plus
      // a handful of catch-around-non-throwing-code patterns that are dead in
      // practice — closing it would require either source-side defensive-code
      // cleanup or contrived deep mocks. Lines/funcs/statements remain at 95.
      thresholds: { lines: 95, branches: 94, functions: 95, statements: 95 },
    },
  },
});
