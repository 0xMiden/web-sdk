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

## Documenting public-API changes

Any change that adds, renames, removes, or alters the observable behavior of a method, type, hook, option field, or return shape on either the `MidenClient` resource surface or `@miden-sdk/react` is a public-API change. Document it in **all** of the surfaces below before merging — the surfaces aren't redundant; each one is read at a different moment in the consumer's workflow (CHANGELOG at upgrade time, narrative docs / README when learning, JSDoc in the IDE, typedoc on the API-reference site).

### Where the docs are published

| Surface | URL | How it's built |
|---|---|---|
| **Narrative docs (canonical user-facing site)** | `https://docs.miden.xyz/builder/tools/clients/web-client/` (MidenClient) and `/builder/tools/clients/react-sdk/` (React SDK) | Docusaurus site at [`0xMiden/miden-docs`](https://github.com/0xMiden/miden-docs). The `deploy-docs.yml` workflow there vendors each upstream repo and copies a designated docs subtree (`docs/external/src/*`) into `docs/builder/<repo>/`. |
| **API reference (typedoc)** | Same site, deeper paths | `crates/web-client/typedoc.json` declares `out: ../../docs/typedoc/web-client`. Generated by `pnpm --filter @miden-sdk/miden-sdk run typedoc` from the curated [`docs-entry.d.ts`](crates/web-client/js/types/docs-entry.d.ts) entry point. |
| **CHANGELOG (upgrade-time reading)** | Root `CHANGELOG.md` — read by dApp authors at upgrade time. | Hand-written. CI ingestion is per-repo: don't expect this file to be aggregated elsewhere. |
| **READMEs (npm landing page)** | `crates/web-client/README.md` and `packages/react-sdk/README.md` are what npm users see on the package page. | Hand-written. Keep narrative aligned with the published Docusaurus site — they share content but the README has the wider audience for first-touch. |

### Source-of-truth for the published narrative docs

The Docusaurus site at miden-docs ingests **`docs/external/src/`** from each upstream repo and copies the contents into `docs/builder/<repo>/`. After the web/WASM split (PR [#1992](https://github.com/0xMiden/miden-client/pull/1992)) miden-client's `docs/external/src/` now contains only Rust-client material; the **MidenClient resource API and React SDK narrative docs need to live in this repo's `docs/external/src/`** and be wired into the deploy-docs workflow. The expected layout (mirrors what miden-client used to ship):

```
docs/external/src/
├── _category_.yml
├── index.md                          # Builder → Client landing
├── web-client/                       # @miden-sdk/miden-sdk
│   ├── _category_.yml
│   ├── get-started/                  # install, quick start, send/receive, custom signer
│   ├── library/                      # accounts, notes, transactions, sync, prover, compile
│   └── examples.md
└── react-client/                     # @miden-sdk/react
    ├── _category_.yml
    ├── get-started/
    └── library/                      # accounts, notes, provider, hooks ...
```

If your change adds a public capability and `docs/external/src/` doesn't exist yet (or the relevant subdir is missing), **create the page as part of the same PR**. Don't ship a feature whose only narrative documentation is the README — the README is reference, the Docusaurus page is where consumers actually learn the workflow.

### Typedoc — regenerated by CI, don't commit

`docs/typedoc/web-client/` is **build output**, not source. CI regenerates it fresh on every run via `pnpm --filter @miden-sdk/miden-sdk run typedoc`, fed by the curated [`crates/web-client/js/types/docs-entry.d.ts`](crates/web-client/js/types/docs-entry.d.ts) entry point (which re-exports `api-types.d.ts` wholesale plus selected WASM classes). The directory is `.gitignore`d.

The `Check that web client documentation is up-to-date` step in `.github/workflows/test.yml` runs `git diff --exit-code` over the regenerated tree. With the dir untracked the diff is empty — the step is a **warning-only smoke test** that surfaces typedoc's own warnings during the run. It does not gate merge.

What this means in practice: keep your JSDoc on `api-types.d.ts` accurate (that's where typedoc reads from), and don't worry about regenerating docs locally. The published API reference picks up the next typedoc run when the docs site rebuilds.

### MidenClient surface — `crates/web-client/`

| Surface | What goes there | Trigger |
|---|---|---|
| `crates/web-client/js/types/api-types.d.ts` | TS declaration with full JSDoc on every method, option field, and return shape. Discriminated unions for option variants. The JSDoc IS the typedoc source — be thorough here. | Any addition/change to a `*Resource` interface, `MidenClient` class, or supporting option/result type. |
| `crates/web-client/js/resources/<area>.js` | JSDoc comment on the impl method explaining behavior, inputs, return value, and any non-obvious invariants (locking, atomicity, polling semantics). | Any new method or behavioral change on a resource impl. |
| `crates/web-client/js/types/docs-entry.d.ts` | Add the type to the curated re-exports if it should appear on the typedoc-generated API reference. `api-types` is already re-exported wholesale; only WASM-side classes need explicit listing. | New WASM class becomes part of the public surface. |
| `docs/typedoc/web-client/` (generated, gitignored) | **Don't commit.** Regenerated by CI; the in-repo CI verification step is warning-only. Just keep the JSDoc on `api-types.d.ts` accurate and the rendered API reference will update on the next docs build. | Always covered automatically once the JSDoc is right. |
| `docs/external/src/web-client/` | Narrative Docusaurus page under `library/` (concept reference) or `get-started/` (workflow). Show the happy path; cross-reference singular siblings. Mention V1 constraints if they're non-obvious (single-account, no per-tx ids, etc.). | New high-level capability that a dApp author would reach for. |
| `crates/web-client/README.md` → `## Usage` | Same narrative as the Docusaurus page, condensed. The README is what npm users see on the package landing page. | Same as above. Keep aligned with the Docusaurus copy. |
| Root `CHANGELOG.md` | One bullet under `## <next-version> (TBD)` → `### Enhancements` (or `### Fixes` / `### Breaking`). Prefix tags: `[FEATURE][web]` for web-only, `[FEATURE][rust,cli,web]` for cross-cutting. Include the *smallest* example or method shape, link the PR (`web-sdk#NN`) and any companion miden-client PR. Don't repeat README copy verbatim — the audience is a consumer who's about to upgrade. | Any user-visible API addition, behavior change, or fix. |

### React SDK surface — `packages/react-sdk/`

| Surface | What goes there | Trigger |
|---|---|---|
| `packages/react-sdk/src/hooks/<hook>.ts` | JSDoc on the hook export covering the returned object shape (`{action, result, isLoading, stage, error, reset}` for mutations; `{...data, isLoading, error, refetch}` for queries), accepted args, side effects, and concurrency guards. | New hook or change to an existing hook's signature/return. |
| `packages/react-sdk/src/types/*` | TS declarations for any new option/result types the hook surfaces. Mirror the discriminated-union conventions used in the WebClient surface. | New public type emerging from a hook. |
| `docs/external/src/react-client/` | Narrative Docusaurus page (per-hook or per-pattern). The hub is `library/`, deep-link individual hooks under `library/<group>/`. | New hook, new pattern, or changed semantics worth a code example. |
| `packages/react-sdk/CLAUDE.md` | Per-package hook-by-hook usage guide. Add a fenced code block under the right section (`## Reading Data`, `## Writing Data`, `## Common Patterns`, `## External Signer Integration`). Show realistic usage, not just the signature. **Mirror the Docusaurus content** — same examples, same prose, this is the npm-landing version. | Same as above. |
| `packages/react-sdk/README.md` → `## Features` | One bullet on the high-level feature list if it's a notable addition (new hook category, new integration). Subordinate hook tweaks don't go here. | A reader scanning the README would want to know this exists. |
| Root `CHANGELOG.md` | One bullet, same format as above, prefixed `[FEATURE][react]` (or `[FIX][react]`, `[BREAKING][react]`). | Any user-visible hook/provider/util change. |

### Conventions

- **Match existing tone.** Look at adjacent README/CHANGELOG/Docusaurus entries before writing — they're terse, imperative, and lead with what the consumer can now *do*. Avoid implementation chatter ("we now do X internally") unless it's a behavioral signal that affects how the consumer writes code.
- **Don't write speculative docs.** If the API is part-implemented (e.g. V1 today, V2 planned), document V1 only and call out the constraint inline. The next PR can extend the doc when V2 lands.
- **Cross-link the PRs.** Every CHANGELOG entry needs the PR link at the end. If the change required a coordinated miden-client PR, link both — the consumer's mental model spans both repos.
- **One source of truth per fact.** A V1 constraint ("single-account batch") goes in the Docusaurus narrative *and* the JSDoc. The CHANGELOG mentions it once. Don't repeat the full constraint list across files; cross-reference if it gets long.
- **README ⇄ Docusaurus parity.** READMEs are the npm landing page; Docusaurus is the canonical site. Keep the narrative aligned. If they diverge, the Docusaurus page is the source of truth — fix the README to match.
- **Don't commit typedoc.** `docs/typedoc/web-client/` is build output, regenerated fresh on every CI run. The in-repo verification step is warning-only. Keep JSDoc on `api-types.d.ts` accurate; the rendered API reference picks up changes automatically.
- **Update before commit.** Pre-commit hooks don't enforce doc parity, but reviewers will. Mention "docs updated" in the PR description so reviewers know where to look.

### Doc-only PRs

If you find a stale doc (e.g. the API changed but the Docusaurus page or README didn't), fix it as a separate `docs:`-prefixed commit on the same branch — keeps diffs reviewable. The CHANGELOG `no changelog` label exists for these.

When fixing a stale Docusaurus page that lives downstream at `0xMiden/miden-docs`, push the upstream fix here in `docs/external/src/` and let the next deploy-docs run pick it up; don't edit the Docusaurus repo directly for content that's supposed to be ingested from this repo.

## Contributing checklist

1. `make lint` clean.
2. `make test-coverage` clean (and locally verify thresholds before pushing).
3. For changes to public API: every doc surface in the [Documenting public-API changes](#documenting-public-api-changes) section above. Specifically: JSDoc on `api-types.d.ts` + the resource impl, narrative pages under `docs/external/src/`, READMEs, root `CHANGELOG.md`. (`docs/typedoc/web-client/` is regenerated by CI — don't commit it.) The type-check scripts under `crates/web-client/scripts/` may also need updating if you added a forwarder or new method classification.
4. For changes to release flow: cross-check both `publish-web-client-release.yml` (latest channel) and `publish-web-client-next.yml` (next channel) — they intentionally mirror each other.
