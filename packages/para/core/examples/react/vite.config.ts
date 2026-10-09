import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "path";
import { fileURLToPath } from "url";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const optionalConnectorsPath = path.resolve(
  __dirname,
  "src",
  "optional-connectors.ts"
);

// Para 3.18's react-core lazy-imports these. Esbuild still resolves the
// specifier at optimize time, so they have to exist or be stubbed.
const optionalPackages = [
  "@getpara/solana-wallet-connectors",
  "@getpara/cosmos-wallet-connectors",
  "@getpara/aa-alchemy",
  "@getpara/aa-biconomy",
  "@getpara/aa-cdp",
  "@getpara/aa-gelato",
  "@getpara/aa-pimlico",
  "@getpara/aa-porto",
  "@getpara/aa-rhinestone",
  "@getpara/aa-safe",
  "@getpara/aa-thirdweb",
  "@getpara/aa-zerodev",
];

const optionalAlias = Object.fromEntries(
  optionalPackages.map((pkg) => [pkg, optionalConnectorsPath])
);

const stubOptionalEsbuild = {
  name: "stub-para-optional",
  setup(build) {
    const filter = new RegExp(
      `^(${optionalPackages.map((p) => p.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join("|")})$`
    );
    build.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "para-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "para-stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    react(),
    nodePolyfills({
      include: ["buffer", "crypto", "stream", "util"],
    }),
  ],
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    exclude: ["@miden-sdk/miden-sdk", ...optionalPackages],
    esbuildOptions: {
      target: "esnext",
      plugins: [stubOptionalEsbuild],
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      external: optionalPackages,
    },
  },
  resolve: {
    dedupe: ["@getpara/web-sdk", "@getpara/react-sdk-lite"],
    alias: optionalAlias,
  },
  worker: {
    format: "es",
  },
  server: {
    fs: {
      allow: [
        // allow your project
        process.cwd(),
      ],
    },
  },
  // ... other configurations
});
