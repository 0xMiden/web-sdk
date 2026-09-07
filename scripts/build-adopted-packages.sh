#!/usr/bin/env bash
set -uo pipefail

# Build every package that scripts/publish-manifest.json marks `"build": true`,
# in the manifest's topological `level` order.
#
# WHY THIS EXISTS
# ---------------
# The adopted packages (adapter/*, para/*, turnkey/*) are pnpm workspace members
# but nothing in CI ever compiled them: build.yml builds the Rust/WASM client,
# test.yml runs vitest, lint.yml runs eslint, and check-publish.yml's publint +
# attw gates are filtered to exactly three packages. The first `tsc` over an
# adopted package therefore ran inside publish-web-sdk.yml at *release* time —
# on a tag, after sibling packages had already gone to npm. v0.16.0-rc.5 lost 5
# of 11 packages that way to type errors that had been sitting on `next`.
#
# This script is that missing compile, run per PR. It deliberately invokes the
# same `pnpm --filter <name> run build` that scripts/publish-plan.sh runs at
# release time, so what CI proves is exactly what the release will do.
#
# SINGLE SOURCE OF TRUTH
# ----------------------
# The manifest is the only list. Adding a package there with "build": true
# brings it under CI automatically; there is no second list to keep in sync.
# The `level` grouping matters because a dependent typechecks against its
# sibling's *emitted* dist/ — building level N before N+1 is what makes that
# work, and it is the same ordering the release publishes in.
#
# An exit code is not enough on its own, so after building we also assert that
# each package ships the files its package.json promises — see
# scripts/check-package-artifacts.sh for why (short version: `copyfiles` exits 0
# when its source glob matches nothing, which is how adapter/all shipped a dead
# "./styles.css" export through a green build).
#
# Deliberately no `set -e`: one package failing must not hide the state of the
# rest. Every package is attempted, failures are collected, and the summary at
# the end names each one with its level. Mirrors publish-plan.sh's contract.
#
# FAILING CLOSED
# --------------
# Every jq here runs into a variable whose exit status is then checked, and
# every count is validated as a non-negative integer before it is compared.
# That is not defensive decoration — it is the one bug this file kept having.
# `x=$(jq ...)` reports the status of the *assignment*, and `while read ... <
# <(jq ...)` reports the status of nothing at all, so a manifest jq cannot parse
# produced: no rows, a loop that ran zero times, every counter still 0, and
# `expected` set to the empty string. The guard meant to catch that,
# `[ "$attempted" -ne "$expected" ]`, is then a bash *error* (status 2, "integer
# expression expected") — and `if` reads any non-zero status as false, so the
# guard did not fire, and the script fell through to
# "built package(s); all declared entry points present." and exit 0. A build
# gate that built nothing and reported green is worse than no gate, because the
# green is believed.
#
# The manifest is also validated BEFORE `pnpm` is invoked: a missing or
# unparsable manifest is a fact about this repo, and reporting it must not
# depend on a working pnpm workspace.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/scripts/publish-manifest.json"

# Anchor to the repo root so every path this script prints is repo-relative and
# readable in a CI log, whatever directory the job invoked it from.
cd "$ROOT" || exit 1

# `[ "$a" -ne "$b" ]` with an empty or non-numeric operand is a bash *error*
# (status 2), and `if` reads any non-zero status as false — so a guard written
# that way silently does not fire. Nothing is compared before passing this.
is_count() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# ── Read the manifest (fail closed) ──────────────────────────────────────────

if [ ! -f "$MANIFEST" ]; then
  echo "::error title=Manifest missing::$MANIFEST does not exist — there is no list of packages to build"
  exit 1
fi

# `.packages[]` on a null or non-array `.packages` is a jq error, so this one
# expression covers "not JSON", "not an object" and "no packages key".
if ! manifest_rows=$(jq -r '.packages[] | [.name, .path, (.build | tostring)] | @tsv' "$MANIFEST" 2>&1); then
  echo "::error title=Manifest unreadable::cannot read package list out of $MANIFEST: $(printf '%s' "$manifest_rows" | tr '\n' ' ')"
  exit 1
fi

if ! total=$(jq '.packages | length' "$MANIFEST" 2>&1) || ! is_count "$total"; then
  echo "::error title=Manifest unreadable::cannot count the packages in $MANIFEST (got '$total')"
  exit 1
fi

# An empty manifest is not "nothing to do", it is the gate switched off: every
# loop below would run zero times and every check would pass vacuously.
if [ "$total" -eq 0 ]; then
  echo "::error title=Manifest empty::$MANIFEST lists no packages — refusing to report success for a build that would build nothing and verify nothing"
  exit 1
fi

if ! expected=$(jq '[.packages[] | select(.build)] | length' "$MANIFEST" 2>&1) || ! is_count "$expected"; then
  echo "::error title=Manifest unreadable::cannot count the \"build\": true packages in $MANIFEST (got '$expected')"
  exit 1
fi

# Emitted as one sorted stream rather than one jq call per level: fewer places
# for a discarded exit status to hide, and jq's sort_by is stable, so packages
# keep their manifest order inside a level.
if ! build_rows=$(jq -r '[.packages[] | select(.build)] | sort_by(.level) | .[]
                         | [(.level | tostring), .name, .path] | @tsv' "$MANIFEST" 2>&1); then
  echo "::error title=Manifest unreadable::cannot read the build list out of $MANIFEST: $(printf '%s' "$build_rows" | tr '\n' ' ')"
  exit 1
fi

# ── Preflight: the manifest must describe the workspace that actually exists ──
#
# `pnpm --filter` is silent about a filter that matches nothing: both
# `pnpm --filter @miden-sdk/typo run build` (no such package) and
# `pnpm --filter @miden-sdk/real run build` (package exists, has no `build`
# script) print a notice and exit **0**. Without this preflight a renamed
# package, a moved directory, or a `"build": true` on a package that never had a
# build script would all leave this job green while building nothing — the exact
# manifest-drifts-from-reality failure the job is here to prevent.
echo "::group::Validate manifest against the pnpm workspace"
inventory_rc=0
inventory=$(pnpm -r --depth -1 list --json 2>&1) || inventory_rc=$?
if [ "$inventory_rc" -ne 0 ] || ! printf '%s' "$inventory" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
  echo "::endgroup::"
  echo "::error title=Workspace unreadable::'pnpm -r --depth -1 list --json' did not return a non-empty JSON array, so the manifest cannot be validated against the workspace"
  printf '%s\n' "$inventory" | head -20 | sed 's/^/    pnpm: /'
  exit 1
fi

drift=0
seen=0
while IFS=$'\t' read -r name path build; do
  [ -n "$name" ] || continue
  seen=$((seen + 1))

  # ltrimstr, not sub: sub() takes a regex, and a checkout path containing a
  # regex metacharacter (a '.' or '+' in a directory name) would then strip the
  # wrong prefix — or none — and report phantom drift.
  if ! ws_path=$(printf '%s' "$inventory" | jq -r --arg n "$name" --arg root "$ROOT/" \
      '.[] | select(.name == $n) | .path | ltrimstr($root)' 2>&1); then
    echo "::error title=Manifest drift::could not look $name up in the pnpm workspace inventory: $(printf '%s' "$ws_path" | tr '\n' ' ')"
    drift=$((drift + 1))
    continue
  fi
  if [ -z "$ws_path" ]; then
    echo "::error title=Manifest drift::$name is in scripts/publish-manifest.json but is not a pnpm workspace package — was it renamed, or is its directory missing from pnpm-workspace.yaml?"
    drift=$((drift + 1))
    continue
  fi
  if [ "$ws_path" != "$path" ]; then
    echo "::error title=Manifest drift::$name is at '$ws_path' but scripts/publish-manifest.json says '$path'"
    drift=$((drift + 1))
    continue
  fi
  if [ "$build" = "true" ]; then
    if [ ! -f "$ROOT/$path/package.json" ]; then
      echo "::error title=Manifest drift::$name is marked \"build\": true but $path/package.json does not exist"
      drift=$((drift + 1))
      continue
    fi
    # An unparsable package.json must not read as "no build script" (one error
    # message) nor as "has one" (silently building nothing) — name it for what
    # it is.
    if ! build_script=$(jq -r '.scripts.build // ""' "$ROOT/$path/package.json" 2>&1); then
      echo "::error title=Manifest drift::$name — cannot parse $path/package.json: $(printf '%s' "$build_script" | tr '\n' ' ')"
      drift=$((drift + 1))
      continue
    fi
    if [ -z "$build_script" ]; then
      echo "::error title=Manifest drift::$name is marked \"build\": true but $path/package.json has no \"build\" script — pnpm would exit 0 without building anything"
      drift=$((drift + 1))
      continue
    fi
  fi
  echo "ok: $name -> $path$([ "$build" = "true" ] && echo " (build)")"
done <<EOF
$manifest_rows
EOF
echo "::endgroup::"

if [ "$seen" -ne "$total" ]; then
  echo "::error title=Manifest unreadable::$MANIFEST lists $total package(s) but only $seen were validated — the manifest rows and the manifest length disagree"
  exit 1
fi

if [ "$drift" -ne 0 ]; then
  echo "::error::$drift manifest entr(ies) do not match the workspace — fix scripts/publish-manifest.json before building"
  exit 1
fi

# ── Build ────────────────────────────────────────────────────────────────────

attempted=0
failed=0
failures=""
# Space-delimited, space-padded so `case " $failed_names " in *" $name "*)`
# matches whole names only — a substring match would let
# @miden-sdk/miden-wallet-adapter swallow @miden-sdk/miden-wallet-adapter-base.
failed_names=" "

if [ "$expected" -eq 0 ]; then
  # Not fatal — a manifest of publish-only packages (the create-* scaffolders
  # ship straight out of the checkout) is a legal configuration. But it is never
  # silent: the entry-point verification below still runs over all $total
  # packages, and the summary says "0 built" rather than implying otherwise.
  echo "::warning title=Nothing to build::scripts/publish-manifest.json marks no package \"build\": true — skipping the build phase and verifying declared entry points only"
else
  echo "build-adopted-packages: $expected package(s) to build, in manifest level order"

  current_level=""
  # Read the build list into the loop WITHOUT giving it the loop's stdin, so a
  # child that reads stdin cannot swallow the rest of the list and end the loop
  # early, silently, exit 0. Same guard as publish-plan.sh.
  while IFS=$'\t' read -r level name path; do
    [ -n "$name" ] || continue
    if [ "$level" != "$current_level" ]; then
      echo "--- level $level ---"
      current_level="$level"
    fi
    attempted=$((attempted + 1))
    echo "::group::build $name (level $level, $path)"
    if pnpm --filter "$name" run build </dev/null; then
      echo "::endgroup::"
      echo "ok: $name (level $level)"
    else
      echo "::endgroup::"
      # The annotation carries the package, its level and its path so the
      # failure is readable from the run summary without opening the log group.
      echo "::error title=Adopted package build failed::$name (level $level, $path) — 'pnpm --filter $name run build' exited non-zero"
      failed=$((failed + 1))
      failures="${failures}  - $name (level $level, $path)"$'\n'
      failed_names="${failed_names}${name} "
    fi
  done <<EOF
$build_rows
EOF
fi

# A loop that builds nothing and exits 0 is the failure mode this guards: a
# malformed manifest or a swallowed stdin would otherwise read as success.
# Both operands are integers by construction above, so this comparison cannot
# error to false.
if [ "$attempted" -ne "$expected" ]; then
  echo "::error::manifest marks $expected package(s) as build:true but only $attempted were attempted"
  exit 1
fi

# ── Verify declared entry points ─────────────────────────────────────────────
#
# The build loop above proves every build command returned 0. It does NOT prove
# anything reached the tarball: a `copyfiles` whose glob matches nothing, a `cp`
# behind a `|| true`, a renamed output, a `files` field that excludes the
# emitted path — all of those exit 0 and ship nothing. That is not hypothetical;
# it is how packages/adapter/all shipped v0.16.0-rc.5 with
# `"./styles.css": "./dist/styles.css"` in its exports map and no such file in
# the tarball. So re-check the contract package.json states.
#
# Runs over EVERY manifest package, not just the build:true ones: a build:false
# package ships files straight out of the checkout (the create-* scaffolders
# publish a `bin`), so its entry points must exist too. Packages whose build
# already failed are skipped — their artifacts are missing *because* of that
# failure, and a second error would just be noise.
echo "::group::Verify declared entry points"
artifact_failed=0
artifact_considered=0
artifact_failures=""
while IFS=$'\t' read -r name path build; do
  [ -n "$name" ] || continue
  artifact_considered=$((artifact_considered + 1))
  case "$failed_names" in
    *" $name "*)
      echo "skip: $name (its build failed above)"
      continue
      ;;
  esac
  if ! ./scripts/check-package-artifacts.sh "$path" "$name" </dev/null; then
    artifact_failed=$((artifact_failed + 1))
    artifact_failures="${artifact_failures}  - $name ($path)"$'\n'
  fi
done <<EOF
$manifest_rows
EOF
echo "::endgroup::"

# Same guard as the build loop, for the same reason: "0 packages verified" must
# never be reachable while the summary below prints an ok line.
if [ "$artifact_considered" -ne "$total" ]; then
  echo "::error::manifest lists $total package(s) but only $artifact_considered were checked for declared entry points"
  exit 1
fi

# ── Summary ──────────────────────────────────────────────────────────────────

if [ "$failed" -ne 0 ]; then
  echo
  echo "::error::$failed of $expected adopted package(s) failed to build"
  echo "failed packages:"
  printf '%s' "$failures"
fi

if [ "$artifact_failed" -ne 0 ]; then
  echo
  echo "::error::$artifact_failed adopted package(s) do not ship files their package.json declares"
  echo "packages with missing entry points:"
  printf '%s' "$artifact_failures"
fi

if [ "$failed" -ne 0 ] || [ "$artifact_failed" -ne 0 ]; then
  exit 1
fi

echo "build-adopted-packages: built $expected package(s); all declared entry points present in all $total package tarball(s)."
