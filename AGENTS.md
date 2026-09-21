# AGENTS.md — repo notes for AI agents

Conventions and tooling notes for contributors to `0xMiden/web-sdk`. End-user docs live in [README.md](README.md); per-package usage guides live alongside the packages (e.g. [`packages/react-sdk/AGENTS.md`](packages/react-sdk/AGENTS.md)).

Those per-package files are aimed at **consumers** of the published npm packages, not at people working in this repo, and they ship inside the published tarballs. This file is the one aimed at you if you are changing code here.

## What this repo is

A pnpm monorepo holding the JS / WASM / React bits previously part of [`0xMiden/miden-client`](https://github.com/0xMiden/miden-client), plus the wallet-adapter, Para and Turnkey packages adopted from their own repos in 0.16. **Nineteen published npm packages** and four crates.io crates:

| Artifact | Path | Registry |
|---|---|---|
| `@miden-sdk/miden-sdk` | `crates/web-client/` (Rust + WASM + JS bindings) | npm |
| `@miden-sdk/react` | `packages/react-sdk/` | npm |
| `@miden-sdk/vite-plugin` | `packages/vite-plugin/` | npm |
| `@miden-sdk/telemetry-{otel,sentry}` | `packages/telemetry-*` | npm (opt-in bindings that turn client observations into spans / Sentry calls) |
| `@miden-sdk/miden-wallet-adapter{,-base,-miden,-react,-reactui}` | `packages/adapter/{all,base,miden,react,reactui}` | npm |
| `@miden-sdk/{para,para-react,create-para-react}` | `packages/para/{core,react,create}` | npm |
| `@miden-sdk/{turnkey,turnkey-react,create-turnkey-react}` | `packages/turnkey/{core,react,create}` | npm |
| `@miden-sdk/node-{darwin-arm64,darwin-x64,linux-x64-gnu}` | `packages/node-sdk-*` | npm (platform-specific native binaries; consumed via `optionalDependencies` on `@miden-sdk/miden-sdk`) |
| `miden-idxdb-store`, `js-export-macro`, `miden-mobile-prover`, `miden-client-web` | `crates/*` | crates.io |

The npm publish gates live in three places, so check the right one: `scripts/check-{web-client,react-sdk,vite-plugin}-version-release.sh` for those three; the `node-sdk-*` natives are published inline by `publish-web-sdk.yml` whenever the web-client publishes; everything adopted is gated from [`scripts/publish-manifest.json`](scripts/publish-manifest.json) via `scripts/publish-plan.sh`. **Adding a package to that manifest is all a new adopted package needs.** `@miden-sdk/telemetry-otel` and `@miden-sdk/telemetry-sentry` are shaped and linted for publication (`check:publish`) but are in no manifest and no workflow, so they currently have no route to npm - fix that before promising a release of either.

Two `package.json` files in the tree are neither private nor published: `crates/idxdb-store/src` (the `web_store` TypeScript helper, built into the web-client) and the subpath stubs under `crates/web-client/{lazy,mt}` and `packages/react-sdk/{lazy,mt}`. Don't add them to the workspace publish path.

The `Cargo.toml` workspace dep `miden-client = "x.y.z"` pins compatibility with the upstream Rust crate. Changes to shared types (Account, Note, gRPC schema, …) usually need a coordinated PR in `0xMiden/rust-sdk` first.

## Toolchain

- **Package manager**: pnpm 9 (workspace at `pnpm-workspace.yaml`). **Never** use `yarn` or `npm install` — they will desync the lockfile.
- **Node**: ≥ 20 (`engines.node` in `package.json`, `.nvmrc`).
- **Rust**: MSRV 1.98.1 (`rust-version` under `[workspace.package]` in `Cargo.toml`) plus the nightly pinned in `rust-toolchain.toml` (`nightly-2026-08-06`). The nightly is load-bearing, not a convenience: `-Z build-std` and `cfg(target_feature = "atomics")` are nightly-only and the MT WASM build needs both. It also backs `cargo +nightly fmt`, `clippy` and `fix`.
- **Lefthook** runs pre-commit; `pnpm install` wires it via the `prepare` script.

## Build / lint / test

Drive everything through the `Makefile` — never call `cargo fmt` directly (the project requires nightly + an exact prettier/eslint pass that vanilla `cargo fmt` skips).

```bash
make help                          # list targets

# Build
make build-wasm                    # WASM crates only (wasm32-unknown-unknown)
make build-web-client              # WASM + JS bindings + dist
make build-react-sdk               # everything @miden-sdk/react needs
make hydrate-web-client            # populate crates/web-client/dist from the published
                                   # npm tarball, no Rust build. Use this when you need a
                                   # dist for typecheck/typedoc but aren't touching Rust.

# Lint + format
make format                        # nightly cargo fmt + prettier write + eslint --fix
make format-check                  # CI form (no writes)
make clippy-wasm                   # clippy for both WASM crates
make typos-check                   # spellcheck
make lint                          # umbrella: fix-wasm + format + clippy-wasm + typos + checks
make web-client-check-methods      # verifies every WASM method is classified in the JS proxy

# Test
make test                          # TypeScript unit suites only. No Rust toolchain, no
                                   # built dist. This is the one every contributor runs.
make test-coverage                 # all coverage gates (react-sdk + idxdb-store + vite-plugin + web-client unit)
make test-react-sdk                # vitest unit (jsdom)
make test-web-client-unit          # vitest unit (web-client)
make integration-test-web-client   # playwright (chromium); accepts SHARD_PARAMETER
make integration-test-web-client-webkit
```

CI (`.github/workflows/test.yml`) runs all of the above on every PR. `main` and `next` warm sccache + Swatinem/rust-cache.

## Coverage thresholds

`packages/react-sdk/vitest.config.ts` enforces `lines / functions / statements ≥ 95` and `branches ≥ 94`. Branches sits 1pp lower because v8's instrumentation marks `} finally {` blocks partially-covered even when both paths are exercised; the comment in the config has the detail. One file is excluded because it needs the real WASM binary rather than the jsdom mock:

- `src/utils/accountBech32.ts` - `NetworkId`, `Address` and `Account.prototype` come from the real bundle. Covered by the Playwright test at `packages/react-sdk/test/accountBech32.test.ts`.

`src/hooks/useAssetMetadata.ts` used to be excluded alongside it, pointing at a `test/useAssetMetadata.test.ts` that does not exist. It is unit-covered by `packages/react-sdk/src/__tests__/hooks/useAssetMetadata.test.tsx` and is measured normally.

The exclude comment inside `vitest.config.ts` carries the same path. If you move a test, fix both places - the config's copy has been wrong before and nothing checks it.

**Always run `make test-react-sdk` locally before pushing** — CI will block the merge if any threshold dips. Lowering thresholds is not the right fix; either add tests or move the file to the excluded list with justification.

## WASM concurrency: `runExclusive`

The wasm-bindgen `WebClient` is **not** safe under concurrent access. Calls that go through it from multiple call sites must serialize via the AsyncLock exposed by `MidenProvider`:

```ts
const client = useMidenClient();
const { runExclusive } = useMiden();

// runExclusive is `<T>(fn: () => Promise<T>) => Promise<T>` - the callback takes
// NO arguments. Close over the client; `async (client) => …` binds undefined.
await runExclusive(async () => { /* … */ });
```

Symptom of a violation: `Error: recursive use of an object detected which would lead to unsafe aliasing in rust`. The `crates/web-client/test/sync_lock.test.ts` integration test guards against regressions — if you add a hook that touches the client, route it through `runExclusive` (or one of the existing serialized helpers) or the lock test will fail.

## Eager vs lazy entry points

`@miden-sdk/miden-sdk` ships **four** entry points with an identical public API, varying along two orthogonal axes: when WASM initializes (eager / lazy) and how it threads (ST / MT).

| Specifier | Timing | Threading | When WASM loads | Hosting requirement |
|---|---|---|---|---|
| `@miden-sdk/miden-sdk` | eager | ST | At import (top-level await) | none |
| `@miden-sdk/miden-sdk/lazy` | lazy | ST | On first `await MidenClient.ready()` (or first awaited SDK method) | none |
| `@miden-sdk/miden-sdk/mt` | eager | MT | At import (top-level await) | page must be cross-origin-isolated |
| `@miden-sdk/miden-sdk/mt/lazy` | lazy | MT | On first `await MidenClient.ready()` | page must be cross-origin-isolated |

Reach for a lazy entry under SSR (Next.js, Remix, SvelteKit), in Capacitor WKWebView hosts, and anywhere top-level await is unsafe. Reach for an MT entry only when the host really is cross-origin-isolated (`self.crossOriginIsolated === true`): the MT build uses `wasm-bindgen-rayon` and `SharedArrayBuffer`, and it fails to load rather than degrading. The same four-way split applies to `@miden-sdk/react` (`react/mt/lazy` pulls `miden-sdk/mt/lazy`, and so on); both packages' `exports` maps carry `.`, `./lazy`, `./mt` and `./mt/lazy`.

The eager/lazy contract is guarded by `crates/web-client/test/eager_entry.test.ts`. If you change the public API in one entry, mirror it across all four and re-run the type-check scripts under `crates/web-client/scripts/`.

## Releases

Two long-lived branches:

- **`main`** → npm `latest` dist-tag. Released on GitHub release events.
- **`next`** → npm `next` dist-tag. Released when a PR merges into `next` carrying the `patch release` label.

Both branches have protection enabled; required status checks mirror across the two.

The release-publish gate compares the local `package.json` version against the **npm registry**, not against the previous git commit. So a release tag publishes whichever packages have versions not yet on npm, and bumping a single package is a clean release of just that one. Three gating mechanisms are in play and they do not share code:

- `scripts/check-{web-client,react-sdk,vite-plugin}-version-release.sh` for those three packages.
- The three `node-sdk-*` natives are tied to the web-client publish, so their `optionalDependencies` versions always match a real published binary.
- The eleven adopted packages are planned from `scripts/publish-manifest.json` by `scripts/publish-plan.sh`, which also builds the plan's first-party dependency closure in level order before publishing anything.

Release WASM size is gated at 25 MiB for ST and 35 MiB for MT. These limits reject both a `wasm-opt` failure and a skipped MASP debug strip before publishing.

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
- **Test sharding is manually balanced.** `crates/web-client/playwright.config.ts` defines four CI shard projects (`ci-shard-1-tx-flows`, `ci-shard-2-sync-and-state`, `ci-shard-3-accounts-and-keys`, `ci-shard-4-compile-and-misc`) with explicit `testMatch` arrays sized empirically from observed run timings; `.github/workflows/test.yml` runs them as a matrix. Rebalance by moving file paths between arrays - no workflow edits needed. The comment block above the projects explains the history, and `crates/web-client/js/__tests__/playwrightShards.test.js` fails if a spec falls out of every shard. (`packages/react-sdk/playwright.config.ts` is unsharded: two projects, `chromium` and `webkit`.)
- **Network-bound tests don't belong in CI.** Anything that hits a live RPC node (testnet/devnet) is excluded. If you add such a test, gate it on an env var and skip by default.
- **Account ID display.** Hooks accept hex (`0x…`) and bech32 (`mtst1q…`) interchangeably. The bech32 prefix tracks the active network: `mtst1` testnet, `mdev1` devnet, `mm1` mainnet. Don't hardcode prefixes - `packages/react-sdk/src/utils/accountBech32.ts` infers the `NetworkId` from `rpcUrl`, and `packages/react-sdk/test/accountBech32.test.ts` pins all three.
- **Code comments describe current state, not history.** Don't reference PR review threads, "earlier revisions", "per review feedback", or links to specific comment IDs in source comments — that context rots the moment the PR merges or the thread resolves. State the present-tense rationale a future reader needs ("X is gated behind `testing` so it doesn't ship in production WASM bundles"), and leave the historical "why we changed it" to the commit message and PR description.

## Cross-repo coordination

| Concern | Repo |
|---|---|
| Shared Rust types, gRPC schema, `MidenClient` semantics | [`0xMiden/rust-sdk`](https://github.com/0xMiden/rust-sdk) |
| Account compiler, MASM standard library, base protocol types | [`0xMiden/miden-base`](https://github.com/0xMiden/miden-base) |

PRs that touch the WASM/JS boundary often need a synchronized PR in rust-sdk - bump the workspace dep and verify the integration tests still pass.

**No longer cross-repo.** The MidenFi wallet adapter, the Para signer integration and the Turnkey signer integration were adopted into this monorepo in 0.16 and are not coordinated with `0xMiden/miden-wallet-adapter`, `0xMiden/miden-para` or `0xMiden/miden-turnkey` any more. They live at `packages/adapter/*`, `packages/para/*` and `packages/turnkey/*`, are pnpm workspace members, and publish from `scripts/publish-manifest.json`. Change them here.

### Linking a web-sdk PR to an in-flight rust-sdk PR

**ALWAYS use the `Client PR: #N` marker when opening a web-sdk PR that depends on an unmerged / unreleased rust-sdk change.** It is the load-bearing machine-readable handle — prose mentions ("Companion PR: rust-sdk#N", "depends on …") do NOT trigger the linked-PR pipeline. Put the marker on its own line in the PR description (top or bottom both fine). Both `Client PR: #N` and `Client PR: 0xMiden/rust-sdk#N` are accepted; cross-repo is required when the linked PR comes from a fork.

When a web-sdk PR depends on Rust changes that haven't been released yet (i.e. the upstream PR on rust-sdk is still open), add a marker line to the web-sdk PR description:

```
Client PR: #2080
```
or, for forks / cross-repo,
```
Client PR: 0xMiden/rust-sdk#2080
```

CI picks up the marker via `.github/actions/inject-linked-client-pr`, appends a `[patch]` block to `Cargo.toml` (runner-local — never committed) pointing the workspace `miden-client` dep at the linked PR's head, refreshes `Cargo.lock`, and posts a sticky comment on the web-sdk PR summarizing what was patched. There is at most one such comment per PR (the action deletes it if the marker is later removed).

Local-dev parity:

```bash
# Apply the same patch to your working tree (reads the marker from the current branch's PR body):
scripts/dev-with-client-pr.sh

# Or pass an explicit number / cross-repo target:
scripts/dev-with-client-pr.sh 2080
scripts/dev-with-client-pr.sh some-fork/rust-sdk#1965

# Strip the patch before committing:
scripts/dev-with-client-pr.sh --clear
```

The script writes a marker-wrapped `[patch]` block at the bottom of `Cargo.toml`. A pre-commit hook (`lefthook.yml`) blocks any commit while the markers are present, so you can't ship the local override by accident.

**Mergeability gate.** A separate workflow (`.github/workflows/check-linked-client-pr.yml`) keeps a `linked-client-pr-ready` check on the PR. It stays *pending* while the linked client PR isn't merged-and-reachable from web-sdk's target branch's canonical refs (rust-sdk `next` for `next`-targeted PRs, or the latest rust-sdk release tag for `main`-targeted PRs). It re-evaluates every 15 minutes, so the check goes green automatically once upstream catches up — no need to push to the PR. Configure branch protection to require this check before merge.

## Documenting public-API changes

Any change that adds, renames, removes, or alters the observable behavior of a method, type, hook, option field, or return shape on either the `MidenClient` resource surface or `@miden-sdk/react` is a public-API change. Document it in **all** of the surfaces below before merging — the surfaces aren't redundant; each one is read at a different moment in the consumer's workflow (CHANGELOG at upgrade time, narrative docs / README when learning, JSDoc in the IDE, typedoc on the API-reference site).

### Where the docs are published

| Surface | URL | How it's built |
|---|---|---|
| **Narrative docs (canonical user-facing site)** | `https://docs.miden.xyz/builder/tools/clients/web-client/` (MidenClient) and `/builder/tools/clients/react-sdk/` (React SDK) | Docusaurus site at [`0xMiden/miden-docs`](https://github.com/0xMiden/miden-docs). The `deploy-docs.yml` workflow there vendors each upstream repo and copies a designated docs subtree (`docs/external/src/*`) into `docs/builder/<repo>/`. |
| **API reference (typedoc)** | Same site, deeper paths | `crates/web-client/typedoc.json` declares `out: ../../docs/typedoc/web-client`. Generated by `pnpm --filter @miden-sdk/miden-sdk run typedoc` from the curated [`docs-entry.d.ts`](crates/web-client/js/types/docs-entry.d.ts) entry point. |
| **CHANGELOG (upgrade-time reading)** | Root `CHANGELOG.md` — read by dApp authors at upgrade time. | Hand-written. CI ingestion is per-repo: don't expect this file to be aggregated elsewhere. |
| **READMEs (npm landing page)** | `crates/web-client/README.md` and `packages/react-sdk/README.md` are what npm users see on the package page. | Hand-written. Keep narrative aligned with the published Docusaurus site — they share content but the README has the wider audience for first-touch. |
| **Agent guides (read by the consumer's AI agent)** | `AGENTS.md`, plus `skills/` where the package has one, inside each published package. | Hand-written. Shipped only if the package's `files` array lists them, because npm gives `AGENTS.md` none of the automatic treatment it gives `README`. See [Agent-facing docs](#agent-facing-docs-agentsmd-and-skills) below - this repo is the canonical home for them. |

### Agent-facing docs: `AGENTS.md` and `skills/`

Every published package with a JavaScript API ships an `AGENTS.md` index, plus a
`skills/` directory where task-scoped guidance earns one, and consumers' AI
agents read them out of `node_modules`. Because they ship in the tarball they
are **version-matched to the code**, which is the whole point: a consumer on
0.15 gets 0.15 guidance.

The three `packages/node-sdk-*` packages are the deliberate exception. Each
holds one file, `miden_client_web.node`, is resolved only through
`optionalDependencies` on `@miden-sdk/miden-sdk`, and is never imported by hand.
They carry a short "this is not the SDK, go read `@miden-sdk/miden-sdk`" pointer
and nothing else. Don't grow them a guide or a `skills/` directory.

#### The trap: npm gives `AGENTS.md` no special treatment

**Read this before adding a guide to any package.** npm always packs
`package.json`, `README*`, `LICENSE*` and the `main` entry **whatever the
`files` array says**. `AGENTS.md` and `skills/` have no such privilege. So:

- A package **with** a `files` array must list `"AGENTS.md"` and `"skills"`
  explicitly, or the guide sits on disk, shows up in every directory listing and
  every code review, and is simply absent from the tarball the consumer installs.
- A package with **no** `files` array and no `.npmignore` publishes everything
  except npm's built-in excludes, so a guide dropped in ships automatically.
  No published package relies on that any more - every one of them declares a
  `files` array, and `scripts/check-agent-docs.sh` fails the build if a guide
  or a skill is missing from the tarball it produces.

This is not hypothetical. All three `packages/para/*` packages carried an
`AGENTS.md` inherited from their upstream repo, none of the three listed it in
`files`, and it therefore reached no consumer for the entire life of those
packages. The `README.md` beside it shipped fine, which is exactly why nobody
noticed: the directory looked right and the tarball was not.

**Verify, don't reason.** `npm pack --dry-run --json --ignore-scripts`, run in
the package directory, prints the literal file list `npm publish` would upload,
and it needs no build to answer for a docs file. Reading the `files` array and
reasoning about it is what got this wrong the first time.

**The authoritative list of shipped skills is the filesystem**, not a table in
this file - a hand-kept list across nineteen packages drifts, and this one did:

```bash
find . -name SKILL.md -not -path './node_modules/*'
```

Run that command rather than trusting a list here - an enumeration in this file
is exactly what drifted before. Every published package ships an `AGENTS.md`;
add a `skills/` directory to one only when the guidance is genuinely
task-scoped and too long for the index.

**This repo is canonical for any skill that documents our own API.** These
skills previously lived in [`0xMiden/agent-tools`](https://github.com/0xMiden/agent-tools)
and were copied into [`0xMiden/frontend-template`](https://github.com/0xMiden/frontend-template);
both copies drifted from each other and from the code, because nothing tied a
skill to the API it described. They live here now so that a PR changing the API
and a PR changing its documentation are the same PR. Don't reintroduce a copy
elsewhere - have the other repo consume the published package instead.

`agent-tools` remains canonical for everything **not** specific to our API: the
MASM family, `rust-sdk-*`, `miden-concepts`, `local-node-validation`, and the
slash commands. If a skill you're writing never mentions `@miden-sdk/*`, it
probably belongs there rather than here.

A third repo is in the picture and is neither of those two:
[`0xMiden/agentic-template`](https://github.com/0xMiden/agentic-template)
scaffolds a whole application (Rust contracts, MockChain tests, local-node
validation, a React frontend already wired to this SDK). It is what
`crates/web-client/AGENTS.md` points a consumer at when there is no app yet. It
consumes the published packages; it is not a place to copy a skill to.

Two web-sdk skills are deliberately **not** shipped, because they document
internals rather than the API: `.claude/skills/idxdb-patterns/` and
`.claude/skills/wasm-bridge/`. They're contributor material and stay out of the
`files` array.

**When you change the public API, update the shipped skill in the same PR.**
It's the surface most likely to be silently wrong, because nothing type-checks
prose — and a stale skill is worse than no skill, since an agent will follow it
confidently.

### Source-of-truth for the published narrative docs

The Docusaurus site at miden-docs ingests **`docs/external/src/`** from each upstream repo and copies the contents into `docs/builder/<repo>/`. After the web/WASM split (PR [#1992](https://github.com/0xMiden/miden-client/pull/1992)) miden-client's `docs/external/src/` holds only Rust-client material, so the MidenClient resource API and React SDK narrative docs live in this repo's `docs/external/src/`.

That tree exists but is still partial. What is there today:

```
docs/external/src/
├── web-client/                       # @miden-sdk/miden-sdk
│   ├── _category_.yml
│   └── library/
│       ├── _category_.yml
│       ├── network-notes.md
│       └── transactions.md
└── react-client/                     # @miden-sdk/react
    ├── _category_.yml
    └── library/
        ├── _category_.yml
        ├── use-chain-anchor.md
        └── use-create-network-note.md
```

Still missing, relative to what miden-client used to ship: the top-level `_category_.yml` and `index.md` (the Builder to Client landing page), `web-client/get-started/` (install, quick start, send/receive, custom signer), `web-client/examples.md` and `react-client/get-started/`.

If your change adds a public capability, **create the page as part of the same PR** - and if the subdirectory it belongs in is one of the missing ones above, create that too. Don't ship a feature whose only narrative documentation is the README: the README is reference, the Docusaurus page is where consumers actually learn the workflow.

### Typedoc - regenerated by CI, don't commit

`docs/typedoc/web-client/` is **build output**, not source. CI regenerates it fresh on every run via `pnpm --filter @miden-sdk/miden-sdk run typedoc`. `crates/web-client/typedoc.json` points at `./dist/st/docs-entry.d.ts`, the built copy of the curated [`crates/web-client/js/types/docs-entry.d.ts`](crates/web-client/js/types/docs-entry.d.ts) (which re-exports `api-types.d.ts` wholesale plus selected WASM classes). Because the entry point is the built one, `run typedoc` needs a populated `dist/` - run `make hydrate-web-client` first if you haven't built the WASM. The output directory is `.gitignore`d.

The `Check that web client documentation is up-to-date` **job** in `.github/workflows/test.yml` regenerates typedoc and then runs `git diff --exit-code docs/typedoc/web-client`. That step has no `continue-on-error`, so it is a hard failure in principle - but `docs/typedoc/` is gitignored, so the diff is always empty and the job is in practice a smoke test that surfaces typedoc's own warnings. It does not gate merge today, and it would start gating the moment anyone tracked that directory.

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
| Root `CHANGELOG.md` | One bullet under `## <next-version> (TBD)` → `### Enhancements` (or `### Fixes` / `### Breaking`). Prefix tags: `[FEATURE][web]` for web-only, `[FEATURE][rust,cli,web]` for cross-cutting. Include the *smallest* example or method shape, link the PR (`web-sdk#NN`) and any companion miden-client PR. Don't repeat README copy verbatim — the audience is a consumer who's about to upgrade. **NEVER add an entry to a section whose version has already been published — check `gh api repos/0xMiden/web-sdk/releases/latest` for the latest tag and put new entries under a section whose version is strictly higher and still has `(TBA)` / `(TBD)` next to it. If no such section exists, add one.** The header at the top of `CHANGELOG.md` may lag (a `(TBA)` heading often persists after the release tags out); don't trust the heading alone. | Any user-visible API addition, behavior change, or fix. |

### React SDK surface — `packages/react-sdk/`

| Surface | What goes there | Trigger |
|---|---|---|
| `packages/react-sdk/src/hooks/<hook>.ts` | JSDoc on the hook export covering the returned object shape (`{action, result, isLoading, stage, error, reset}` for mutations; `{...data, isLoading, error, refetch}` for queries), accepted args, side effects, and concurrency guards. | New hook or change to an existing hook's signature/return. |
| `packages/react-sdk/src/types/*` | TS declarations for any new option/result types the hook surfaces. Mirror the discriminated-union conventions used in the WebClient surface. | New public type emerging from a hook. |
| `docs/external/src/react-client/` | Narrative Docusaurus page (per-hook or per-pattern). The hub is `library/`, deep-link individual hooks under `library/<group>/`. | New hook, new pattern, or changed semantics worth a code example. |
| `packages/react-sdk/AGENTS.md` | Per-package hook-by-hook usage guide, shipped to npm consumers. Add a fenced code block under the right section (`## Reading Data`, `## Writing Data`, `## Common Patterns`, `## External Signer Integration`). Show realistic usage, not just the signature. **Mirror the Docusaurus content** — same examples, same prose, this is the npm-landing version. | Same as above. |
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

1. `make test` clean. Pure TypeScript, no Rust toolchain and no built `dist/` - this is the one every contributor runs, and it matches step 2 of [CONTRIBUTING.md](CONTRIBUTING.md).
2. **If your change touches Rust**, also: `make lint` clean (Clippy, rustfmt and the WASM method check, all of which need cargo) and `make test-coverage` clean. Verify the thresholds locally before pushing - CI blocks the merge if any dips.
3. For changes to public API: every doc surface in the [Documenting public-API changes](#documenting-public-api-changes) section above. Specifically: JSDoc on `api-types.d.ts` plus the resource impl, narrative pages under `docs/external/src/`, READMEs, the package's shipped `AGENTS.md` and any `skills/` that describe what you changed, and the root `CHANGELOG.md`. (`docs/typedoc/web-client/` is regenerated by CI - don't commit it.) The type-check scripts under `crates/web-client/scripts/` may also need updating if you added a forwarder or a new method classification.
4. For changes to release flow: `.github/workflows/publish-web-sdk.yml` is the single publish workflow for every npm package. npm's trusted publishing keys trust on (package, repo) and allows only one workflow filename per package, which is why the `latest` and `next` channels are two branches inside one file rather than two workflows. Rust crates go through `.github/workflows/publish-crates-release.yml`.
5. For a new published package: add it to `pnpm-workspace.yaml`, to `scripts/publish-manifest.json` if it is adopted, and list `"AGENTS.md"` (and `"skills"` if it has one) in its `files` array. Then prove it with `npm pack --dry-run --json --ignore-scripts` in the package directory - see [the trap](#the-trap-npm-gives-agentsmd-no-special-treatment) above.
