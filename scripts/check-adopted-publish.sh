#!/usr/bin/env bash
set -uo pipefail

# Run publint or arethetypeswrong (attw) over the adopted packages, driven by
# scripts/publish-manifest.json.
#
# WHY THIS EXISTS
# ---------------
# The root `check:publint` / `check:attw` scripts are filtered to exactly three
# packages — @miden-sdk/miden-sdk, @miden-sdk/react, @miden-sdk/vite-plugin. The
# eleven adopted packages (adapter/*, para/*, turnkey/*) have never been linted
# for package shape at all, and two of them shipped real defects in v0.16.0-rc.5
# that publint would have caught on the PR that introduced them.
#
# SINGLE SOURCE OF TRUTH
# ----------------------
# The package list comes from the manifest, the same file that drives
# build-adopted-packages.sh and publish-plan.sh. There is deliberately no second
# list here to fall out of sync with it.
#
# Deliberately no `set -e` and no `pnpm --filter A --filter B ... exec`: pnpm's
# recursive exec stops at the first non-zero package (ERR_PNPM_RECURSIVE_EXEC_
# FIRST_FAIL), so one bad package hides the state of every package after it. We
# want the whole picture from one run, so each package is invoked on its own and
# failures are collected. Same contract as publish-plan.sh.
#
# FAILING CLOSED
# --------------
# Every jq here runs into a variable whose exit status is then checked, and
# every count is validated as a non-negative integer before it is compared.
# `expected=$(jq '.packages | length' "$MANIFEST")` reports the status of the
# *assignment*, and `while read ... < <(jq ...)` reports the status of nothing —
# so on a missing or malformed manifest jq printed nothing, the loop ran zero
# times, `considered` stayed 0, and `expected` was the empty string. The guard
# meant to catch exactly that, `[ "$considered" -ne "$expected" ]`, is then a
# bash *error* (status 2, "integer expression expected"), and `if` reads a
# non-zero status as false — so it did not fire and the script printed
# "publint clean across 0 package(s)" and exited 0. A lint gate that linted
# nothing and reported green is worse than no gate.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/scripts/publish-manifest.json"
cd "$ROOT" || exit 1

tool="${1:-}"
case "$tool" in
  publint | attw) ;;
  *)
    echo "usage: check-adopted-publish.sh {publint|attw}" >&2
    exit 2
    ;;
esac

# `[ "$a" -ne "$b" ]` with an empty or non-numeric operand is a bash *error*
# (status 2), and `if` reads any non-zero status as false — so a guard written
# that way silently does not fire. Nothing is compared before passing this.
is_count() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# attw answers "are the *types* wrong". A package that publishes no type
# declarations has nothing for it to answer, and attw reports the absence as
# "Resolution failed" on every profile — true, and irrelevant: the create-*
# packages are `bin`-only project scaffolders with no importable entry point at
# all. Detect that from package.json (a `types`/`typings` field, or a "types"
# condition anywhere in `exports`) rather than naming the packages, so the rule
# keeps working as packages are added.
#
# Three-valued on purpose: 0 = ships types, 1 = does not, 2 = could not tell.
# "Could not tell" must never collapse into "does not" — that would turn an
# unreadable package.json into a silent skip, which is the fail-open shape this
# file is being hardened against — so the caller turns 2 into a failure.
ships_types() {
  local out
  [ -f "$1/package.json" ] || return 2
  out=$(jq -r '
        if (.types // .typings) != null then "yes"
        elif ((.exports // null) | [.. | objects | keys[]] | any(. == "types")) then "yes"
        else "no" end' "$1/package.json" 2>/dev/null) || return 2
  case "$out" in
    yes) return 0 ;;
    no) return 1 ;;
    *) return 2 ;;
  esac
}

# ── Read the manifest (fail closed) ──────────────────────────────────────────

if [ ! -f "$MANIFEST" ]; then
  echo "::error title=Manifest missing::$MANIFEST does not exist — there is no list of packages to check"
  exit 1
fi

# `.packages[]` on a null or non-array `.packages` is a jq error, so this one
# expression covers "not JSON", "not an object" and "no packages key".
if ! manifest_rows=$(jq -r '.packages[] | [.name, .path] | @tsv' "$MANIFEST" 2>&1); then
  echo "::error title=Manifest unreadable::cannot read package list out of $MANIFEST: $(printf '%s' "$manifest_rows" | tr '\n' ' ')"
  exit 1
fi

if ! expected=$(jq '.packages | length' "$MANIFEST" 2>&1) || ! is_count "$expected"; then
  echo "::error title=Manifest unreadable::cannot count the packages in $MANIFEST (got '$expected')"
  exit 1
fi

# An empty manifest is not "nothing to check", it is the gate switched off.
if [ "$expected" -eq 0 ]; then
  echo "::error title=Manifest empty::$MANIFEST lists no packages — refusing to report '$tool clean' over nothing"
  exit 1
fi

echo "check-adopted-publish: running $tool over $expected manifest package(s)"

considered=0
skipped=0
failed=0
failures=""

# Read the manifest into the loop WITHOUT giving it the loop's stdin: publint
# and attw both shell out to `pnpm pack`, and a child that reads stdin would
# otherwise swallow the rest of the manifest and end the loop early, exit 0.
while IFS=$'\t' read -r name path; do
  [ -n "$name" ] || continue
  considered=$((considered + 1))

  if [ "$tool" = "attw" ]; then
    ships_types "$path"
    types_rc=$?
    case "$types_rc" in
      1)
        echo "skip: $name — publishes no type declarations, nothing for attw to check"
        skipped=$((skipped + 1))
        continue
        ;;
      2)
        echo "::error title=Unreadable package.json::$name ($path) — cannot tell whether it publishes type declarations, so it is neither skipped nor silently passed"
        failed=$((failed + 1))
        failures="${failures}  - $name ($path) — unreadable package.json"$'\n'
        continue
        ;;
    esac
  fi

  echo "::group::$tool $name ($path)"
  case "$tool" in
    publint) pnpm --filter "$name" exec publint </dev/null ;;
    attw) pnpm --filter "$name" exec attw --pack . </dev/null ;;
  esac
  rc=$?
  echo "::endgroup::"

  if [ "$rc" -eq 0 ]; then
    echo "ok: $name"
  else
    echo "::error title=$tool failed::$name ($path) — 'pnpm --filter $name exec $tool' exited $rc"
    failed=$((failed + 1))
    failures="${failures}  - $name ($path)"$'\n'
  fi
done <<EOF
$manifest_rows
EOF

# A loop that checks nothing and exits 0 is the failure mode this guards: a
# malformed manifest or a swallowed stdin would otherwise read as success. Both
# operands are integers by construction above, so this cannot error to false.
if [ "$considered" -ne "$expected" ]; then
  echo "::error::manifest lists $expected package(s) but only $considered were considered"
  exit 1
fi

if [ "$failed" -ne 0 ]; then
  echo
  echo "::error::$tool failed for $failed of $((considered - skipped)) checked package(s)"
  printf '%s' "$failures"
  exit 1
fi

echo "check-adopted-publish: $tool clean across $((considered - skipped)) package(s)$([ "$skipped" -gt 0 ] && echo " ($skipped skipped)")."
