import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@miden-sdk/miden-wallet-adapter-react` resolves through its `exports` to a
  // `dist/` that only exists after a build. Resolve it to source instead, so
  // `pnpm test` stays runnable without building anything.
  resolve: {
    alias: [
      {
        find: /^@miden-sdk\/miden-wallet-adapter-react$/,
        replacement: fileURLToPath(
          new URL("../react/index.ts", import.meta.url)
        ),
      },
    ],
  },
  test: { environment: "jsdom", globals: true },
});
