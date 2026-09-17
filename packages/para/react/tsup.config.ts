import { defineConfig } from "tsup";

// Both entries are built by a SINGLE config on purpose. They used to be two
// configs in an array, but tsup runs array configs concurrently and its dts
// step deletes `**/*.d.{ts,mts,cts}` across the whole outDir at buildStart
// (tsup `tsup:clean` plugin). The `clean: true` config therefore raced the
// other one and wiped its already-emitted declarations, so
// `@miden-sdk/para-react/vite` shipped with no types at all.
export default defineConfig({
  entry: ["src/index.ts", "src/paraVitePlugin.ts"],
  format: ["cjs", "esm"],
  sourcemap: true,
  dts: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  clean: true,
  target: "es2019",
  external: [
    "react",
    "@getpara/react-sdk-lite",
    "@getpara/web-sdk",
    "@miden-sdk/para",
    "@miden-sdk/miden-sdk",
    "@miden-sdk/react",
    "@tanstack/react-query",
    "vite",
    "vite-plugin-node-polyfills",
  ],
});
