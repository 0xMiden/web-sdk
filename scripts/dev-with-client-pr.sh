#!/usr/bin/env bash
# Local-dev mirror of .github/actions/inject-linked-client-pr.
#
# Appends a [patch] block to Cargo.toml that retargets miden-client (and
# miden-client-sqlite-store) at a linked miden-client PR's head branch,
# wrapped in begin/end markers so it can be removed cleanly with --clear.
# A pre-commit hook (lefthook.yml) blocks committing while the marked
# block is present, so you can't accidentally ship the patch.
#
# Usage:
#   scripts/dev-with-client-pr.sh                # auto-detect: read 'Client PR: #N' from current branch's PR body
#   scripts/dev-with-client-pr.sh 1234           # use miden-client#1234
#   scripts/dev-with-client-pr.sh 0xMiden/miden-client#1234   # explicit cross-repo form
#   scripts/dev-with-client-pr.sh --clear        # remove the patch block + restore Cargo.lock
#
# Requirements: gh (for PR lookup), cargo, awk.

set -euo pipefail

CARGO_TOML="$(git rev-parse --show-toplevel)/Cargo.toml"
MARK_BEGIN="# >>>>>>> linked-client-pr (auto-injected by scripts/dev-with-client-pr.sh) >>>>>>>"
MARK_END="# <<<<<<< linked-client-pr <<<<<<<"

# We CAN'T use [patch."<url>"] when the patched dep URL matches the
# original dep URL — Cargo errors with `patches must point to different
# sources`. Instead we rewrite the dep line in place and stash the
# original in a marker block so --clear can restore it byte-for-byte.

clear_block() {
  if ! grep -qF "$MARK_BEGIN" "$CARGO_TOML"; then
    return 0
  fi
  # Restore originals: extract everything between the markers (lines
  # starting with "#  " carry the original dep line — strip the prefix),
  # then drop both the marker block and any auto-injected dep lines that
  # follow it. The format the apply step writes is:
  #   $MARK_BEGIN
  #   # Original lines (do not edit):
  #   #  miden-client = ...
  #   #  miden-client-sqlite-store = ...
  #   $MARK_END
  #   miden-client = { branch = "<linked>", ... }     <-- patched
  #   miden-client-sqlite-store = { branch = "<linked>", ... }  <-- patched (if present)
  #
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    function restore() {
      for (i=1; i<=n_orig; i++) print orig[i]
      # Skip the same number of patched lines that immediately follow.
      to_skip = n_orig
    }
    BEGIN { state="scan"; n_orig=0; to_skip=0 }
    state == "scan" && $0 == b { state="capturing"; next }
    state == "capturing" && $0 == e {
      state="post"
      restore()
      next
    }
    state == "capturing" {
      # Lines look like "#  miden-client = ..." — strip the "# " prefix
      # to recover the original line. Comment-only lines (starting with
      # "# " followed by something that is not a TOML key=value) are
      # discarded.
      if (match($0, /^#  /)) {
        orig[++n_orig] = substr($0, 4)
      }
      next
    }
    state == "post" && to_skip > 0 { to_skip--; next }
    { print }
  ' "$CARGO_TOML" > "$CARGO_TOML.tmp"
  mv "$CARGO_TOML.tmp" "$CARGO_TOML"
}

# cargo update with -p needs the package to actually be in the dep tree.
# main pins only `miden-client` (crates.io); next pins `miden-client` and
# `miden-client-sqlite-store` (git+branch). Build the `-p` list dynamically
# so the same script works on both branches.
build_cargo_update_args() {
  local args=""
  if cargo metadata --format-version=1 --no-deps 2>/dev/null \
      | grep -qE '"name":"(miden-client|miden-client-web|miden-idxdb-store)"'; then
    # Always try miden-client; only add sqlite-store if it's resolvable.
    args="-p miden-client"
    if cargo pkgid -p miden-client-sqlite-store >/dev/null 2>&1; then
      args="$args -p miden-client-sqlite-store"
    fi
  fi
  printf '%s' "$args"
}

if [ "${1:-}" = "--clear" ] || [ "${1:-}" = "-c" ]; then
  clear_block
  # shellcheck disable=SC2086
  cargo update $(build_cargo_update_args) --quiet 2>/dev/null || true
  echo "✓ Linked-client-pr block removed from Cargo.toml."
  exit 0
fi

# Determine the linked PR.
arg="${1:-}"
if [ -z "$arg" ]; then
  body=$(gh pr view --json body -q .body 2>/dev/null || true)
  marker=$(printf '%s' "$body" | grep -ioE 'Client PR:\s*([0-9a-zA-Z._-]+/[0-9a-zA-Z._-]+)?#[0-9]+' | head -1 || true)
  if [ -z "$marker" ]; then
    echo "Usage: $0 [<pr-num> | <owner/repo>#<pr-num> | --clear]"
    echo
    echo "No 'Client PR: #N' marker found in the current branch's PR body."
    echo "Add one to the PR description, or pass an arg: $0 1234"
    exit 1
  fi
  arg="$marker"
fi

# Parse arg into repo + num.
if printf '%s' "$arg" | grep -qE '^[0-9]+$'; then
  repo="0xMiden/miden-client"
  num="$arg"
else
  repo=$(printf '%s' "$arg" | grep -oE '[0-9a-zA-Z._-]+/[0-9a-zA-Z._-]+' | head -1 || true)
  num=$(printf '%s' "$arg" | grep -oE '[0-9]+$')
  [ -z "$repo" ] && repo="0xMiden/miden-client"
  [ -z "$num" ] && { echo "Could not parse '$arg' — expected '#N' or 'owner/repo#N'."; exit 1; }
fi

# Resolve head + state via gh.
read -r head_owner head_repo head_ref head_sha state merged <<<"$(gh api repos/"$repo"/pulls/"$num" \
  --jq '"\(.head.repo.owner.login) \(.head.repo.name) \(.head.ref) \(.head.sha) \(.state) \(.merged)"')"

if [ "$state" != "OPEN" ] && [ "$merged" != "true" ]; then
  echo "⚠ ${repo}#${num} is ${state} (merged=${merged}). The branch may be gone."
  echo "  Continuing anyway — git resolves the head sha if it still exists."
fi

# Idempotent: clear any prior block first.
clear_block

url="https://github.com/${head_owner}/${head_repo}.git"

# Sanity-check there's a miden-client dep line at all. The Python block
# below does the actual capture + rewrite; we exit early here only if
# the file is structurally not what we expect.
if ! grep -qE '^miden-client(-sqlite-store)?[^a-z-]' "$CARGO_TOML"; then
  echo "Could not find a miden-client dep line in $CARGO_TOML." >&2
  exit 1
fi
python3 <<PY
import re, sys
path = "$CARGO_TOML"
url = "$url"
ref = "$head_ref"
mark_begin = """$MARK_BEGIN"""
mark_end = """$MARK_END"""

with open(path) as f:
    lines = f.readlines()

dep_re = re.compile(r'^(?P<name>miden-client(?:-sqlite-store)?)\s*=\s*(?P<rhs>.+)$')
captured = []
patched = []
out = []
for ln in lines:
    m = dep_re.match(ln)
    if not m:
        out.append(ln)
        continue
    name = m.group('name')
    rhs = m.group('rhs').rstrip('\n')
    captured.append(ln.rstrip('\n'))
    # Build a git+branch table that matches the workspace dep style.
    # Keep default-features = false if it was on the original.
    df = ', default-features = false' if 'default-features = false' in rhs else ''
    new_rhs = '{ branch = "' + ref + '"' + df + ', git = "' + url + '" }'
    patched.append(f"{name:<25} = {new_rhs}")

# Inject marker block + patched lines BELOW the first captured-line position.
# Strategy: emit OUT lines until we hit the position where the first dep
# line lived, then drop in the marker + originals (commented) + patched.
out2 = []
inserted = False
for ln in lines:
    if not inserted and dep_re.match(ln):
        out2.append(mark_begin + "\n")
        out2.append("# Source: ${repo}#${num} (head: ${head_owner}/${head_repo}@${head_ref}, ${head_sha:0:8}).\n")
        out2.append("# Original lines (do not edit):\n")
        for c in captured:
            out2.append("#  " + c + "\n")
        out2.append(mark_end + "\n")
        for p in patched:
            out2.append(p + "\n")
        inserted = True
        # Skip ALL captured dep lines on the way through.
        continue
    if dep_re.match(ln):
        # Skip subsequent captured lines (already replaced above).
        continue
    out2.append(ln)

with open(path, 'w') as f:
    f.writelines(out2)
PY

# shellcheck disable=SC2086
cargo update $(build_cargo_update_args) --quiet

echo "✓ Cargo.toml dep rewritten: miden-client → ${head_owner}/${head_repo}@${head_ref} (${head_sha:0:8})"
echo "  Originals stashed in a marker block; restore with: $0 --clear"
echo "  (lefthook's pre-commit hook will block the commit while the marker block is present.)"
