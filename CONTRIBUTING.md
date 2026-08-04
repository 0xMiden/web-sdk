# Contributing to web-sdk

We welcome PRs. Before opening one:

1. Read [CLAUDE.md](CLAUDE.md) for repo-specific conventions and tooling notes.
2. Run `make lint test` locally — CI runs the same suite, but local feedback is faster.
3. For changes that touch the public API surface (hooks, WASM bindings, plugin options), include or update the type tests in `crates/web-client/scripts/check-*-types.js`.

The upstream Rust SDK lives at [`0xMiden/rust-sdk`](https://github.com/0xMiden/rust-sdk); changes that touch shared types or the gRPC schema usually need a coordinated PR there first.

## Linking a web-sdk PR to an in-flight rust-sdk PR

When your web-sdk PR depends on Rust changes that haven't been released yet — i.e. the upstream change is still an open PR on `0xMiden/rust-sdk` — add a single marker line at the top of your web-sdk PR description:

```
Client PR: #1234
```

Cross-repo / fork form (when the upstream PR is on a different repo or fork):

```
Client PR: 0xMiden/rust-sdk#1234
```

You should not edit `Cargo.toml` to retarget the dep yourself — keep it pointing at `branch = "next"` (or the released version on crates.io). The marker is enough.

### What CI does with the marker

Three pieces work together:

1. **Auto-patch** (`.github/actions/inject-linked-client-pr`). On every PR run, the action parses your description, resolves the linked PR's head branch, rewrites the workspace `miden-client` (and `miden-client-sqlite-store`, when present) dep in place on the runner, and refreshes `Cargo.lock`. The committed `Cargo.toml` is never touched — the rewrite lives only in the runner's filesystem for the duration of the job.
2. **Sticky comment**. The `build-wasm` job posts (and updates) one sticky PR comment summarizing what was patched (linked PR, head ref + sha, upstream state). Strict 0-or-1 comment per PR — the workflow deletes the comment if you later remove the marker.
3. **Readiness gate** (`.github/workflows/check-linked-client-pr.yml`). Posts a custom commit status named `linked-client-pr-ready`. While the linked PR is unmerged, the status stays `pending` with a clear description; it auto-flips to `success` once the linked PR is merged AND reachable from the target branch's canonical ref:
   - `next`-targeted PRs → ready when the linked PR's merge commit is on rust-sdk `next`.
   - `main`-targeted PRs → ready when the linked PR's merge commit is in the latest rust-sdk release tag.
   The gate re-evaluates every 15 minutes via cron, so the check goes green automatically after upstream catches up — no need to push to your PR.

Configure branch protection to require **`linked-client-pr-ready`** as a status check, not the matrix job `gate (...)` — the latter is just the runner; the former is the verdict.

If the linked PR is closed without merge, the auto-patch step fails the build with an explicit `Linked PR closed without merge` error. Either re-open the linked PR, point the marker at a different one, or remove the marker (and add the dep retarget by hand).

### Local-dev parity

To make `cargo build` / `cargo check` work the same way locally:

```bash
# Apply the same patch to your working tree (auto-detects the marker
# from the current branch's PR body):
scripts/dev-with-client-pr.sh

# Or pass an explicit number / cross-repo target:
scripts/dev-with-client-pr.sh 1234
scripts/dev-with-client-pr.sh some-fork/rust-sdk#1234

# Strip the patch before committing:
scripts/dev-with-client-pr.sh --clear
```

The script writes a marker-wrapped block at the bottom of `Cargo.toml`. A pre-commit hook (lefthook) refuses any commit while the markers are present, so you can't ship the local override by accident.

### When NOT to use the marker

Three situations where you still want to edit `Cargo.toml` by hand instead:

1. **The upstream PR's branch was rebased past changes that web-sdk hasn't caught up to yet.** If the PR head includes additional incompatible `Store` or protocol changes, use a compatible rust-sdk branch or commit and retarget `Cargo.toml` manually.
2. **You want to test against a specific commit, not the PR's HEAD.** The auto-patch always resolves to the head ref of the linked PR. If you need a fixed sha, use a hand-written `git = ..., rev = "..."` retarget.
3. **You're testing a draft branch that has no PR yet.** No PR → no marker → fall back to manual retarget.

## Releasing

A release bumps **two independent version lines** that must move together:

1. **npm packages** — `version` in `crates/web-client/package.json`, `packages/react-sdk/package.json`, and the `packages/node-sdk-*/package.json` natives (plus the `@miden-sdk/*` dependency ranges that reference them).
2. **Rust crates** — `version` under `[workspace.package]` in the root `Cargo.toml`, **and** the matching `version` fields of the internal crates in `[workspace.dependencies]` (`idxdb-store`, `js-export-macro`). All workspace crates share this version.

The Rust version is easy to forget because it's decoupled from npm, but `Publish Rust Crates on Release` runs `cargo publish` for the crates at the workspace version — if it isn't bumped, the publish fails with `crate <name>@<version> already exists on crates.io index`. Keep the Rust workspace version aligned with the npm release version.

Then open the release PR, merge it, and publish a GitHub Release tagged `vX.Y.Z` — `publish-web-sdk.yml` ships the npm packages and `publish-crates-release.yml` publishes the Rust crates.
