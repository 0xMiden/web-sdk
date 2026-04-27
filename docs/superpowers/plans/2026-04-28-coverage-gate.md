# Coverage Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce ≥95% Vitest coverage (lines, branches, functions, statements) on every PR across `packages/react-sdk`, `crates/idxdb-store/src`, and `packages/vite-plugin`, by adding per-package CI gates and writing the missing tests.

**Architecture:** Each of three packages gets a `vitest.config.ts` threshold block (V8 provider, 95 across all four metrics). CI runs each package's tests in a parallel job; threshold misses fail the job. Implementation proceeds measurement-first: scaffold gates with thresholds at 0, run, read coverage gaps, then write tests until each package reaches 95%, then restore thresholds.

**Tech Stack:** Vitest 1.x (react-sdk) and 3.x (idxdb-store) with `@vitest/coverage-v8`; vite-plugin gets a fresh Vitest install. Tests use `jsdom` (react-sdk), `node` + `fake-indexeddb` (idxdb-store), `node` (vite-plugin). GitHub Actions for CI. Yarn for package management.

**Reference:** Spec at `docs/superpowers/specs/2026-04-28-coverage-gate-design.md`.

---

## File structure overview

**Files created:**

| Path | Responsibility |
|---|---|
| `packages/vite-plugin/vitest.config.ts` | Vitest config for the new test setup |
| `packages/vite-plugin/src/__tests__/midenVitePlugin.test.ts` | Plugin factory + option defaults |
| `packages/vite-plugin/src/__tests__/config.test.ts` | The `config()` hook's returned object |
| `packages/vite-plugin/src/__tests__/configResolved.test.ts` | The `configResolved()` hook's mutations |
| `packages/vite-plugin/src/__tests__/externalize.test.ts` | The `externalizeMidenReact` esbuild plugin |
| `crates/idxdb-store/src/ts/utils.test.ts` | `mapOption`, `logWebStoreError`, `uint8ArrayToBase64` |
| `crates/idxdb-store/src/ts/settings.test.ts` | get/insert/remove/list settings |
| `crates/idxdb-store/src/ts/auth.test.ts` | auth secrets |
| `crates/idxdb-store/src/ts/transactions.test.ts` | transaction CRUD + filters |
| `crates/idxdb-store/src/ts/import.test.ts` | DB import |
| `crates/idxdb-store/src/ts/export.test.ts` | DB export |
| `crates/idxdb-store/src/ts/sync.test.ts` | sync state ops |
| `packages/react-sdk/src/__tests__/utils/<x>.test.ts` | One per uncovered util discovered in Phase 3 measurement |

**Files modified:**

| Path | Change |
|---|---|
| `packages/react-sdk/vitest.config.ts` | Add `thresholds` + `lcov` reporter to existing `coverage` block |
| `packages/react-sdk/package.json` | Add `@vitest/coverage-v8` to devDependencies |
| `packages/vite-plugin/package.json` | Add `vitest`, `@vitest/coverage-v8`; add `test` script |
| `crates/idxdb-store/src/vitest.config.ts` | Add `coverage` block with thresholds and lcov reporter |
| `crates/idxdb-store/src/package.json` | Add `@vitest/coverage-v8` to devDependencies |
| `Makefile` | Add `test-idxdb-store`, `test-vite-plugin`, `test-coverage` targets; modify `test-react-sdk` to pass `--coverage` |
| `.github/workflows/test.yml` | Add `--coverage` to existing `test-react-sdk` step + artifact upload; add `test-idxdb-store` and `test-vite-plugin` jobs |

---

## Phase 0 — Scaffold gates with measurement-mode thresholds

This phase wires up coverage everywhere with **thresholds set to 0** so reports run without failing. We tighten to 95 in Phase 4 after writing the tests.

### Task 0.1: Add coverage dependency to react-sdk

**Files:**
- Modify: `packages/react-sdk/package.json`

- [ ] **Step 1: Add `@vitest/coverage-v8` to devDependencies**

Edit `packages/react-sdk/package.json`. In the `devDependencies` block, add:

```json
"@vitest/coverage-v8": "^1.0.0",
```

Match Vitest's existing major version (^1.0.0).

- [ ] **Step 2: Install**

Run from repo root:

```bash
cd packages/react-sdk && yarn install
```

Expected: completes without error; `@vitest/coverage-v8` appears under `node_modules/`.

- [ ] **Step 3: Commit**

```bash
git add packages/react-sdk/package.json packages/react-sdk/yarn.lock
git commit -m "build(react-sdk): add @vitest/coverage-v8 devDependency"
```

---

### Task 0.2: Add measurement-mode coverage config to react-sdk

**Files:**
- Modify: `packages/react-sdk/vitest.config.ts`

- [ ] **Step 1: Replace the existing `coverage` block**

Open `packages/react-sdk/vitest.config.ts` and replace the existing `coverage: { ... }` block inside `test:` with:

```ts
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
```

- [ ] **Step 2: Run with --coverage**

```bash
cd packages/react-sdk && yarn test:unit --coverage
```

Expected: tests pass, V8 coverage report prints to terminal, no threshold failure (because thresholds are 0). A `coverage/` directory is produced.

- [ ] **Step 3: Record baseline**

In the terminal output, copy the four overall percentages (lines/branches/functions/statements). Paste them into the commit message body. We use these later in Phase 3 to know which utils/hooks need work.

- [ ] **Step 4: Commit**

```bash
git add packages/react-sdk/vitest.config.ts
git commit -m "test(react-sdk): add coverage thresholds at 0 for measurement

Baseline (lines / branches / functions / statements):
<paste percentages from Step 3>"
```

---

### Task 0.3: Add Vitest + coverage to vite-plugin

**Files:**
- Modify: `packages/vite-plugin/package.json`
- Create: `packages/vite-plugin/vitest.config.ts`

- [ ] **Step 1: Add Vitest devDependencies and `test` script**

Edit `packages/vite-plugin/package.json`. In `devDependencies`, add:

```json
"vitest": "^1.0.0",
"@vitest/coverage-v8": "^1.0.0"
```

In `scripts`, add:

```json
"test": "vitest run"
```

(Match react-sdk's Vitest major version `^1.0.0` to keep CI consistent across packages.)

- [ ] **Step 2: Install**

```bash
cd packages/vite-plugin && yarn install
```

Expected: produces a `yarn.lock` (this package didn't have one before) and `node_modules/`.

- [ ] **Step 3: Create `packages/vite-plugin/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      // Phase 0: measurement-mode. Restored to 95 in Phase 4.
      thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
    },
  },
});
```

- [ ] **Step 4: Verify test runner works on empty test set**

```bash
cd packages/vite-plugin && yarn test
```

Expected: Vitest reports "No test files found" (exit 0 in `vitest run` mode is fine; if the runner exits non-zero on empty, we'll fix in Task 1.1 by adding the first test).

- [ ] **Step 5: Commit**

```bash
git add packages/vite-plugin/package.json packages/vite-plugin/yarn.lock packages/vite-plugin/vitest.config.ts
git commit -m "build(vite-plugin): add Vitest + coverage tooling"
```

---

### Task 0.4: Add coverage to idxdb-store

**Files:**
- Modify: `crates/idxdb-store/src/package.json`
- Modify: `crates/idxdb-store/src/vitest.config.ts`

- [ ] **Step 1: Add coverage dependency**

Edit `crates/idxdb-store/src/package.json`. In `devDependencies`, add:

```json
"@vitest/coverage-v8": "^3.0.0"
```

Note: idxdb-store uses Vitest `^3.0.0`; match that, not `^1.0.0`.

- [ ] **Step 2: Install**

```bash
cd crates/idxdb-store/src && yarn install
```

Expected: completes without error.

- [ ] **Step 3: Replace `vitest.config.ts`**

Replace the entire file contents at `crates/idxdb-store/src/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["fake-indexeddb/auto"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["ts/**/*.ts"],
      exclude: ["ts/**/*.test.ts", "ts/test-utils.ts"],
      // Phase 0: measurement-mode. Restored to 95 in Phase 4.
      thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
    },
  },
});
```

- [ ] **Step 4: Run with coverage**

```bash
cd crates/idxdb-store/src && yarn test --coverage
```

Expected: all 4 existing test files run; coverage report prints; no threshold failure.

- [ ] **Step 5: Record baseline**

Copy the four overall percentages and the per-file table for files with coverage <95%. Paste into commit message body.

- [ ] **Step 6: Commit**

```bash
git add crates/idxdb-store/src/package.json crates/idxdb-store/src/yarn.lock crates/idxdb-store/src/vitest.config.ts
git commit -m "test(idxdb-store): add coverage thresholds at 0 for measurement

Baseline (lines / branches / functions / statements):
<paste percentages from Step 5>

Per-file gaps:
<paste any file rows showing <95%>"
```

---

### Task 0.5: Add Makefile targets

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Modify `test-react-sdk`**

Find the existing block:

```makefile
.PHONY: test-react-sdk
test-react-sdk: ## Run React SDK unit tests
	cd packages/react-sdk && yarn && yarn test:unit
```

Replace its body with:

```makefile
.PHONY: test-react-sdk
test-react-sdk: ## Run React SDK unit tests with coverage
	cd packages/react-sdk && yarn && yarn test:unit --coverage
```

- [ ] **Step 2: Add new targets**

Below `test-react-sdk`, add:

```makefile
.PHONY: test-idxdb-store
test-idxdb-store: ## Run idxdb-store unit tests with coverage
	cd crates/idxdb-store/src && yarn && yarn test --coverage

.PHONY: test-vite-plugin
test-vite-plugin: ## Run vite-plugin unit tests with coverage
	cd packages/vite-plugin && yarn && yarn test --coverage

.PHONY: test-coverage
test-coverage: test-react-sdk test-idxdb-store test-vite-plugin ## Run all coverage gates
```

- [ ] **Step 3: Verify each target invokes**

```bash
make test-vite-plugin
```

Expected: runs Vitest (no tests yet → "No test files found" or similar; that's OK for now).

```bash
make test-idxdb-store
```

Expected: runs the 4 existing tests with coverage report.

(Skip `make test-react-sdk` here — it's slower and we already proved the command works in Task 0.2.)

- [ ] **Step 4: Commit**

```bash
git add Makefile
git commit -m "build: add per-package coverage make targets

- test-react-sdk now runs with --coverage
- test-idxdb-store and test-vite-plugin are new
- test-coverage runs all three gates"
```

---

### Task 0.6: Update CI workflow

**Files:**
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Augment `test-react-sdk` job**

Find the `test-react-sdk` job (search for `name: React SDK tests`). Replace its `Run unit tests` step with:

```yaml
      - name: Run unit tests with coverage
        run: cd packages/react-sdk && yarn test:unit --coverage
      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-react-sdk
          path: packages/react-sdk/coverage
```

- [ ] **Step 2: Add `test-idxdb-store` job**

Insert this job below `test-react-sdk` (or anywhere in the `jobs:` block; order doesn't matter for execution):

```yaml
  test-idxdb-store:
    name: idxdb-store unit tests
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: yarn
          cache-dependency-path: crates/idxdb-store/src/yarn.lock
      - name: Install dependencies
        run: ./scripts/retry-yarn-install.sh crates/idxdb-store/src
      - name: Run unit tests with coverage
        run: cd crates/idxdb-store/src && yarn test --coverage
      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-idxdb-store
          path: crates/idxdb-store/src/coverage
```

- [ ] **Step 3: Add `test-vite-plugin` job**

Insert below `test-idxdb-store`:

```yaml
  test-vite-plugin:
    name: vite-plugin unit tests
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: yarn
          cache-dependency-path: packages/vite-plugin/yarn.lock
      - name: Install dependencies
        run: ./scripts/retry-yarn-install.sh packages/vite-plugin
      - name: Run unit tests with coverage
        run: cd packages/vite-plugin && yarn test --coverage
      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-vite-plugin
          path: packages/vite-plugin/coverage
```

- [ ] **Step 4: Verify YAML is valid**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml'))"
```

Expected: no output (success); any output indicates a YAML parse error.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add coverage gates for react-sdk, idxdb-store, vite-plugin

Each package's unit test job now runs Vitest with --coverage and
uploads the coverage/ folder as an artifact. Thresholds are at 0
(measurement mode); they will be raised to 95 once tests are written."
```

---

## Phase 1 — vite-plugin tests (from scratch)

The vite-plugin package's `src/index.ts` (161 lines) has zero tests today. Goal: cover all four metrics ≥95% on `src/index.ts`.

### Task 1.1: First failing test for the plugin factory

**Files:**
- Create: `packages/vite-plugin/src/__tests__/midenVitePlugin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/vite-plugin/src/__tests__/midenVitePlugin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { midenVitePlugin } from "../index.js";

describe("midenVitePlugin", () => {
  it("returns a Vite plugin object with the expected name and enforce", () => {
    const plugin = midenVitePlugin();
    expect(plugin.name).toBe("@miden-sdk/vite-plugin");
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.config).toBe("function");
    expect(typeof plugin.configResolved).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd packages/vite-plugin && yarn test
```

Expected: PASS. (We're testing existing code, so the rhythm is "write test → run → confirm pass" for this whole phase.)

- [ ] **Step 3: Confirm coverage report shows progress**

```bash
cd packages/vite-plugin && yarn test --coverage
```

Look at the report. The `index.ts` row should show some non-zero coverage. Note the missing lines/branches in the per-file table; you'll target them in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add packages/vite-plugin/src/__tests__/midenVitePlugin.test.ts
git commit -m "test(vite-plugin): cover plugin factory shape"
```

---

### Task 1.2: Test the `config()` hook output

**Files:**
- Modify: `packages/vite-plugin/src/__tests__/midenVitePlugin.test.ts`
- Or create: `packages/vite-plugin/src/__tests__/config.test.ts`

(One file or two is a judgment call; create `config.test.ts` for separation since the `config()` hook is a substantial unit.)

- [ ] **Step 1: Create `config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { ConfigEnv, UserConfig } from "vite";
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

  it("falls back to node_modules path when require.resolve throws", () => {
    // Use a bogus package name that won't be installed.
    const result = callConfig(
      midenVitePlugin({ wasmPackages: ["definitely-not-installed-xyz"] })
    );
    const alias = result.resolve.alias;
    expect(Array.isArray(alias)).toBe(true);
    expect(alias.length).toBe(1);
    // Replacement falls back to <root>/node_modules/<pkg>
    expect(alias[0].replacement).toMatch(/node_modules.+definitely-not-installed-xyz$/);
  });

  it("uses resolved package path when require.resolve succeeds", () => {
    // 'vitest' is guaranteed installed (devDependency).
    const result = callConfig(midenVitePlugin({ wasmPackages: ["vitest"] }));
    const alias = result.resolve.alias;
    expect(alias[0].replacement).not.toMatch(/node_modules\/vitest$/);
    // The resolved path is the directory containing vitest's package.json
    expect(alias[0].replacement).toMatch(/vitest/);
  });

  it("escapes regex metacharacters in package names", () => {
    const result = callConfig(
      midenVitePlugin({ wasmPackages: ["@scope/pkg-with.dots"] })
    );
    const alias = result.resolve.alias;
    const regex: RegExp = alias[0].find;
    expect(regex.test("@scope/pkg-with.dots")).toBe(true);
    // The dot in the package name must NOT match arbitrary chars
    expect(regex.test("@scope/pkg-withXdots")).toBe(false);
  });

  it("does not set COOP/COEP headers by default", () => {
    const result = callConfig(midenVitePlugin());
    expect(result.server.headers).toBeUndefined();
    expect(result.preview.headers).toBeUndefined();
  });

  it("sets COOP/COEP headers when crossOriginIsolation is true", () => {
    const result = callConfig(
      midenVitePlugin({ crossOriginIsolation: true })
    );
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
    const result = callConfig(midenVitePlugin(), {}, {
      command: "serve",
      mode: "development",
    });
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
    const result = callConfig(midenVitePlugin(), {}, {
      command: "build",
      mode: "production",
    });
    expect(result.server.proxy).toBeUndefined();
  });

  it("uses userConfig.root when provided", () => {
    const result = callConfig(midenVitePlugin({ wasmPackages: ["nope-xyz"] }), {
      root: "/custom/root",
    });
    // Fallback path uses the supplied root
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
```

- [ ] **Step 2: Run the tests**

```bash
cd packages/vite-plugin && yarn test
```

Expected: all tests in `config.test.ts` pass.

- [ ] **Step 3: Coverage check**

```bash
cd packages/vite-plugin && yarn test --coverage
```

Expected: per-file coverage for `src/index.ts` jumps. Note any remaining uncovered lines.

- [ ] **Step 4: Commit**

```bash
git add packages/vite-plugin/src/__tests__/config.test.ts
git commit -m "test(vite-plugin): cover config() hook outputs and option defaults"
```

---

### Task 1.3: Test the `configResolved()` hook

**Files:**
- Create: `packages/vite-plugin/src/__tests__/configResolved.test.ts`

- [ ] **Step 1: Write the test file**

```ts
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
```

- [ ] **Step 2: Run**

```bash
cd packages/vite-plugin && yarn test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/vite-plugin/src/__tests__/configResolved.test.ts
git commit -m "test(vite-plugin): cover configResolved() injection and idempotence"
```

---

### Task 1.4: Test the `externalizeMidenReact` esbuild plugin

**Files:**
- Create: `packages/vite-plugin/src/__tests__/externalize.test.ts`

The `externalizeMidenReact` plugin is module-private, but it's reachable through the `configResolved` hook (the plugin appends it to `esbuildOptions.plugins`). We pull it out and call its `setup()` directly.

- [ ] **Step 1: Write the test file**

```ts
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
```

- [ ] **Step 2: Run**

```bash
cd packages/vite-plugin && yarn test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/vite-plugin/src/__tests__/externalize.test.ts
git commit -m "test(vite-plugin): cover externalizeMidenReact esbuild plugin"
```

---

### Task 1.5: Coverage check + gap-fill for vite-plugin

- [ ] **Step 1: Run with coverage**

```bash
cd packages/vite-plugin && yarn test --coverage
```

- [ ] **Step 2: Read the report**

Look at the per-file coverage table. For `src/index.ts`, all four metrics should be ≥95%. If not, the report will list specific uncovered line ranges.

- [ ] **Step 3: For each uncovered line range, add a targeted test**

Pattern: identify the branch that's uncovered (e.g., a specific option default, an error path), write a test that exercises it. Add to whichever existing test file is closest in scope.

If a branch genuinely cannot be tested (e.g., a fallback that depends on Node internals), add `/* v8 ignore next */` ABOVE that line with a one-line justification, then commit separately:

```bash
git commit -m "test(vite-plugin): mark <line> as v8-ignored — <reason>"
```

- [ ] **Step 4: Confirm 95% reached**

```bash
cd packages/vite-plugin && yarn test --coverage
```

The summary should show all four metrics ≥95% for `src/index.ts`.

- [ ] **Step 5: Commit any gap-fill tests**

```bash
git add packages/vite-plugin/src/__tests__/
git commit -m "test(vite-plugin): gap-fill to ≥95% coverage"
```

(Skip if no gap-fill was needed.)

---

## Phase 2 — idxdb-store tests

idxdb-store source files needing tests (per spec):

- `utils.ts` (51 lines) — pure helpers; fastest to test
- `settings.ts` (71 lines) — get/insert/remove/list
- `auth.ts` (140 lines)
- `transactions.ts` (165 lines)
- `import.ts` (116 lines) + `export.ts` (73 lines) — paired (round-trip)
- `sync.ts` (432 lines) — biggest

Plus gap-fill on existing `accounts.test.ts`, `chainData.test.ts`, `notes.test.ts`, `schema.test.ts`.

Read `crates/idxdb-store/src/ts/notes.test.ts` first to learn the existing test pattern (DB-per-test setup with afterEach cleanup) and reuse it.

### Task 2.1: Test `utils.ts`

**Files:**
- Create: `crates/idxdb-store/src/ts/utils.test.ts`

- [ ] **Step 1: Read source**

Open `crates/idxdb-store/src/ts/utils.ts` to see the three exports: `mapOption`, `logWebStoreError`, `uint8ArrayToBase64`.

- [ ] **Step 2: Write the test file**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { mapOption, logWebStoreError, uint8ArrayToBase64 } from "./utils.js";

describe("mapOption", () => {
  it("applies the function when value is defined", () => {
    expect(mapOption(5, (n) => n * 2)).toBe(10);
  });

  it("returns undefined when value is null", () => {
    expect(mapOption<number, number>(null, (n) => n * 2)).toBeUndefined();
  });

  it("returns undefined when value is undefined", () => {
    expect(mapOption<number, number>(undefined, (n) => n * 2)).toBeUndefined();
  });

  it("treats 0 and empty string as defined", () => {
    expect(mapOption(0, (n) => n + 1)).toBe(1);
    expect(mapOption("", (s) => s.length)).toBe(0);
  });
});

describe("uint8ArrayToBase64", () => {
  it("encodes bytes correctly", () => {
    expect(uint8ArrayToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
  });

  it("encodes an empty array to an empty string", () => {
    expect(uint8ArrayToBase64(new Uint8Array([]))).toBe("");
  });
});

describe("logWebStoreError", () => {
  let errorSpy: any;
  let traceSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    traceSpy = vi.spyOn(console, "trace").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    traceSpy.mockRestore();
  });

  it("logs and rethrows a Dexie error with context", () => {
    const err = new Dexie.DexieError("OpenError", "DB closed");
    expect(() => logWebStoreError(err, "ctx")).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ctx: Indexdb error")
    );
  });

  it("logs a Dexie error without context", () => {
    const err = new Dexie.DexieError("OpenError", "DB closed");
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Indexdb error:/)
    );
  });

  it("logs a Dexie error's stack when present", () => {
    const err = new Dexie.DexieError("OpenError", "DB closed");
    (err as any).stack = "stack-line";
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stacktrace")
    );
  });

  it("recurses into Dexie inner exception", () => {
    const inner = new Error("inner-cause");
    const err = new Dexie.DexieError("OpenError", "outer");
    (err as any).inner = inner;
    expect(() => logWebStoreError(err)).toThrow();
    // Both outer and inner should have produced log entries.
    expect(errorSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it("logs a plain Error with stack", () => {
    const err = new Error("boom");
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error")
    );
  });

  it("logs a plain Error without stack", () => {
    const err = new Error("boom");
    err.stack = undefined;
    expect(() => logWebStoreError(err)).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected error")
    );
  });

  it("logs and rethrows a non-Error value", () => {
    expect(() => logWebStoreError({ thrown: "thing" })).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("non-error value")
    );
    expect(traceSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run**

```bash
cd crates/idxdb-store/src && yarn test ts/utils.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/idxdb-store/src/ts/utils.test.ts
git commit -m "test(idxdb-store): cover utils helpers"
```

---

### Task 2.2: Test `settings.ts`

**Files:**
- Create: `crates/idxdb-store/src/ts/settings.test.ts`

- [ ] **Step 1: Read source**

Open `crates/idxdb-store/src/ts/settings.ts` to see exports: `getSetting`, `insertSetting`, `removeSetting`, `listSettingKeys`, plus the `INTERNAL_SETTING_KEYS` filter.

- [ ] **Step 2: Read `notes.test.ts` for the DB setup pattern**

The pattern is: `openDatabase(dbName, schemaVersion)` to open + register, `getDatabase(dbName)` to retrieve, then in `afterEach` close and delete each opened DB.

- [ ] **Step 3: Write the test file**

```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { openDatabase, getDatabase, CLIENT_VERSION_SETTING_KEY } from "./schema.js";
import {
  getSetting,
  insertSetting,
  removeSetting,
  listSettingKeys,
} from "./settings.js";

let dbCounter = 0;
function uniqueDbName(): string {
  return `test-settings-${++dbCounter}-${Date.now()}`;
}

const openDbIds: string[] = [];

afterEach(async () => {
  for (const dbId of openDbIds) {
    const db = getDatabase(dbId);
    db.dexie.close();
    await db.dexie.delete();
  }
  openDbIds.length = 0;
});

async function openTestDb(): Promise<string> {
  const name = uniqueDbName();
  await openDatabase(name, "0.1.0");
  openDbIds.push(name);
  return name;
}

describe("settings", () => {
  it("returns null when key is missing", async () => {
    const dbId = await openTestDb();
    const result = await getSetting(dbId, "nope");
    expect(result).toBeNull();
  });

  it("inserts and retrieves a setting", async () => {
    const dbId = await openTestDb();
    const value = new Uint8Array([1, 2, 3]);
    await insertSetting(dbId, "k1", value);
    const got = await getSetting(dbId, "k1");
    expect(got).toEqual({ key: "k1", value: "AQID" });
  });

  it("upserts on duplicate key", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, "k1", new Uint8Array([1]));
    await insertSetting(dbId, "k1", new Uint8Array([2]));
    const got = await getSetting(dbId, "k1");
    expect(got!.value).toBe("Ag==");
  });

  it("removes a setting", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, "k1", new Uint8Array([1]));
    await removeSetting(dbId, "k1");
    expect(await getSetting(dbId, "k1")).toBeNull();
  });

  it("removeSetting on a missing key is a no-op", async () => {
    const dbId = await openTestDb();
    await removeSetting(dbId, "nope");
    // No throw means success.
  });

  it("listSettingKeys excludes internal keys", async () => {
    const dbId = await openTestDb();
    await insertSetting(dbId, "user-a", new Uint8Array([1]));
    await insertSetting(dbId, "user-b", new Uint8Array([2]));
    await insertSetting(
      dbId,
      CLIENT_VERSION_SETTING_KEY,
      new Uint8Array([3])
    );
    const keys = await listSettingKeys(dbId);
    expect(keys).toEqual(expect.arrayContaining(["user-a", "user-b"]));
    expect(keys).not.toContain(CLIENT_VERSION_SETTING_KEY);
  });

  it("listSettingKeys returns empty list when no user keys are present", async () => {
    const dbId = await openTestDb();
    const keys = await listSettingKeys(dbId);
    expect(keys).toEqual([]);
  });

  it("getSetting throws on Dexie error (e.g., db not opened)", async () => {
    await expect(getSetting("never-opened", "k")).rejects.toThrow();
  });

  it("insertSetting throws on Dexie error", async () => {
    await expect(
      insertSetting("never-opened", "k", new Uint8Array([1]))
    ).rejects.toThrow();
  });

  it("removeSetting throws on Dexie error", async () => {
    await expect(removeSetting("never-opened", "k")).rejects.toThrow();
  });

  it("listSettingKeys throws on Dexie error", async () => {
    await expect(listSettingKeys("never-opened")).rejects.toThrow();
  });
});
```

(Suppress the `console.error` noise from `logWebStoreError` if it dominates the test output; add `vi.spyOn(console, "error").mockImplementation(() => {})` in a `beforeEach` if needed.)

- [ ] **Step 4: Run**

```bash
cd crates/idxdb-store/src && yarn test ts/settings.test.ts
```

Expected: all tests pass. If any fail because of an API mismatch with `schema.ts`'s `CLIENT_VERSION_SETTING_KEY` export, read `schema.ts` and adjust the import.

- [ ] **Step 5: Commit**

```bash
git add crates/idxdb-store/src/ts/settings.test.ts
git commit -m "test(idxdb-store): cover settings get/insert/remove/list and error paths"
```

---

### Task 2.3: Test `auth.ts`

**Files:**
- Create: `crates/idxdb-store/src/ts/auth.test.ts`

- [ ] **Step 1: Read source and existing test**

`crates/idxdb-store/src/ts/auth.ts`. Identify exported functions and their parameters. Read one existing test (e.g. `chainData.test.ts`) for the DB-bootstrap pattern.

- [ ] **Step 2: Write the test file**

Use the same DB setup boilerplate (`uniqueDbName` / `openTestDb` / `afterEach` cleanup) from Task 2.2.

For each exported function in `auth.ts`:
- Test the happy path (insert + retrieve a row).
- Test the missing-record path (returns null/undefined or throws as appropriate to the function's contract — read the source to determine which).
- Test the error path (call against a never-opened DB to provoke `logWebStoreError` rethrow).

If the file has functions that handle multiple discriminants (e.g., different auth secret types), test each discriminant with at least one happy-path case.

- [ ] **Step 3: Run**

```bash
cd crates/idxdb-store/src && yarn test ts/auth.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/idxdb-store/src/ts/auth.test.ts
git commit -m "test(idxdb-store): cover auth secret storage and retrieval"
```

---

### Task 2.4: Test `transactions.ts`

**Files:**
- Create: `crates/idxdb-store/src/ts/transactions.test.ts`

- [ ] **Step 1: Read source**

`crates/idxdb-store/src/ts/transactions.ts`. Note: 165 lines is small enough to read fully. Identify exports.

- [ ] **Step 2: Write the test file**

Use the same DB setup. For each exported function:
- Insert one or more transactions (round-trip).
- List/filter (every filter argument exercised: by status, by account, by block height, etc., based on what the source actually exposes).
- Cover each error path with a never-opened-DB test.

- [ ] **Step 3: Run**

```bash
cd crates/idxdb-store/src && yarn test ts/transactions.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/idxdb-store/src/ts/transactions.test.ts
git commit -m "test(idxdb-store): cover transaction CRUD and filters"
```

---

### Task 2.5: Test `import.ts` and `export.ts` (round-trip)

**Files:**
- Create: `crates/idxdb-store/src/ts/import.test.ts`
- Create: `crates/idxdb-store/src/ts/export.test.ts`

These two are paired — `export` produces a payload, `import` consumes one. Test each individually with mocked payloads, then add one round-trip test in `import.test.ts`.

- [ ] **Step 1: Read source for both**

`crates/idxdb-store/src/ts/export.ts` (73 lines) and `crates/idxdb-store/src/ts/import.ts` (116 lines).

- [ ] **Step 2: Write `export.test.ts`**

Insert a few records (account, note, transaction — use existing helpers from notes.test.ts pattern), call the export function, verify the payload shape (keys, types) and approximate content.

- [ ] **Step 3: Run export tests**

```bash
cd crates/idxdb-store/src && yarn test ts/export.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Write `import.test.ts`**

Test cases:
- Import a fresh DB from an exported payload (round-trip): export from DB-A, open DB-B, import into B, verify records match.
- Import with a schema-version mismatch: construct a payload whose declared version is incompatible; assert the function errors out (read source to confirm exact error mechanism — throw vs. return).
- Import a malformed payload (e.g., missing required field) → error path.

- [ ] **Step 5: Run import tests**

```bash
cd crates/idxdb-store/src && yarn test ts/import.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/idxdb-store/src/ts/export.test.ts crates/idxdb-store/src/ts/import.test.ts
git commit -m "test(idxdb-store): cover export/import round-trip and error paths"
```

---

### Task 2.6: Test `sync.ts`

**Files:**
- Create: `crates/idxdb-store/src/ts/sync.test.ts`

This is the largest file (432 lines). Plan for ~15-25 test cases.

- [ ] **Step 1: Read source**

`crates/idxdb-store/src/ts/sync.ts`. Inventory: list every exported function and every distinct branch (each `if`/`switch` arm, each `try`/`catch`, each early-return).

- [ ] **Step 2: Sketch the test list**

Before writing tests, write the test names as `it.todo()` first so you have a coverage target:

```ts
describe("sync", () => {
  it.todo("getSyncHeight returns 0 when no record exists");
  it.todo("getSyncHeight returns the persisted height");
  // ... one .todo per branch
});
```

Run `yarn test ts/sync.test.ts` to confirm the file is picked up; the `.todo`s are reported as pending.

- [ ] **Step 3: Replace each `.todo` with an actual test**

Work through the list, writing one test per `.todo` and running `yarn test ts/sync.test.ts` after each batch of 3-5.

- [ ] **Step 4: Run**

```bash
cd crates/idxdb-store/src && yarn test ts/sync.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Coverage check on this file**

```bash
cd crates/idxdb-store/src && yarn test --coverage
```

Look at `ts/sync.ts` row in the per-file table. If <95%, see the next task for gap-fill.

- [ ] **Step 6: Commit**

```bash
git add crates/idxdb-store/src/ts/sync.test.ts
git commit -m "test(idxdb-store): cover sync state operations and rollback"
```

---

### Task 2.7: idxdb-store gap-fill on existing test files

After Tasks 2.1–2.6, the new files have substantial coverage. Now we need to lift the existing test files (`schema`, `accounts`, `chainData`, `notes`) over the 95% bar.

- [ ] **Step 1: Run full coverage**

```bash
cd crates/idxdb-store/src && yarn test --coverage
```

- [ ] **Step 2: Read the per-file table**

For each source file in `ts/` with any of {lines, branches, functions, statements} <95%, note the missing line ranges from the report.

- [ ] **Step 3: For each gap, add a test**

Open the corresponding `*.test.ts`, look up the missing lines in the source, write a test that exercises that branch.

If a branch genuinely cannot be tested (e.g., a real IndexedDB transaction-abort path that `fake-indexeddb` doesn't model — see spec risk register), add `/* v8 ignore next */` ABOVE the line in the source file with a one-line comment explaining why. Example:

```ts
// fake-indexeddb does not emit a transaction abort for this case;
// this branch is exercised in real-browser Playwright tests.
/* v8 ignore next */
if (txn.error) handleAbort(txn.error);
```

- [ ] **Step 4: Re-run coverage**

```bash
cd crates/idxdb-store/src && yarn test --coverage
```

Confirm all four metrics ≥95% across the package summary.

- [ ] **Step 5: Commit**

```bash
git add crates/idxdb-store/src/ts/
git commit -m "test(idxdb-store): gap-fill existing test files to ≥95% coverage"
```

---

## Phase 3 — react-sdk gap-fill

react-sdk already has 47 tests. This phase is purely measurement-driven: see what's uncovered, write tests for it.

### Task 3.1: Identify untested utilities

**Files:**
- Read: `packages/react-sdk/src/utils/`
- Compare to: `packages/react-sdk/src/__tests__/utils/`

- [ ] **Step 1: List utils with no test partner**

```bash
cd packages/react-sdk
ls src/utils/ | grep '\.ts$' | sort > /tmp/utils.txt
ls src/__tests__/utils/ | grep '\.test\.ts$' | sed 's/\.test\.ts$/.ts/' | sort > /tmp/util-tests.txt
comm -23 /tmp/utils.txt /tmp/util-tests.txt
```

The output lists utilities with no test partner.

- [ ] **Step 2: Run coverage to see actual gap**

```bash
cd packages/react-sdk && yarn test:unit --coverage
```

In the per-file report, find each util listed in Step 1's output. Note the line/branch/function/statement percentages. Files with non-trivial logic and <95% need tests.

- [ ] **Step 3: Note files for Tasks 3.2-3.4**

Write the list of files needing tests into a scratch note (commit message body or just notepad). For each, decide:
- "trivial logic, just type re-exports" → exclude in `vitest.config.ts` (add to the `exclude` list with a comment)
- "non-trivial logic" → write a test in Task 3.2

This is a measurement step, not a code change. No commit yet.

---

### Task 3.2: Write tests for untested utilities

**Files:**
- Create: `packages/react-sdk/src/__tests__/utils/<name>.test.ts` for each util identified in Task 3.1

Apply this loop **per util file** identified:

- [ ] **Step 1: Read the util source**

E.g., `packages/react-sdk/src/utils/amounts.ts`. Identify exports.

- [ ] **Step 2: Write a test file**

Pattern (using `amounts.ts` as illustrative example — replace name and assertions per actual util):

```ts
import { describe, it, expect } from "vitest";
import { /* exports */ } from "../../utils/amounts";

describe("amounts", () => {
  it("<happy path>", () => {
    // ...
  });

  it("<edge case>", () => {
    // ...
  });

  it("<error path>", () => {
    // ...
  });
});
```

For pure utility functions, prioritize:
- Each input-validation branch (one test per `if` / `throw`).
- Each return type variant (e.g., a function returning `T | null` needs both a non-null and a null case).
- Each loop boundary (empty input, single-element, multi-element).

- [ ] **Step 3: Run the test file**

```bash
cd packages/react-sdk && yarn test:unit src/__tests__/utils/<name>.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/react-sdk/src/__tests__/utils/<name>.test.ts
git commit -m "test(react-sdk): cover utils/<name>"
```

Repeat Steps 1-4 for each util identified in Task 3.1.

---

### Task 3.3: Branch-coverage gap-fill on hooks

- [ ] **Step 1: Run coverage**

```bash
cd packages/react-sdk && yarn test:unit --coverage
```

- [ ] **Step 2: List hooks <95% on any metric**

For each hook file (`src/hooks/use*.ts`) in the per-file report with any of {lines, branches, functions, statements} <95%, note the file and the uncovered line ranges.

- [ ] **Step 3: For each, add a test case**

Open the corresponding `src/__tests__/hooks/<hook>.test.tsx`. Read the source line range that's uncovered — typically these are error paths (e.g., `catch` blocks, "if signer is null" guards, "if account not loaded" guards).

For each uncovered branch, add a test case that puts the hook in the state required to hit it. Use the existing tests in the file as a pattern; the testing setup (mocks, providers, query client) is already wired up by `setup.ts` — you only need to add new `it()` blocks.

Example sketch (replace with real hook):

```tsx
it("returns the error state when the SDK throws", async () => {
  vi.mocked(midenSdk.someCall).mockRejectedValueOnce(new Error("boom"));
  const { result } = renderHook(() => useFoo(), { wrapper });
  await waitFor(() => expect(result.current.error).toBeDefined());
});
```

- [ ] **Step 4: Run after each batch of 3-5 additions**

```bash
cd packages/react-sdk && yarn test:unit src/__tests__/hooks/<file>
```

Expected: tests pass.

- [ ] **Step 5: Commit per logical group of hooks**

```bash
git add packages/react-sdk/src/__tests__/hooks/
git commit -m "test(react-sdk): branch-coverage gap-fill on hooks"
```

---

### Task 3.4: Branch-coverage gap-fill on context/store

- [ ] **Step 1: Run coverage**

```bash
cd packages/react-sdk && yarn test:unit --coverage
```

- [ ] **Step 2: Same gap-driven pattern as Task 3.3, but for**:

- `src/context/MidenProvider.tsx`
- `src/context/MultiSignerProvider.tsx`
- `src/context/SignerContext.ts`
- `src/store/MidenStore.ts` (if its test partner shows <95%)

- [ ] **Step 3: Add tests in `src/__tests__/context/` and `src/__tests__/store/`**

Same pattern: identify uncovered line range, write a test that triggers it.

- [ ] **Step 4: Run + commit**

```bash
cd packages/react-sdk && yarn test:unit
git add packages/react-sdk/src/__tests__/context/ packages/react-sdk/src/__tests__/store/
git commit -m "test(react-sdk): branch-coverage gap-fill on context/store"
```

---

### Task 3.5: Final react-sdk coverage check

- [ ] **Step 1: Run full coverage**

```bash
cd packages/react-sdk && yarn test:unit --coverage
```

- [ ] **Step 2: Confirm all four overall metrics ≥95%**

If anything is still <95%, repeat the gap-fill pattern from Tasks 3.2–3.4. If a specific branch resists testing, add `/* v8 ignore next */` with a justification comment AS A SEPARATE COMMIT (so the v8-ignore use is auditable in `git log`):

```bash
# Edit source to add /* v8 ignore next */ with comment
git add packages/react-sdk/src/<file>
git commit -m "test(react-sdk): mark <file>:<line> as v8-ignored — <reason>"
```

- [ ] **Step 3: No-op commit if already at 95%**

If everything is already green, no commit needed for this task.

---

## Phase 4 — Tighten thresholds and verify in CI

### Task 4.1: Restore vite-plugin threshold to 95

**Files:**
- Modify: `packages/vite-plugin/vitest.config.ts`

- [ ] **Step 1: Edit thresholds**

Change:

```ts
thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 },
```

to:

```ts
thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
```

Remove the "// Phase 0" comment.

- [ ] **Step 2: Run**

```bash
cd packages/vite-plugin && yarn test --coverage
```

Expected: PASS (no threshold violation).

If a threshold is violated, return to Task 1.5 and add tests until green. Do NOT lower the threshold to "make it pass".

- [ ] **Step 3: Commit**

```bash
git add packages/vite-plugin/vitest.config.ts
git commit -m "test(vite-plugin): enforce 95% coverage threshold"
```

---

### Task 4.2: Restore idxdb-store threshold to 95

**Files:**
- Modify: `crates/idxdb-store/src/vitest.config.ts`

- [ ] **Step 1: Edit thresholds**

Change all four metrics from 0 to 95. Remove the "// Phase 0" comment.

- [ ] **Step 2: Run**

```bash
cd crates/idxdb-store/src && yarn test --coverage
```

Expected: PASS.

If failing, return to Task 2.7 and gap-fill.

- [ ] **Step 3: Commit**

```bash
git add crates/idxdb-store/src/vitest.config.ts
git commit -m "test(idxdb-store): enforce 95% coverage threshold"
```

---

### Task 4.3: Restore react-sdk threshold to 95

**Files:**
- Modify: `packages/react-sdk/vitest.config.ts`

- [ ] **Step 1: Edit thresholds**

Change all four metrics from 0 to 95. Remove the "// Phase 0" comment.

- [ ] **Step 2: Run**

```bash
cd packages/react-sdk && yarn test:unit --coverage
```

Expected: PASS.

If failing, return to Task 3.5.

- [ ] **Step 3: Commit**

```bash
git add packages/react-sdk/vitest.config.ts
git commit -m "test(react-sdk): enforce 95% coverage threshold"
```

---

### Task 4.4: Verify CI is green

- [ ] **Step 1: Ask the user before pushing**

This implementation is now complete locally. CI verification requires a push to GitHub, which the user must explicitly authorize (per global rule: "Never push without explicit request"). Stop here and ask:

> "All four phases done locally. Vitest passes ≥95% on all three packages. Want me to push the branch so CI can verify?"

If approved, push the branch the user is working on:

```bash
git push origin <current-branch>
```

If declined, hand the branch back without pushing.

- [ ] **Step 2: Watch the three relevant jobs in CI**

Use `gh pr checks` or the GitHub web UI. The three jobs:
- `React SDK tests`
- `idxdb-store unit tests`
- `vite-plugin unit tests`

Expected: all three green.

- [ ] **Step 3: If any job is red, diagnose**

The two likely failure modes:
- **Threshold miss in CI but pass locally.** Usually means some platform-specific code path runs in CI but not locally (e.g., a `process.platform` check). Pull the coverage artifact from the failing run, find the gap, add a test that covers it via mock, push.
- **Test failure (not a threshold issue).** Read the logs, fix, push.

Do NOT lower thresholds in response to a CI failure.

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add <changed files>
git commit -m "test: fix CI-only coverage gap in <package>"
git push
```

---

## Self-review — to run after writing this plan, before sharing

(This section is for the plan author; it does not need to be executed by the implementer.)

**Spec coverage check:**
- ✅ V8 provider, per-package, 95 across all four metrics → covered in Tasks 0.2/0.3/0.4 (config) and 4.1/4.2/4.3 (enforcement).
- ✅ Strict exclusions (only types, barrels, generated, tests) → covered in Tasks 0.2/0.3/0.4.
- ✅ Untestable code requires `/* v8 ignore */` with justification, never silent → called out in Tasks 1.5, 2.7, 3.3, 3.5.
- ✅ CI shape: augment `test-react-sdk`; add `test-idxdb-store` + `test-vite-plugin` parallel jobs → Task 0.6.
- ✅ Makefile additions → Task 0.5.
- ✅ All three packages → Phases 1, 2, 3.
- ✅ Coverage reports uploaded as artifacts on every run → Task 0.6 (`if: always()`).
- ✅ Rollback path: thresholds can be reverted to 0 to disable enforcement without losing infra → implied by the Phase 0 / Phase 4 split.
- ✅ Acceptance criteria → Task 4.4 (all three jobs green, every v8-ignore has a comment).

**Placeholder scan:** No "TBD", no "TODO", no "implement later", no "similar to Task N" without the actual code, no test-writing instructions without concrete examples.

**Type consistency:** Function names match across tasks (`midenVitePlugin`, `getSetting`, `insertSetting`, `removeSetting`, `listSettingKeys`, `mapOption`, `logWebStoreError`, `uint8ArrayToBase64`, `openDatabase`, `getDatabase`). Parameter shapes are consistent. Threshold key names (`lines`, `branches`, `functions`, `statements`) are consistent across all three configs.

No issues found.
