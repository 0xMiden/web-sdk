import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@miden-sdk/react` is a workspace package here, not a registry install, so
  // its `dist/` only exists after a build. Resolve it to source instead, so
  // `pnpm test` stays runnable without building anything.
  resolve: {
    alias: [
      {
        find: /^@miden-sdk\/react$/,
        replacement: fileURLToPath(
          new URL("../../react-sdk/src/index.ts", import.meta.url)
        ),
      },
    ],
  },
  test: { environment: "jsdom", globals: true },
});
