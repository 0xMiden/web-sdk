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
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/__tests__/**",
        "src/index.ts",
        "src/types/**",
        "src/**/*.d.ts",
      ],
      // Phase 0: measurement-mode. Restored to 95 in Phase 4.
      thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
    },
  },
});
