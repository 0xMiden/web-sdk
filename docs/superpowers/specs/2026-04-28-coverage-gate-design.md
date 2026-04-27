# Test Coverage Gate (95% across all four metrics)

**Date:** 2026-04-28
**Branch:** wiktor-tests
**Status:** Spec — pending user review

## Goal

Add a CI gate that fails any PR whose Vitest unit-test coverage drops below 95%
on lines, branches, functions, and statements, across all three of the
repository's JS/TS packages. Implement the tests required to make the gate pass.

## Scope

In scope:

- `packages/react-sdk` — React hooks SDK (~6,959 source LOC, 47 existing tests).
- `crates/idxdb-store/src/ts` — TypeScript IndexedDB store (~3,419 LOC, 4 tests).
- `packages/vite-plugin` — Vite plugin (~161 LOC, 0 tests, no Vitest setup).

Out of scope (see "Non-goals" below):

- Rust crate coverage.
- Playwright integration tests.
- Test-quality / mutation testing.
- Coverage-trend enforcement (no "must not decrease" rule).
- The committed `crates/idxdb-store/src/js/` JS output (verified separately by
  the existing `Check TSC output equals committed JS` CI step).

## Decisions

| Topic | Decision |
|---|---|
| Provider | V8 (`@vitest/coverage-v8`) |
| Threshold | 95% on lines, branches, functions, statements |
| Threshold scope | Per-package (each package independently gated in its own job) |
| Exclusions | Strict — only type-only files, generated code, entry barrels, and test files |
| Untestable code | `/* v8 ignore */` only with a written justification — never silent |
| CI shape | Augment existing `test-react-sdk`; add parallel `test-idxdb-store` and `test-vite-plugin` jobs |

## Architecture

Each package owns a `vitest.config.ts` with:

```ts
test: {
  coverage: {
    provider: "v8",
    reporter: ["text", "json", "html", "lcov"],
    include: ["<sources>"],
    exclude: ["<tests, types, barrels>"],
    thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
  },
}
```

CI runs `yarn test --coverage` (or `yarn test:unit --coverage`) per package in
parallel jobs. Vitest's threshold mechanism causes a non-zero exit on miss,
which fails the job. Coverage reports upload as artifacts on every run
(success or failure) for diagnostic value.

### Per-package configuration

**`packages/react-sdk/vitest.config.ts`** — extend existing config:

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
  thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
}
```

**`packages/vite-plugin/vitest.config.ts`** — new file:

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
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
```

Add to `packages/vite-plugin/package.json`:

- `devDependencies`: `vitest`, `@vitest/coverage-v8`
- `scripts.test`: `"vitest run"`

**`crates/idxdb-store/src/vitest.config.ts`** — extend existing config:

```ts
test: {
  environment: "node",
  setupFiles: ["fake-indexeddb/auto"],
  coverage: {
    provider: "v8",
    reporter: ["text", "json", "html", "lcov"],
    include: ["ts/**/*.ts"],
    exclude: ["ts/**/*.test.ts", "ts/test-utils.ts"],
    thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
  },
}
```

Add `@vitest/coverage-v8` to `devDependencies`.

### CI workflow changes (`.github/workflows/test.yml`)

**Modify `test-react-sdk` job:**

- Replace `make test-react-sdk` with `cd packages/react-sdk && yarn test:unit --coverage`.
- Add a post-step that uploads `packages/react-sdk/coverage` as artifact
  `coverage-react-sdk` with `if: always()`.

**Add `test-idxdb-store` job:**

- Same shape as `test-react-sdk` but no dependency on `build-web-client-dist-folder`.
- Steps: checkout, setup-node@v4 (cache yarn from `crates/idxdb-store/src/yarn.lock`),
  install via `./scripts/retry-yarn-install.sh crates/idxdb-store/src`, run
  `cd crates/idxdb-store/src && yarn test --coverage`, upload coverage artifact.

**Add `test-vite-plugin` job:**

- Same shape; cache yarn from `packages/vite-plugin/yarn.lock` (will be
  generated when Vitest is added). No WASM dependency.

All three jobs run in parallel with each other and with the existing matrix.
Per-package failure pinpoints which package broke.

### Makefile additions

```makefile
test-idxdb-store: ## Run idxdb-store unit tests with coverage
	cd crates/idxdb-store/src && yarn && yarn test --coverage

test-vite-plugin: ## Run vite-plugin unit tests with coverage
	cd packages/vite-plugin && yarn && yarn test --coverage

test-coverage: test-react-sdk test-idxdb-store test-vite-plugin ## Run all coverage gates
```

The existing `test-react-sdk` target will be modified to pass `--coverage`.

## Implementation plan

The work proceeds in five steps. Step 1 (measurement) precedes any
test-writing so we don't speculate about gaps.

### Step 1 — Establish baseline

- Add the threshold blocks (Section "Per-package configuration") to all three
  packages, **with thresholds temporarily set to 0** so reports run without
  failing.
- Run `yarn test --coverage` (or `yarn test:unit --coverage`) per package.
- Record per-file line/branch/function/statement gaps from the V8 reports.
- Use those gaps to drive Steps 2–4.

### Step 2 — `packages/vite-plugin` (from scratch)

Add Vitest, write tests for all logic in `src/index.ts`. Test files in
`packages/vite-plugin/src/__tests__/`:

- `midenVitePlugin.test.ts` — factory called with default options and with
  each option overridden. Assert the returned plugin object's name, hooks,
  and `optimizeDeps.dedupe` list contents.
- `externalizeMidenReact.test.ts` — invoke the esbuild plugin's `setup()`
  with a mocked `build` that captures `onResolve` callbacks; assert the
  callback returns `{ path: "@miden-sdk/react", external: true }` for the
  matching specifier.
- `configureServer.test.ts` — fake Vite dev server with mocked
  `middlewares.use()`; assert COOP/COEP headers are present when
  `crossOriginIsolation: true`, absent when false; assert the proxy
  middleware is mounted at `rpcProxyPath` only when `rpcProxyTarget !== false`.
- `proxy.test.ts` — happy path: a request to `/rpc.Api/...` is forwarded with
  the rewritten target. Error path: simulate `connect-on-error` by injecting
  a mocked `http-proxy` instance that emits an `error`; assert the response
  is closed cleanly.

Likely refactor: extract `http-proxy` creation behind a tiny factory function
so tests can swap in a fake. Estimated ~10-line change.

### Step 3 — `crates/idxdb-store/src/ts` gap-fill

Existing tests cover `schema`, `accounts`, `chainData`, `notes`. New test
files needed (one per untested source file):

- `settings.test.ts` (71 src lines) — get/set/delete + missing-key fallback.
- `utils.test.ts` (51 src lines) — pure helpers.
- `export.test.ts` (73 src lines) — round-trip with a populated fake-indexeddb
  database.
- `transactions.test.ts` (165 src lines) — insert / list / filter by status /
  filter by account.
- `import.test.ts` (116 src lines) — import an exported blob, verify rows
  materialize, verify schema-version-mismatch error path.
- `auth.test.ts` (140 src lines) — store/load secret, missing-record error,
  deletion.
- `sync.test.ts` (432 src lines) — update sync state, advance block height,
  stale-write error, transactional rollback.

Existing `accounts.test.ts` (covering 1,199-line `accounts.ts`) and
`chainData.test.ts` likely need branch-coverage gap-filling once Step 1's
measurement runs. Expect ~5–15 new test cases each.

### Step 4 — `packages/react-sdk` gap-fill

Existing 47 test files probably leave gaps in:

- Utilities without `__tests__/utils/<x>.test.ts` partner: `amounts`,
  `network`, `accountBech32`, `accountParsing`, `notes`, `transactions`,
  `asyncLock`, `runExclusive`. Verify with measurement; add `*.test.ts` for
  any with non-trivial logic.
- Branch coverage in hooks (error paths in `useTransaction`,
  `useSyncControl`, `useNoteStream`).
- Less-traveled branches in `MidenProvider`, `MultiSignerProvider`,
  `SignerContext`.

Surgical adds — driven by measurement, not speculation.

### Step 5 — Tighten thresholds and verify

- Restore all three `vitest.config.ts` threshold blocks to 95.
- Run each package's tests once more locally.
- Confirm CI green on the branch.

## Risk register

- **`accounts.ts` (1,199 lines, idxdb-store)** — large branchy file; may
  resist 95% without refactoring. Don't pre-refactor; measure first.
- **vite-plugin's gRPC `connect-on-error` branch** — if `http-proxy` doesn't
  expose a clean injection point for socket-error simulation, may need DI or
  a justified `/* v8 ignore next */`. The latter is acceptable under the
  strict-exclusion policy because real socket errors aren't reachable from
  the Node test environment.
- **react-sdk hooks wrapping WASM async generators** (`useNoteStream`,
  `useSyncControl`) — mocked SDK covers most paths; some teardown branches
  may need explicit fake-timer tests.

**Commitment.** If any specific file cannot reach 95% within the
strict-exclusion policy, the implementer will come back with a written
justification before either adding `/* v8 ignore */` comments or refactoring
the source. The threshold will not be silently lowered.

## Non-goals

- **Rust crate coverage.** Different toolchain (cargo-llvm-cov), different CI
  shape. Separate spec if ever wanted.
- **Playwright integration tests.** Coverage gates apply to Vitest unit tests
  only; Playwright tests run in browsers and are correctness gates, not
  coverage gates.
- **Mutation testing or test-quality checks.** Whether each test is
  meaningful is reviewer judgment, not a gate.
- **Coverage-trend enforcement.** The gate is absolute (≥95%), not relative.
  Adding "no PR may decrease coverage" is a separate decision.
- **`crates/idxdb-store/src/js/` (compiled JS output).** Verified by the
  existing `Check TSC output equals committed JS` CI step; not a coverage
  subject.

## Rollback

The change is contained in:

- Three `vitest.config.ts` files (one new, two modified).
- Three Makefile targets (one modified, two new).
- One CI workflow edit (modify `test-react-sdk`, add two new jobs).
- Three `package.json` files (devDependency additions; new `test` script in
  vite-plugin).
- New test files in three packages.

To disable enforcement without removing infrastructure: revert the
`thresholds: { ... }` blocks in the three `vitest.config.ts` files. Reports
continue to upload as artifacts.

To remove the feature entirely: revert the CI workflow edits, the Makefile
edits, and the `vitest.config.ts` edits. Test files written in Steps 2–4 stay
(they remain useful regardless of the gate).

## Acceptance criteria

- All three packages produce a V8 coverage report on every CI run.
- Each package's `test*` job fails when any of lines/branches/functions/
  statements drops below 95%.
- All three jobs are green on the integrating PR.
- Every `/* v8 ignore */` in source has a one-line comment naming the reason.
- Local `make test-coverage` reproduces the CI gate.
