#!/usr/bin/env bash
# Local-dev mirror of .github/actions/inject-linked-client-pr.
#
# Appends a [patch] block to Cargo.toml that retargets miden-client (and
# miden-client-proto and miden-client-sqlite-store) at a linked rust-sdk PR's head,
# wrapped in begin/end markers so it can be removed cleanly with --clear.
# A pre-commit hook (lefthook.yml) blocks committing while the marked
# block is present, so you can't accidentally ship the patch.
#
# Usage:
#   scripts/dev-with-client-pr.sh                # auto-detect: read 'Client PR: #N' from current branch's PR body
#   scripts/dev-with-client-pr.sh 1234           # use rust-sdk#1234
#   scripts/dev-with-client-pr.sh 0xMiden/rust-sdk#1234       # explicit cross-repo form
#   scripts/dev-with-client-pr.sh --clear        # remove the patch block + restore Cargo.lock
#
# Requirements: gh (for PR lookup), cargo, awk.

set -euo pipefail

CARGO_TOML="$(git rev-parse --show-toplevel)/Cargo.toml"
BACKUP_DIR="$(git rev-parse --git-path linked-client-pr-original)"
MARK_BEGIN="# >>>>>>> linked-client-pr (auto-injected by scripts/dev-with-client-pr.sh) >>>>>>>"
MARK_END="# <<<<<<< linked-client-pr <<<<<<<"
# A dependency's own [patch] tables do not apply to this workspace. The second
# marker copies them from the linked Cargo.toml; lefthook matches the same
# ">>>>>>> linked-client-pr" token, and --clear deletes the range.
PATCH_BEGIN="# >>>>>>> linked-client-pr patches (auto-injected by scripts/dev-with-client-pr.sh) >>>>>>>"
PATCH_END="# <<<<<<< linked-client-pr patches <<<<<<<"

# We CAN'T use [patch."<url>"] when the patched dep URL matches the
# original dep URL — Cargo errors with `patches must point to different
# sources`. Instead we rewrite the dep line in place and stash the
# original in a marker block so --clear can restore it byte-for-byte.

# Fingerprint of Cargo.toml and Cargo.lock, recorded when an apply finishes so
# a later clear can tell whether either file was edited since.
state_hash() {
  local f
  for f in "$CARGO_TOML" "${CARGO_TOML%.toml}.lock"; do
    if [ ! -f "$f" ]; then
      echo absent
    elif command -v shasum >/dev/null 2>&1; then
      shasum -a 256 <"$f"
    else
      sha256sum <"$f"
    fi
  done
}

# Set when the lock may still hold the linked resolution, so the caller runs
# the targeted cargo update.
LOCK_REFRESH=false

clear_block() {
  if [ -f "$BACKUP_DIR/Cargo.toml" ]; then
    if [ ! -f "$BACKUP_DIR/applied.sha" ] || [ "$(state_hash)" = "$(cat "$BACKUP_DIR/applied.sha")" ]; then
      cp "$BACKUP_DIR/Cargo.toml" "$CARGO_TOML"
      if [ -f "$BACKUP_DIR/Cargo.lock" ]; then
        cp "$BACKUP_DIR/Cargo.lock" "${CARGO_TOML%.toml}.lock"
      else
        rm -f "${CARGO_TOML%.toml}.lock"
      fi
      rm -rf "$BACKUP_DIR"
      return 0
    fi
    # Restoring the snapshot would discard the edit; strip only what the apply added.
    echo "⚠ Cargo.toml or Cargo.lock was edited while the linked patch was applied; keeping the edits and removing only the patch." >&2
    rm -rf "$BACKUP_DIR"
    LOCK_REFRESH=true
  fi
  if ! grep -qF "$MARK_BEGIN" "$CARGO_TOML" && ! grep -qF "$PATCH_BEGIN" "$CARGO_TOML"; then
    return 0
  fi
  LOCK_REFRESH=true
  # Restore originals: extract everything between the markers (lines
  # starting with "#  " carry the original dep line — strip the prefix),
  # then drop both the marker block and any auto-injected dep lines that
  # follow it. The format the apply step writes is:
  #   $MARK_BEGIN
  #   # Original lines (do not edit):
  #   #  miden-client = ...
  #   #  miden-client-sqlite-store = ...
  #   $MARK_END
  #   miden-client = { rev = "<linked head sha>", ... }     <-- patched
  #   miden-client-sqlite-store = { rev = "<linked head sha>", ... }  <-- patched (if present)
  #
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" -v pb="$PATCH_BEGIN" -v pe="$PATCH_END" '
    function restore() {
      for (i=1; i<=n_orig; i++) print orig[i]
      # Skip the same number of patched lines that immediately follow.
      to_skip = n_orig
    }
    BEGIN { state="scan"; n_orig=0; to_skip=0; skip_patch=0 }
    $0 == pb { skip_patch=1; next }
    skip_patch && $0 == pe { skip_patch=0; next }
    skip_patch { next }
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
  # Prerelease holds are appended to [patch.crates-io] as path entries into a
  # temp directory; an emptied table header goes with them.
  python3 - "$CARGO_TOML" <<'PY'
import re, sys
from pathlib import Path

path = Path(sys.argv[1])
with open(path, newline="") as f:
    lines = f.read().splitlines(keepends=True)
hold = re.compile(r'^[A-Za-z0-9_-]+\s*=\s*\{\s*path\s*=\s*"[^"]*/[^"/]+-\d+\.\d+\.\d+[^"/]*"\s*\}\s*$')
out = []
in_patch = False
for line in lines:
    stripped = line.strip()
    if stripped.startswith("["):
        in_patch = stripped == "[patch.crates-io]"
    elif in_patch and hold.match(stripped):
        continue
    out.append(line)
text = "".join(out)
text = re.sub(r'(?:\r?\n)*\[patch\.crates-io\]\r?\n(?=\s*(?:\[|\Z))', "\n", text)
with open(path, "w", newline="") as f:
    f.write(text)
PY
}

# cargo update with -p needs the package to actually be in the dep tree.
# main pins only `miden-client` (crates.io); next pins `miden-client` and
# `miden-client-sqlite-store` (git+branch). Build the `-p` list dynamically
# so the same script works on both branches.
build_cargo_update_args() {
  local args=""
  if cargo metadata --format-version=1 --no-deps 2>/dev/null \
      | grep -qE '"name":"(miden-client|miden-client-web|miden-idxdb-store)"'; then
    # Only add optional members if they are resolvable in this workspace.
    args="-p miden-client"
    for member in miden-client-proto miden-client-sqlite-store; do
      if cargo pkgid -p "$member" >/dev/null 2>&1; then
        args="$args -p $member"
      fi
    done
  fi
  printf '%s' "$args"
}

if [ "${1:-}" = "--clear" ] || [ "${1:-}" = "-c" ]; then
  clear_block
  if [ "$LOCK_REFRESH" = true ]; then
    # Legacy blocks and edited trees have no exact snapshot to restore.
    # shellcheck disable=SC2086
    cargo update $(build_cargo_update_args) --quiet 2>/dev/null || true
  fi
  echo "✓ Linked-client-pr block removed from Cargo.toml."
  exit 0
fi

# Determine the linked PR.
arg="${1:-}"
if [ -z "$arg" ]; then
  body=$(gh pr view --json body -q .body 2>/dev/null || true)
  marker=$(printf '%s' "$body" | grep -ioE '^[[:space:]]*Client PR:[[:space:]]*([0-9a-zA-Z._-]+/[0-9a-zA-Z._-]+)?#[0-9]+' | head -1 || true)
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
  repo="0xMiden/rust-sdk"
  num="$arg"
else
  repo=$(printf '%s' "$arg" | grep -oE '[0-9a-zA-Z._-]+/[0-9a-zA-Z._-]+' | head -1 || true)
  num=$(printf '%s' "$arg" | grep -oE '[0-9]+$')
  [ -z "$repo" ] && repo="0xMiden/rust-sdk"
  [ -z "$num" ] && { echo "Could not parse '$arg' — expected '#N' or 'owner/repo#N'."; exit 1; }
fi

# Resolve head + state via gh.
read -r head_owner head_repo head_ref head_sha state merged <<<"$(gh api repos/"$repo"/pulls/"$num" \
  --jq '"\(.head.repo.owner.login) \(.head.repo.name) \(.head.ref) \(.head.sha) \(.state) \(.merged)"')"

# gh's REST API returns lowercase ("open"/"closed"); GraphQL uses
# uppercase. Normalize before comparing.
state_lc=$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')
if [ "$state_lc" != "open" ] && [ "$merged" != "true" ]; then
  echo "⚠ ${repo}#${num} is ${state} (merged=${merged}). Pinning by SHA — git resolves the head sha regardless of branch state."
fi

# Idempotent: clear any prior block first.
clear_block
if [ "$LOCK_REFRESH" = true ]; then
  # The snapshot below must not hold the earlier linked resolution.
  # shellcheck disable=SC2086
  cargo update $(build_cargo_update_args) --quiet 2>/dev/null || true
fi
mkdir -p "$BACKUP_DIR"
cp "$CARGO_TOML" "$BACKUP_DIR/Cargo.toml"
if [ -f "${CARGO_TOML%.toml}.lock" ]; then
  cp "${CARGO_TOML%.toml}.lock" "$BACKUP_DIR/Cargo.lock"
fi
# Every stop point, failed or not, records the state it left for --clear to compare.
trap 'state_hash >"$BACKUP_DIR/applied.sha"' EXIT

url="https://github.com/${head_owner}/${head_repo}.git"

# Sanity-check there's a miden-client dep line at all. The Python block
# below does the actual capture + rewrite; we exit early here only if
# the file is structurally not what we expect.
if ! grep -qE '^miden-client(-(proto|sqlite-store))?[^a-z-]' "$CARGO_TOML"; then
  echo "Could not find a miden-client dep line in $CARGO_TOML." >&2
  exit 1
fi
python3 <<PY
import re, sys
path = "$CARGO_TOML"
url = "$url"
ref = "$head_ref"
sha = "$head_sha"
mark_begin = """$MARK_BEGIN"""
mark_end = """$MARK_END"""

with open(path) as f:
    lines = f.readlines()

dep_re = re.compile(r'^(?P<name>miden-client(?:-proto|-sqlite-store)?)\s*=\s*(?P<rhs>.+)$')
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
    # Pin by SHA, not branch. Linked-repo branches are auto-deleted on
    # merge, so a branch-pin breaks the moment the upstream PR merges
    # (cargo errors with "failed to find branch X"). Commit objects
    # are reachable in git history regardless of refs, so rev-pin
    # survives branch deletion.
    df = ', default-features = false' if 'default-features = false' in rhs else ''
    new_rhs = '{ rev = "' + sha + '"' + df + ', git = "' + url + '" }'
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

# The linked workspace patches sources this repo never declares (today,
# miden-node-proto-build's protocol git branch). Cargo ignores a dependency's
# [patch] table, so copy those tables into a marker --clear removes.
upstream_toml=$(mktemp)
upstream_lock=$(mktemp)
gh api -H "Accept: application/vnd.github.raw" \
  "repos/${head_owner}/${head_repo}/contents/Cargo.toml?ref=${head_sha}" > "$upstream_toml"
gh api -H "Accept: application/vnd.github.raw" \
  "repos/${head_owner}/${head_repo}/contents/Cargo.lock?ref=${head_sha}" > "$upstream_lock"
python3 - "$CARGO_TOML" "$upstream_toml" "$PATCH_BEGIN" "$PATCH_END" "$upstream_lock" <<'PY'
import re, sys

cargo_path, upstream_path, mark_begin, mark_end = sys.argv[1:5]
lock_path = sys.argv[5]

def patch_tables(text):
    lines = text.splitlines()
    blocks = []
    i = 0
    while i < len(lines):
        if lines[i].strip().startswith("[patch"):
            start = i
            j = i - 1
            while j >= 0 and lines[j].strip().startswith("#"):
                start = j
                j -= 1
            i += 1
            while i < len(lines):
                stripped = lines[i].strip()
                if stripped.startswith("[") and not stripped.startswith("[patch"):
                    break
                i += 1
            blocks.append("\n".join(lines[start:i]).rstrip())
            continue
        i += 1
    return "\n\n".join(blocks)

with open(upstream_path) as f:
    patches = patch_tables(f.read())
if not patches:
    sys.exit(0)

with open(lock_path) as f:
    lock = f.read()
revisions = {}
for block in re.findall(r'^\[\[package\]\]\n(.*?)(?=^\[\[|\Z)', lock, re.M | re.S):
    fields = dict(re.findall(r'^(name|source)\s*=\s*"([^"]+)"', block, re.M))
    source = fields.get('source', '')
    if source.startswith('git+') and '#' in source:
        url, revision = source[4:].rsplit('#', 1)
        key = (fields.get('name'), url.split('?')[0].removesuffix('.git'))
        revisions.setdefault(key, set()).add(revision)
lines = []
for line in patches.splitlines():
    entry = re.match(r'^(\s*([A-Za-z0-9_-]+)\s*=\s*\{)(.*)(\}\s*(?:#.*)?)$', line)
    git = re.search(r'\bgit\s*=\s*"([^"]+)"', entry[3]) if entry else None
    if git:
        package = re.search(r'\bpackage\s*=\s*"([^"]+)"', entry[3])
        name = package[1] if package else entry[2]
        captured = revisions.get((name, git[1].removesuffix('.git')), set())
        if len(captured) > 1:
            raise SystemExit(f'Ambiguous linked lock revision for {name}')
        if captured:
            fields = re.sub(r'\b(?:branch|tag|rev)\s*=\s*"[^"]*"\s*,?\s*', '', entry[3]).strip().rstrip(',').rstrip()
            line = entry[1] + ' ' + fields + f', rev = "{next(iter(captured))}" ' + entry[4]
    lines.append(line)
patches = '\n'.join(lines)

with open(cargo_path) as f:
    current = f.read()
if not current.endswith("\n"):
    current += "\n"
current += (
    "\n"
    + mark_begin
    + "\n"
    + "# Copied from the linked workspace Cargo.toml. A dependency's [patch]\n"
    + "# does not apply in this workspace. Removed by --clear; never commit.\n"
    + patches
    + "\n"
    + mark_end
    + "\n"
)
with open(cargo_path, "w") as f:
    f.write(current)
PY
rm -f "$upstream_toml" "$upstream_lock"

# shellcheck disable=SC2086
bash "$(git rev-parse --show-toplevel)/scripts/cargo-update-linked-patches.sh" $(build_cargo_update_args)

echo "✓ Cargo.toml dep rewritten: miden-client → ${head_owner}/${head_repo}@${head_ref} (${head_sha:0:8})"
echo "  Originals stashed in a marker block; restore with: $0 --clear"
echo "  (lefthook's pre-commit hook will block the commit while the marker block is present.)"
