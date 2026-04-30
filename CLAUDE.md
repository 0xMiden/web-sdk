# CLAUDE.md — repo notes for AI agents

Conventions and tooling notes for `0xMiden/web-sdk`. End-user docs live in [README.md](README.md); per-package usage guides live alongside the packages (e.g. [`packages/react-sdk/CLAUDE.md`](packages/react-sdk/CLAUDE.md)).

## What this repo is

A pnpm monorepo holding the JS / WASM / React bits previously part of [`0xMiden/miden-client`](https://github.com/0xMiden/miden-client). Five published artifacts:

| Artifact | Path | Registry |
|---|---|---|
| `@miden-sdk/miden-sdk` | `crates/web-client/` (Rust + WASM + JS bindings) | npm |
| `@miden-sdk/react` | `packages/react-sdk/` | npm |
| `@miden-sdk/vite-plugin` | `packages/vite-plugin/` | npm |
| `@miden-sdk/node-{darwin-arm64,darwin-x64,linux-x64-gnu}` | `packages/node-sdk-*` | npm (platform-specific native binaries; consumed via `optionalDependencies` on `@miden-sdk/miden-sdk`) |
| `miden-idxdb-store` | `crates/idxdb-store/` | crates.io |

The `Cargo.toml` workspace dep `miden-client = "x.y.z"` pins compatibility with the upstream Rust crate. Changes to shared types (Account, Note, gRPC schema, …) usually need a coordinated PR in `0xMiden/miden-client` first.

## Toolchain

- **Package manager**: pnpm 9 (workspace at `pnpm-workspace.yaml`). **Never** use `yarn` or `npm install` — they will desync the lockfile.
- **Node**: ≥ 20 (`engines.node` in `package.json`, `.nvmrc`).
- **Rust**: stable 1.93 + nightly (for `cargo +nightly fmt`, `clippy`, and `fix`). Pinned in `rust-toolchain.toml`.
- **Lefthook** runs pre-commit; `pnpm install` wires it via the `prepare` script.

## Build / lint / test

Drive everything through the `Makefile` — never call `cargo fmt` directly (the project requires nightly + an exact prettier/eslint pass that vanilla `cargo fmt` skips).

```bash
make help                          # list targets

# Build
make build-wasm                    # WASM crates only (wasm32-unknown-unknown)
make build-web-client              # WASM + JS bindings + dist
make build-react-sdk               # everything @miden-sdk/react needs

# Lint + format
make format                        # nightly cargo fmt + prettier write + eslint --fix
make format-check                  # CI form (no writes)
make clippy-wasm                   # clippy for both WASM crates
make typos-check                   # spellcheck
make lint                          # umbrella: fix-wasm + format + clippy-wasm + typos + checks
make web-client-check-methods      # verifies every WASM method is classified in the JS proxy

# Test
make test-coverage                 # all coverage gates (react-sdk + idxdb-store + vite-plugin + web-client unit)
make test-react-sdk                # vitest unit (jsdom)
make test-web-client-unit          # vitest unit (web-client)
make integration-test-web-client   # playwright (chromium); accepts SHARD_PARAMETER
make integration-test-web-client-webkit
```

CI (`.github/workflows/test.yml`) runs all of the above on every PR. `main` and `next` warm sccache + Swatinem/rust-cache.

## Coverage thresholds

`packages/react-sdk/vitest.config.ts` enforces `lines / branches / functions / statements ≥ 95`. Two files are excluded because they require the real WASM binary and are covered by Playwright integration tests:

- `src/utils/accountBech32.ts` — covered by `test/accountBech32.test.ts`
- `src/hooks/useAssetMetadata.ts` — covered by `test/useAssetMetadata.test.ts`

**Always run `make test-react-sdk` locally before pushing** — CI will block the merge if any threshold dips. Lowering thresholds is not the right fix; either add tests or move the file to the excluded list with justification.

## WASM concurrency: `runExclusive`

The wasm-bindgen `WebClient` is **not** safe under concurrent access. Calls that go through it from multiple call sites must serialize via the AsyncLock exposed by `MidenProvider`:

```ts
const { runExclusive } = useMiden();
await runExclusive(async (client) => { /* … */ });
```

Symptom of a violation: `Error: recursive use of an object detected which would lead to unsafe aliasing in rust`. The `crates/web-client/test/sync_lock.test.ts` integration test guards against regressions — if you add a hook that touches the client, route it through `runExclusive` (or one of the existing serialized helpers) or the lock test will fail.

## Eager vs lazy entry points

`@miden-sdk/miden-sdk` ships two entry points with identical APIs but different init behaviour:

| Specifier | When WASM loads | Use when |
|---|---|---|
| `@miden-sdk/miden-sdk` | At import (top-level await) | Vite/Webpack browser bundles where TLA is fine |
| `@miden-sdk/miden-sdk/lazy` | On first `await MidenClient.ready()` (or first awaited SDK method) | SSR (Next.js, Remix, SvelteKit), Capacitor WKWebView hosts, anywhere TLA is unsafe |

Same split applies to `@miden-sdk/react` (`react/lazy` pulls `miden-sdk/lazy`). The eager/lazy contract is guarded by `crates/web-client/test/eager_entry.test.ts` — if you change the public API in one entry, mirror it in the other and re-run the type-check scripts under `crates/web-client/scripts/`.

## Releases

Two long-lived branches:

- **`main`** → npm `latest` dist-tag. Released on GitHub release events.
- **`next`** → npm `next` dist-tag. Released when a PR merges into `next` carrying the `patch release` label.

Both branches have protection enabled; required status checks mirror across the two.

The release-publish gate compares the local `package.json` version against the **npm registry** (not against the previous git commit) — see `scripts/check-{web-client,react-sdk,vite-plugin}-version-release.sh`. So a release tag publishes whichever of the four packages have versions not yet on npm; bumping a single package is a clean release of just that one.

WASM size is gated at 25 MB in the publish workflow — if `wasm-opt` ever silently fails, the bloated binary never reaches npm.

Crate publishing (`miden-idxdb-store`, `miden-client-web`) goes through `.github/workflows/publish-crates-release.yml` and uses the `CARGO_REGISTRY_TOKEN` org secret.

## CHANGELOG content

The root `CHANGELOG.md` is read by **consumers of the SDK** — dApp authors and downstream library maintainers, not the team that ships the SDK. Before adding an entry, imagine that audience opening the file at the moment they upgrade. They want to know: what new API can I call? what behavior changed? what broke?

What does NOT belong in CHANGELOG:

- CI plumbing changes ("CI now uses github-hosted runners for publish", "added a chmod fix", "consolidated workflows"). Use the `no changelog` PR label.
- Build-system or tooling changes that don't reach the published bytes ("switched lint runner", "bumped a dev dep"). Same — `no changelog` label.
- Failed release attempts. If `alpha.1` and `alpha.2` had to be skipped before `alpha.3` shipped, the changelog entry is for `alpha.3` and describes the user-visible state. Don't write a postmortem of the misses.
- Internal refactors that don't change the public API surface.

What DOES belong:

- New public APIs (with the smallest example or method shape).
- Behavioral changes consumers can observe (e.g. "`account.storage()` now returns a `StorageView` wrapper").
- Bug fixes that resolve a symptom downstream code might have hit.
- Breaking changes (loud, with migration guidance).

When in doubt, drop the entry and apply `no changelog`. A missing entry the reviewer can ask about is cheaper than a noisy one the consumer has to skip past.

## Gotchas worth remembering

- **No yarn.** The repo migrated from yarn to pnpm. If you see a doc, comment, or script that says `yarn ...`, it's stale — fix it (or flag it).
- **Don't chain `pnpm --filter ... -- arg` through npm-script `&&`.** pnpm's argument forwarding only wires through to the LAST command in the chain. The Makefile splits multi-step playwright invocations across explicit Make recipes for this reason; preserve that pattern (see `integration-test-web-client` in `Makefile`).
- **Test sharding is manually balanced.** `packages/react-sdk/playwright.config.ts` defines four CI shard projects (`ci-shard-1` … `ci-shard-4`) with explicit `testMatch` arrays sized empirically from observed run timings. Rebalance by moving file paths between arrays — no workflow edits needed. Comment block at the top of the config explains the history.
- **Network-bound tests don't belong in CI.** Anything that hits a live RPC node (testnet/devnet) is excluded. If you add such a test, gate it on an env var and skip by default.
- **Account ID display.** Hooks accept hex (`0x…`) and bech32 (`mtst1q…`) interchangeably. Bech32 prefix tracks the active network — `mtst1` for testnet/devnet, `mid1` for mainnet (when it lands). Don't hardcode prefixes.

## Cross-repo coordination

| Concern | Repo |
|---|---|
| Shared Rust types, gRPC schema, `MidenClient` semantics | [`0xMiden/miden-client`](https://github.com/0xMiden/miden-client) |
| Account compiler, MASM standard library, base protocol types | [`0xMiden/miden-base`](https://github.com/0xMiden/miden-base) |
| MidenFi browser-extension wallet adapter | [`0xMiden/miden-wallet-adapter`](https://github.com/0xMiden/miden-wallet-adapter) |
| Para signer integration | [`0xMiden/miden-para`](https://github.com/0xMiden/miden-para) |
| Turnkey signer integration | [`0xMiden/miden-turnkey`](https://github.com/0xMiden/miden-turnkey) |

PRs that touch the WASM/JS boundary often need a synchronized PR in miden-client — bump the workspace dep and verify the integration tests still pass.

### Linking a web-sdk PR to an in-flight miden-client PR

When a web-sdk PR depends on Rust changes that haven't been released yet (i.e. the upstream PR on miden-client is still open), add a marker line to the web-sdk PR description:

```
Client PR: #2080
```
or, for forks / cross-repo,
```
Client PR: 0xMiden/miden-client#2080
```

CI picks up the marker via `.github/actions/inject-linked-client-pr`, appends a `[patch]` block to `Cargo.toml` (runner-local — never committed) pointing the workspace `miden-client` dep at the linked PR's head, refreshes `Cargo.lock`, and posts a sticky comment on the web-sdk PR summarizing what was patched. There is at most one such comment per PR (the action deletes it if the marker is later removed).

Local-dev parity:

```bash
# Apply the same patch to your working tree (reads the marker from the current branch's PR body):
scripts/dev-with-client-pr.sh

# Or pass an explicit number / cross-repo target:
scripts/dev-with-client-pr.sh 2080
scripts/dev-with-client-pr.sh koookxbt/miden-client#1965

# Strip the patch before committing:
scripts/dev-with-client-pr.sh --clear
```

The script writes a marker-wrapped `[patch]` block at the bottom of `Cargo.toml`. A pre-commit hook (`lefthook.yml`) blocks any commit while the markers are present, so you can't ship the local override by accident.

**Mergeability gate.** A separate workflow (`.github/workflows/check-linked-client-pr.yml`) keeps a `linked-client-pr-ready` check on the PR. It stays *pending* while the linked client PR isn't merged-and-reachable from web-sdk's target branch's canonical refs (miden-client `next` for `next`-targeted PRs, or the latest miden-client release tag for `main`-targeted PRs). It re-evaluates every 15 minutes, so the check goes green automatically once upstream catches up — no need to push to the PR. Configure branch protection to require this check before merge.

## Contributing checklist

1. `make lint` clean.
2. `make test-coverage` clean (and locally verify thresholds before pushing).
3. For changes to public API: update the relevant per-package CLAUDE.md (e.g. `packages/react-sdk/CLAUDE.md` for hook signatures) and the type-check scripts under `crates/web-client/scripts/`.
4. For changes to release flow: cross-check both `publish-web-client-release.yml` (latest channel) and `publish-web-client-next.yml` (next channel) — they intentionally mirror each other.
