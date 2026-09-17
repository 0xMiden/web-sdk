#!/usr/bin/env bash
set -uo pipefail

# Assert that every published package actually SHIPS its agent documentation.
#
# WHY THIS EXISTS
# ---------------
# npm gives `README`, `LICENSE`, `package.json` and the `main` entry a special
# privilege: they are packed whatever `files` says. `AGENTS.md` and `skills/`
# have no such privilege. A package can therefore carry a perfectly good
# AGENTS.md in the working tree, show it in every file listing, pass review, and
# publish a tarball that does not contain it - and nothing anywhere reports a
# problem, because no build step failed and no entry point is dead.
#
# That is not hypothetical. Before the change that added this script, all three
# `packages/para/*` packages had shipped an AGENTS.md on disk for two releases
# while `files` omitted it, so no consumer ever received one. The file existed,
# so every human check said "done"; the artifact did not, so every agent reading
# it out of node_modules got nothing.
#
# The whole premise of shipping these docs inside the tarball is that they are
# version-matched to the code a consumer installed. A guide that silently fails
# to ship is worse than no guide, because the package looks documented.
#
# WHAT IT CHECKS, AND AGAINST WHAT
# --------------------------------
# The published file list comes from `npm pack --dry-run --json`, run in the
# package directory: exactly the list `npm publish` would upload, after `files`,
# `.npmignore` and npm's built-in excludes have had their say. Checking the
# working tree instead would be strictly weaker and would have passed the para
# bug clean.
#
#   --dry-run         writes no tarball, touches no registry.
#   --ignore-scripts  skips `prepack`. No package generates its AGENTS.md or its
#                     skills in prepack - they are checked-in source - so this
#                     costs nothing and saves a full build per package.
#
# Two assertions per package:
#   1. AGENTS.md is in the tarball.
#   2. Every skills/**/SKILL.md that exists on disk is in the tarball. This is
#      the half that catches `files: ["dist", "AGENTS.md"]` - a package that
#      remembered the index and forgot the skills it points at, which yields an
#      AGENTS.md whose every "read skills/x/SKILL.md" line is a dead reference.
#
# WHICH PACKAGES
# --------------
# Derived, never hand-listed: every package.json in the tree that declares a
# name and does not set `"private": true`. A hand-kept list is a second thing to
# keep in sync and only ever covers the packages someone remembered to add -
# which is the same failure mode this script exists to catch, one level up. The
# corollary is that `"private": true` is load-bearing: it is how a package that
# is built but never published opts out, and a published package cannot opt out
# at all. That is deliberate.
#
# The three `packages/node-sdk-*` native shells are IN scope. They contain one
# .node binary and no JavaScript API, and their guide says exactly that - which
# is the useful thing to tell an agent that has landed in one of them.
#
# FAILING CLOSED
# --------------
# Every jq and every npm invocation has its exit status checked, and a package
# that cannot be read or packed is an error, never a skip. A gate that reports
# "0 packages checked, all good" is the same class of bug as the one it is
# meant to catch. The final count is asserted to be non-zero for that reason.
#
# Usage:  check-agent-docs.sh [package-dir ...]
#         With no arguments, discovers every published package in the repo.
# Exit:   0 when every published package ships its agent docs, 1 otherwise.

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || {
  echo "::error::cannot resolve the repository root"
  exit 1
}

fail=0
checked=0

note_failure() {
  fail=1
}

# ── Discover published packages ──────────────────────────────────────────────
#
# -prune on the excluded directories rather than filtering after the fact: the
# tree contains a node_modules per workspace member, and descending into all of
# them takes long enough to matter in CI.
discover() {
  find "$repo_root" \
    \( -name node_modules -o -name dist -o -name target -o -name .git \) -prune -o \
    -name package.json -print 2>/dev/null |
    while IFS= read -r manifest; do
      dir=$(dirname "$manifest")
      # A subpath stub (crates/web-client/lazy/package.json and friends)
      # declares no name; it is a resolver artifact, not a package.
      if ! jq -e '(.name | type == "string" and length > 0)
                  and ((.private // false) != true)' "$manifest" >/dev/null 2>&1; then
        continue
      fi
      printf '%s\n' "$dir"
    done | sort
}

if [ $# -gt 0 ]; then
  packages=$(printf '%s\n' "$@")
else
  packages=$(discover)
fi

if [ -z "$packages" ]; then
  echo "::error title=No packages discovered::check-agent-docs.sh found no published packages; the discovery step is broken, not the repo"
  exit 1
fi

# ── Check each package ───────────────────────────────────────────────────────

while IFS= read -r dir; do
  [ -n "$dir" ] || continue

  name=$(jq -r '.name' "$dir/package.json" 2>/dev/null)
  if [ -z "$name" ] || [ "$name" = "null" ]; then
    echo "::error title=Unreadable package.json::$dir - cannot read a name out of package.json"
    note_failure
    continue
  fi

  rel=${dir#"$repo_root"/}

  pack_err=$(mktemp) || {
    echo "::error::$name - could not create a temp file for the npm pack log"
    exit 1
  }

  pack_json=$(cd "$dir" && npm pack --dry-run --json --ignore-scripts 2>"$pack_err")
  pack_rc=$?
  if [ "$pack_rc" -ne 0 ]; then
    echo "::error title=Cannot pack::$name - 'npm pack --dry-run' in $rel exited $pack_rc, so the published file list is unknown"
    sed 's/^/    npm: /' "$pack_err"
    rm -f "$pack_err"
    note_failure
    continue
  fi
  rm -f "$pack_err"

  if ! packed=$(printf '%s' "$pack_json" | jq -r '.[0].files[].path' 2>&1); then
    echo "::error title=Cannot pack::$name - 'npm pack --json' output has no .[0].files[].path (npm CLI change?): $(printf '%s' "$packed" | tr '\n' ' ')"
    note_failure
    continue
  fi
  if [ -z "$packed" ]; then
    echo "::error title=Empty tarball::$name - 'npm pack --dry-run' lists no files at all in $rel"
    note_failure
    continue
  fi

  checked=$((checked + 1))

  # 1. AGENTS.md reaches the tarball.
  if ! printf '%s\n' "$packed" | grep -qx 'AGENTS.md'; then
    if [ -f "$dir/AGENTS.md" ]; then
      echo "::error title=Agent guide not published::$name - $rel/AGENTS.md exists on disk but is NOT in the tarball. Add \"AGENTS.md\" to the \"files\" array in $rel/package.json; npm does not pack it automatically the way it packs README."
    else
      echo "::error title=Agent guide missing::$name - no $rel/AGENTS.md. Every published package ships one; see the 'Agent-facing docs' section of the root AGENTS.md."
    fi
    note_failure
  fi

  # 2. Every skill on disk reaches the tarball.
  if [ -d "$dir/skills" ]; then
    while IFS= read -r skill; do
      [ -n "$skill" ] || continue
      want=${skill#"$dir"/}
      if ! printf '%s\n' "$packed" | grep -qx -- "$want"; then
        echo "::error title=Skill not published::$name - $rel/$want exists on disk but is NOT in the tarball. Add \"skills\" to the \"files\" array in $rel/package.json, or AGENTS.md will point at guides the consumer never receives."
        note_failure
      fi
    done < <(find "$dir/skills" -name SKILL.md -print 2>/dev/null | sort)
  fi
done <<EOF
$packages
EOF

if [ "$checked" -eq 0 ]; then
  echo "::error title=Nothing verified::check-agent-docs.sh packed no package successfully; treating that as a failure rather than a pass"
  exit 1
fi

# ── The marker block must be identical in every README that carries it ───────
#
# Each README embeds the snippet a consumer pastes into their own project's root
# AGENTS.md, delimited by BEGIN/END markers. Nothing else keeps those copies in
# agreement, and they are identical today only by hand. Three copies survive on
# care; the moment a fourth package grows one, a consumer's pasted rules depend
# on which package's README they happened to open. The markers are already
# machine-readable, so comparing them costs nothing.
#
# Run only on a full discovery pass: with explicit package arguments the caller
# is checking one package, and failing them over an unrelated README is noise.
if [ $# -eq 0 ]; then
  marker_hashes=""
  marker_files=""
  while IFS= read -r readme; do
    [ -n "$readme" ] || continue
    block=$(awk '/BEGIN:miden-agent-rules/,/END:miden-agent-rules/' "$readme")
    if [ -z "$block" ]; then
      continue
    fi
    marker_files="$marker_files ${readme#"$repo_root"/}"
    marker_hashes="$marker_hashes$(printf '%s' "$block" | shasum | cut -d' ' -f1)
"
  done < <(grep -rl 'BEGIN:miden-agent-rules' --include='*.md' "$repo_root" 2>/dev/null |
    grep -v node_modules | sort)

  distinct=$(printf '%s' "$marker_hashes" | grep -c . || true)
  unique=$(printf '%s' "$marker_hashes" | sort -u | grep -c . || true)

  if [ "${distinct:-0}" -eq 0 ]; then
    echo "::error title=Marker block missing::no README carries a BEGIN:miden-agent-rules block; the snippet consumers paste into their own AGENTS.md has gone missing"
    fail=1
  elif [ "${unique:-0}" -ne 1 ]; then
    echo "::error title=Marker block drift::the BEGIN:miden-agent-rules block differs between READMEs ($unique distinct versions across$marker_files). Consumers paste whichever one they happen to open, so all copies must be byte-identical."
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "check-agent-docs: FAILED ($checked package(s) checked)"
  exit 1
fi

echo "check-agent-docs: ok - $checked published package(s) ship AGENTS.md and every skill they carry"
