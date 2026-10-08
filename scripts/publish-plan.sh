#!/usr/bin/env bash
set -uo pipefail

# Build a publish plan from scripts/publish-manifest.json, then execute it in
# dependency-level order so a dependent never lands before the package it pins.
#
# Usage:
#   publish-plan.sh plan    <mode> <base-sha>      -> writes the plan to stdout as JSON
#   publish-plan.sh publish <plan-json> <dist-tag> -> builds the plan's first-party
#                                                     dependency closure, then
#                                                     publishes the plan
#
# PUBLISH_DRY_RUN=1 runs everything except the `pnpm publish` calls themselves.
# It exists so the build/closure path can be exercised without touching a
# registry; it is loudly announced at both ends of the run so a stray value in
# CI cannot masquerade as a successful release.
#
# Deliberately no `set -e`: one package failing must not abandon the rest
# silently. Failures are counted and reported, and the script exits non-zero.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/scripts/publish-manifest.json"

# Set by run_build_phase, read by cmd_publish. Declared here so `set -u` holds
# even if the build phase bails before assigning them.
MANIFEST_NAMES=""
BUILD_FAILED_NAMES=" "
BUILD_FAILED_COUNT=0

DRY_RUN=""
case "${PUBLISH_DRY_RUN:-}" in
  ''|0|false|no) ;;
  *) DRY_RUN=1 ;;
esac

cmd_plan() {
  local mode="$1" base_sha="${2:-}" plan="[]"
  local rows

  # Read and validate the manifest BEFORE the loop, and fail closed.
  #
  # `done < <(jq ...)` throws jq's exit status away, so an unreadable, malformed
  # or empty manifest produces zero iterations, leaves the plan at "[]", prints
  # "[]" and exits 0. The workflow then reads adopted_count=0, skips the publish
  # step entirely and routes to the `skipped` job — a release that published
  # nothing and reported success. A manifest we cannot read is a defect, not an
  # empty release, so it has to fail the job.
  if [ ! -r "$MANIFEST" ]; then
    echo "::error::publish-plan: manifest is missing or unreadable at $MANIFEST" >&2
    return 1
  fi
  if ! rows=$(jq -r '.packages[] | [.name, .path, (.level|tostring), (.build|tostring)] | @tsv' \
                "$MANIFEST"); then
    echo "::error::publish-plan: could not parse $MANIFEST (see jq's error above)" >&2
    return 1
  fi
  if [ -z "$rows" ]; then
    echo "::error::publish-plan: $MANIFEST lists no packages" >&2
    return 1
  fi

  while IFS=$'\t' read -r name path level build; do
    [ -n "$name" ] || continue
    local out should version
    # `</dev/null`: the manifest rows are this loop's stdin, so a child that
    # reads stdin (an npm prompt, a stray `read`) would otherwise swallow the
    # rest of them and the loop would end early, silently, exit 0.
    out=$("$ROOT/scripts/check-package-version.sh" "$mode" "$path" "$base_sha" </dev/null)
    should=$(printf '%s' "$out" | awk '{print $1}')
    version=$(printf '%s' "$out" | awk '{print $2}')
    if [ "$should" = "true" ]; then
      plan=$(printf '%s' "$plan" | jq -c \
        --arg n "$name" --arg p "$path" --arg v "$version" \
        --argjson l "$level" --argjson b "$build" \
        '. + [{name:$n, path:$p, version:$v, level:$l, build:$b}]')
    fi
  done <<MANIFEST_ROWS
$rows
MANIFEST_ROWS
  printf '%s\n' "$plan"
}

# ── The build closure ────────────────────────────────────────────────────────
#
# The plan says what to PUBLISH. What has to be BUILT is a superset: every
# first-party package the plan compiles against, whether or not it is itself
# being published.
#
# This is what a retry runs into. A partially-published release leaves the
# packages that reached npm out of the next plan — check-package-version.sh
# correctly refuses to republish a version that already exists — so they are
# never built either, and dist/ is gitignored, so on a fresh CI checkout their
# build output simply does not exist. Their dependents then compile against a
# sibling whose "types": "dist/index.d.ts" points at nothing.
#
# Whether that is fatal depends on the sibling's source layout, which is not
# something a release script should be betting on:
#   - packages/adapter/{base,miden} keep index.ts beside package.json, so
#     TypeScript's node10 resolution falls back from the missing `types` to the
#     source file and the dependent quietly builds (verified: identical dist).
#   - packages/adapter/reactui is src/-layout, so there is no fallback. Verified
#     by wiping reactui/dist and building @miden-sdk/miden-wallet-adapter:
#     `index.ts(21,15): error TS2307: Cannot find module
#      '@miden-sdk/miden-wallet-adapter-reactui'`.
# On top of that, packages/adapter/all's copy-styles reads reactui's *dist*
# directly (`copyfiles -u 4 node_modules/@miden-sdk/miden-wallet-adapter-reactui/
# dist/styles.css dist/`), and copyfiles exits 0 on a glob that matches nothing
# — which is exactly how v0.16.0-rc.5 shipped a dead "./styles.css" export.
#
# So: build the transitive first-party closure of the plan, in level order.
# A closure member that is NOT in the plan is BUILT AND NOT PUBLISHED. Building
# and publishing are separate steps and must stay separate — the packages
# already on npm at this version are immutable, and the plan remains the sole
# authority on what reaches the registry.

# The dependency edges come from each package's OWN package.json, intersected
# with the manifest, so there is no second graph here to drift from reality.
#
# All three dependency maps are read, because "what the build needs on disk"
# does not follow the dependencies/peerDependencies split: adapter-react reaches
# its siblings through `dependencies`, while turnkey-react declares
# @miden-sdk/turnkey only as a peer + dev dependency. Intersecting with the
# manifest is what keeps the result tight — third-party packages are installed
# by pnpm, never built by us, so they drop out.
first_party_deps() {
  jq -r --argjson names "$MANIFEST_NAMES" '
      ((.dependencies // {}) + (.peerDependencies // {}) + (.devDependencies // {}))
      | keys
      | map(select(. as $d | $names | index($d)))
      | .[]' "$ROOT/$1/package.json"
}

manifest_path_of() {
  jq -r --arg n "$1" '.packages[] | select(.name == $n) | .path' "$MANIFEST"
}

# Breadth-first walk over those edges. $1 is the newline-separated seed set;
# prints the closure (seed included), one name per line, each name once.
closure_of() {
  local pending="$1" seen=" " closure="" frontier name path deps
  while [ -n "$(printf '%s' "$pending" | tr -d '[:space:]')" ]; do
    frontier="$pending"
    pending=""
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      # Space-padded match so a name is never mistaken for a prefix of another:
      # @miden-sdk/miden-wallet-adapter must not swallow ...-adapter-base.
      case "$seen" in *" $name "*) continue ;; esac
      seen="$seen$name "
      closure="$closure$name"$'\n'
      path=$(manifest_path_of "$name")
      if [ -z "$path" ] || [ ! -f "$ROOT/$path/package.json" ]; then
        echo "::error::publish-plan: $name has no manifest entry or no package.json at '${path:-<unknown>}'" >&2
        return 1
      fi
      deps=$(first_party_deps "$path") || return 1
      pending="$pending$deps"$'\n'
    done <<CLOSURE_FRONTIER
$frontier
CLOSURE_FRONTIER
  done
  printf '%s' "$closure"
}

# Order a set of names by the manifest's `level`, ascending — the same
# topological order the publish loop uses, so a dependency's dist/ is on disk
# before the dependent's compiler goes looking for it.
build_order() {
  local names_json
  names_json=$(printf '%s' "$1" | jq -R -s -c 'split("\n") | map(select(length > 0))') || return 1
  jq -r --argjson want "$names_json" '
      .packages
      | map(select(.name as $n | $want | index($n)))
      | sort_by(.level)
      | .[] | [.name, .path, (.level|tostring), (.build|tostring)] | @tsv' "$MANIFEST"
}

# Builds the plan's closure. Records failures in BUILD_FAILED_NAMES /
# BUILD_FAILED_COUNT rather than aborting, so the log shows the whole picture;
# cmd_publish then refuses to publish any planned package whose own dependency
# closure contains one of those failures.
run_build_phase() {
  local plan="$1"
  local plan_names planned closure ordered name path level build tag
  BUILD_FAILED_NAMES=" "
  BUILD_FAILED_COUNT=0

  MANIFEST_NAMES=$(jq -c '[.packages[].name]' "$MANIFEST")
  if [ -z "$MANIFEST_NAMES" ] || [ "$MANIFEST_NAMES" = "[]" ]; then
    echo "::error::publish-plan: could not read package names from $MANIFEST"
    return 1
  fi

  plan_names=$(printf '%s' "$plan" | jq -r '.[].name')
  closure=$(closure_of "$plan_names") || return 1
  ordered=$(build_order "$closure") || return 1
  # Space-padded on BOTH ends: `$(...)` strips the trailing newline, so without
  # the closing space the LAST plan entry would never match the `case` below and
  # would be mislabelled as a build-only dependency.
  planned=" $(printf '%s' "$plan_names" | tr '\n' ' ') "

  echo "publish-plan: building the plan and its first-party dependency closure"
  while IFS=$'\t' read -r name path level build; do
    [ -n "$name" ] || continue
    case "$planned" in
      *" $name "*) tag="planned" ;;
      *)           tag="dependency - BUILT, NOT PUBLISHED" ;;
    esac
    if [ "$build" != "true" ]; then
      echo "skip build: $name (level $level) [$tag] - manifest says build:false"
      continue
    fi
    echo "building $name (level $level, $path) [$tag] ..."
    if ! pnpm --filter "$name" run build </dev/null; then
      echo "::error::build failed for $name (level $level, $path)"
      BUILD_FAILED_COUNT=$((BUILD_FAILED_COUNT + 1))
      BUILD_FAILED_NAMES="${BUILD_FAILED_NAMES}${name} "
    fi
  # Heredoc, not a pipe: the loop must stay in this shell so its tallies survive.
  done <<BUILD_ORDER
$ordered
BUILD_ORDER
  return 0
}

# Which members of $1's first-party dependency closure failed to build.
#
# A build failure is not contained to the package that failed: everything
# downstream of it compiles against whatever its dist/ happened to hold — stale
# output from a previous run, or nothing at all, in which case node10 resolution
# silently falls back to the sibling's source (see the closure comment above).
# Either way the dependent's build can go green while being wrong, and that is
# how a broken package reaches npm. So the publish guard is over the CLOSURE,
# not over the package's own name.
#
# Reuses closure_of/first_party_deps — the same edges the build phase walked,
# read from each package.json, so there is no second graph to drift. The closure
# includes the seed, so this subsumes the own-build-failed check.
#
# Prints the failed names space-separated with a leading space, empty when the
# closure is clean.
failed_closure_members() {
  local closure member broken=""
  closure=$(closure_of "$1") || return 1
  while IFS= read -r member; do
    [ -n "$member" ] || continue
    case "$BUILD_FAILED_NAMES" in *" $member "*) broken="$broken $member" ;; esac
  done <<CLOSURE_MEMBERS
$closure
CLOSURE_MEMBERS
  printf '%s' "$broken"
}

cmd_publish() {
  local plan="$1" dist_tag="$2"
  local expected attempted=0 publish_failed=0 publish_refused=0
  local level name path version broken

  expected=$(printf '%s' "$plan" | jq 'length' 2>/dev/null)
  # The guard at the bottom of this function is the only thing standing between
  # "published nothing" and "reported success". It must not fail open: with a
  # malformed plan `expected` is the empty string, `[ "$attempted" -ne "" ]`
  # exits 2 rather than 1, `if` reads any non-zero status as false, and the run
  # ends green having published nothing. Validate it up front instead.
  case "$expected" in
    ''|*[!0-9]*)
      echo "::error::publish-plan: could not read the plan as a JSON array (got: $(printf '%.200s' "$plan"))"
      return 1
      ;;
  esac

  if [ "$expected" = "0" ]; then
    echo "publish-plan: nothing to publish."
    return 0
  fi

  if [ -n "$DRY_RUN" ]; then
    echo "=============================================================="
    echo "  PUBLISH_DRY_RUN is set: packages will be BUILT but NOTHING"
    echo "  will be sent to any registry."
    echo "=============================================================="
  fi

  echo "publish-plan: $expected package(s) to publish with --tag $dist_tag"

  # Phase 1 - build the plan AND everything the plan builds against.
  run_build_phase "$plan" || return 1

  # Phase 2 - publish the plan, and only the plan. Nothing phase 1 pulled in as
  # a dependency is published here; the plan already excludes every package npm
  # holds at this version, and that exclusion is the whole safety property.
  local levels
  levels=$(printf '%s' "$plan" | jq -r '[.[].level] | unique | .[]')
  for level in $levels; do
    echo "--- publish level $level ---"
    while IFS=$'\t' read -r name path version; do
      [ -n "$name" ] || continue
      attempted=$((attempted + 1))
      # Refuse the whole closure, not just this package's own name: a dependent
      # whose dependency failed to build compiled against stale or fallback
      # types and must not reach the registry. Only worth walking when the build
      # phase actually recorded a failure.
      if [ "$BUILD_FAILED_COUNT" -ne 0 ]; then
        if ! broken=$(failed_closure_members "$name"); then
          echo "::error::not publishing $name@$version - could not resolve its first-party dependency closure"
          publish_refused=$((publish_refused + 1))
          continue
        fi
        if [ -n "$broken" ]; then
          case "$broken " in
            *" $name "*)
              echo "::error::not publishing $name@$version - its own build failed above (failed in its closure:$broken)"
              ;;
            *)
              echo "::error::not publishing $name@$version - it compiles against first-party package(s) that failed to build:$broken"
              ;;
          esac
          publish_refused=$((publish_refused + 1))
          continue
        fi
      fi
      if [ -n "$DRY_RUN" ]; then
        echo "DRY RUN: would publish $name@$version (--tag $dist_tag)"
        continue
      fi
      echo "publishing $name@$version (--tag $dist_tag) ..."
      if ! pnpm --filter "$name" publish \
            --tag "$dist_tag" --access public --provenance --no-git-checks </dev/null; then
        echo "::error::publish failed for $name@$version"
        publish_failed=$((publish_failed + 1))
      fi
    done < <(printf '%s' "$plan" | jq -r --argjson l "$level" \
        '.[] | select(.level == $l) | [.name, .path, .version] | @tsv')
  done

  # A loop that publishes nothing and exits 0 is the failure mode this guards:
  # a malformed plan, a jq that produced no rows, or a swallowed stdin would all
  # otherwise read as success.
  if [ "$attempted" -ne "$expected" ]; then
    echo "::error::plan had $expected entries but only $attempted were attempted"
    return 1
  fi
  if [ "$BUILD_FAILED_COUNT" -ne 0 ]; then
    echo "::error::$BUILD_FAILED_COUNT package(s) in the build closure failed to build:${BUILD_FAILED_NAMES% }"
  fi
  if [ "$publish_refused" -ne 0 ]; then
    echo "::error::$publish_refused of $expected planned package(s) were refused because their first-party dependency closure failed to build"
  fi
  if [ "$publish_failed" -ne 0 ]; then
    echo "::error::$publish_failed of $expected planned package(s) failed to publish"
  fi
  if [ "$BUILD_FAILED_COUNT" -ne 0 ] || [ "$publish_failed" -ne 0 ] || [ "$publish_refused" -ne 0 ]; then
    return 1
  fi
  if [ -n "$DRY_RUN" ]; then
    echo "publish-plan: DRY RUN complete - built the closure, published NOTHING."
    return 0
  fi
  echo "publish-plan: published $expected package(s)."
  return 0
}

case "${1:-}" in
  plan)    shift; cmd_plan "$@" ;;
  publish) shift; cmd_publish "$@" ;;
  *) echo "usage: publish-plan.sh {plan <mode> <base-sha> | publish <plan-json> <dist-tag>}" >&2; exit 2 ;;
esac
