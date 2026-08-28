#!/usr/bin/env bash
set -uo pipefail

# Assert that a package actually SHIPS every file its package.json promises.
#
# WHY THIS EXISTS
# ---------------
# `copyfiles` exits 0 when its source glob matches nothing. packages/adapter/all
# builds with `tsc && pnpm run copy-styles`, and that copy pointed at a path that
# no longer existed — so the package "built" successfully, emitted no
# dist/styles.css, and shipped `"./styles.css": "./dist/styles.css"` in its
# exports map as a dead entry point. No exit-code gate can see that: every
# command in the build returned 0. The same hole exists in
# packages/adapter/reactui's `copy-files` step, and in any future build whose
# last stage is a copy, a rename, or a `|| true`.
#
# So don't trust exit codes — check the contract. package.json already declares
# every file the package promises: `main`, `module`, `browser`, `types`,
# `typings`, `bin`, and every target in `exports`. Each one is a path a
# consumer's resolver will follow after install. If the package does not ship it
# once the build is done, the package is broken regardless of what the build
# printed.
#
# Deliberately derived from package.json, not from an "artifacts" list added to
# scripts/publish-manifest.json: a manifest list would be a *second* list to keep
# in sync, and it would only ever cover the packages someone remembered to
# annotate. Reading the exports map covers every package, including ones added
# later, and it checks the thing consumers actually resolve.
#
# WHAT "SHIPS" MEANS: THE TARBALL, NOT THE WORKING TREE
# -----------------------------------------------------
# An earlier version of this script stat()ed the checkout, which is a strictly
# weaker guarantee than the one the paragraph above claims. A file can sit on
# disk and still never reach a consumer, because `files`, `.npmignore` and npm's
# own default excludes decide what goes into the tarball — so a target that the
# build emitted but the package excludes would have passed clean here and still
# thrown `ERR_MODULE_NOT_FOUND` after `npm i`. A dead export and an excluded
# export fail identically at import time, so both belong in this gate.
#
# The file list therefore comes from `npm pack --dry-run --json`, run in the
# package directory: exactly the list `npm publish` would upload.
#   --dry-run         writes no tarball, touches no registry.
#   --ignore-scripts  skips `prepack`. Every adopted package's prepack is just
#                     its own build again (`pnpm build`, `rm -rf dist && ...`);
#                     the caller has already run that build, and re-running it
#                     here would cost minutes and, for the `rm -rf dist` ones,
#                     rebuild the very dist we came to inspect. The tradeoff:
#                     a package whose prepack *generates* an entry point its
#                     build does not would be reported missing. None does, and
#                     one that did would be relying on a step the CI build above
#                     never runs — which is its own defect, not a false alarm.
#
# PACKAGES WITH NO `files` FIELD
# ------------------------------
# Four adopted packages — adapter/base, adapter/miden, adapter/react,
# adapter/reactui — declare no `files` array and carry no `.npmignore`. That is
# not "they publish nothing"; it is the opposite. With neither, npm publishes
# everything in the package directory except its built-in excludes
# (node_modules, .git, ...). npm-packlist only reads ignore files *inside* the
# package folder, so this repo's root .gitignore — which lists
# `packages/adapter/**/dist/` — has no effect on packing and dist/ does ship.
# (Verified: `npm pack --dry-run` on packages/adapter/base lists dist/index.js
# and dist/index.d.ts.) The side effect is that those four also ship sources,
# tsconfig and compiled tests; that is bloat, not breakage, and out of scope
# here. What matters for this script: "no files field" is never the reason an
# entry point is missing.
#
# FAILING CLOSED
# --------------
# Every jq below runs into a variable whose exit status is then checked, and
# every count is validated as a non-negative integer before it is compared.
# Both `x=$(jq ...)` and `while read ... < <(jq ...)` DISCARD jq's status: on a
# package.json jq cannot parse, jq printed nothing, the loop ran zero times,
# `checked` stayed 0, and this script reported "declares no entry-point paths to
# verify" and exited 0. A gate that verifies nothing while printing an "ok" line
# is the same class of bug the script exists to catch.
#
# Usage:  check-package-artifacts.sh <package-dir> [display-name]
# Exit:   0 when every declared entry point is in the tarball, 1 otherwise,
#         2 on bad usage.

if [ $# -lt 1 ]; then
  echo "usage: check-package-artifacts.sh <package-dir> [display-name]" >&2
  exit 2
fi

dir="$1"
name="${2:-$1}"

# `[ "$a" -ne "$b" ]` with an empty or non-numeric operand is a bash *error*
# (status 2), and `if` reads any non-zero status as false — so a guard written
# that way silently does not fire. Nothing is compared before passing this.
is_count() {
  case "${1:-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

if [ ! -f "$dir/package.json" ]; then
  echo "::error title=Missing entry point::$name — no package.json at $dir"
  exit 1
fi

# ── Parse package.json (fail closed) ─────────────────────────────────────────

if ! pkg_json=$(jq -e 'if type == "object" then . else
        error("top level is a \(type), not an object")
      end' "$dir/package.json" 2>&1); then
  echo "::error title=Unreadable package.json::$name — cannot parse $dir/package.json: $(printf '%s' "$pkg_json" | tr '\n' ' ')"
  exit 1
fi

# A manifest with no `name` is not a package.json, whatever else it parses as.
# Refusing it here is what keeps a stray JSON file (or a truncated write) from
# being read as "a package that happens to declare no entry points" — which the
# tail of this script would otherwise report as ok.
if ! printf '%s' "$pkg_json" | jq -e '.name | type == "string" and length > 0' >/dev/null 2>&1; then
  echo "::error title=Not a package manifest::$name — $dir/package.json parses as JSON but declares no non-empty \"name\"; refusing to treat it as a package"
  exit 1
fi

# Collect (field-label, target) pairs. `exports` is walked to arbitrary depth
# because its targets can nest under condition objects and fallback arrays;
# `paths(type == "string")` reaches every leaf and only leaves, so condition
# KEYS ("import", "types", ...) never leak in — jq's `paths` walks values.
# Targets are grouped by their resolved path so a file named by both `types`
# ("dist/index.d.ts") and `exports["."].types` ("./dist/index.d.ts") is checked
# once and reported once, listing both fields.
#
# Every member of a fallback array is required, not just the first one Node
# would resolve. That is stricter than the resolver — deliberately, and the same
# call publint makes: no package here uses fallback arrays, and one that grew a
# member pointing at a file the build never emits would be carrying exactly the
# dead path this script exists to find.
read -r -d '' JQ_COLLECT <<'JQ' || true
def pathlabel($p):
  $p | map(if type == "number" then "[\(.)]" else "[\"\(.)\"]" end) | join("");

[
  ( ["main", "module", "browser", "types", "typings"][] as $k
    | select((.[$k] // null) | type == "string")
    | ["pkg.\($k)", .[$k]] ),

  ( select((.bin // null) | type == "string") | ["pkg.bin", .bin] ),
  ( (.bin // null) | select(type == "object") | to_entries[]
    | select(.value | type == "string")
    | ["pkg.bin[\"\(.key)\"]", .value] ),

  ( select((.exports // null) | type == "string") | ["pkg.exports", .exports] ),
  ( (.exports // null) as $e
    | select(($e | type) == "object" or ($e | type) == "array")
    | [$e | paths(type == "string")][] as $p
    | ["pkg.exports\(pathlabel($p))", ($e | getpath($p))] )
]
| group_by(.[1] | ltrimstr("./"))
| map([(map(.[0]) | join(" + ")), .[0][1]])
| .[] | @tsv
JQ

if ! rows=$(printf '%s' "$pkg_json" | jq -r "$JQ_COLLECT" 2>&1); then
  echo "::error title=Unreadable package.json::$name — could not read entry points out of $dir/package.json: $(printf '%s' "$rows" | tr '\n' ' ')"
  exit 1
fi

row_count=0
if [ -n "$rows" ]; then
  row_count=$(printf '%s\n' "$rows" | wc -l | tr -d '[:space:]')
fi
if ! is_count "$row_count"; then
  echo "::error title=Unreadable package.json::$name — could not count the entry points declared in $dir/package.json (got '$row_count')"
  exit 1
fi

# ── The published file list (fail closed) ────────────────────────────────────

pack_err=$(mktemp) || {
  echo "::error::$name — could not create a temp file for the npm pack log"
  exit 1
}
trap 'rm -f "$pack_err"' EXIT

pack_json=$(cd "$dir" && npm pack --dry-run --json --ignore-scripts 2>"$pack_err")
pack_rc=$?
if [ "$pack_rc" -ne 0 ]; then
  echo "::error title=Cannot pack::$name — 'npm pack --dry-run' in $dir exited $pack_rc, so the published file list is unknown and no entry point can be verified"
  sed 's/^/    npm: /' "$pack_err"
  exit 1
fi

if ! packed=$(printf '%s' "$pack_json" | jq -r '.[0].files[].path' 2>&1); then
  echo "::error title=Cannot pack::$name — 'npm pack --json' output has no .[0].files[].path (npm CLI change?): $(printf '%s' "$packed" | tr '\n' ' ')"
  exit 1
fi
if [ -z "$packed" ]; then
  echo "::error title=Empty tarball::$name — 'npm pack --dry-run' lists no files at all in $dir"
  exit 1
fi

# npm reports tarball-relative paths without a leading "./"; package.json
# targets carry one. Normalise once, compare literally (-x -F: whole line,
# no regex — a '.' or '+' in a filename must not match anything else).
packed_norm=$(printf '%s\n' "$packed" | sed 's|^\./||')
in_tarball() {
  printf '%s\n' "$packed_norm" | grep -qxF -- "$1"
}

# ── Verify ───────────────────────────────────────────────────────────────────

checked=0
missing=0
skipped=0
processed=0

while IFS=$'\t' read -r field target; do
  # A herestring always feeds at least one line; that line is empty when the
  # package declares no entry points at all.
  [ -n "$field" ] || continue
  processed=$((processed + 1))

  if [ -z "$target" ]; then
    echo "::error title=Empty entry point::$name declares $field with an empty path"
    missing=$((missing + 1))
    continue
  fi

  case "$target" in
    *'*'*)
      # Subpath patterns ("./dist/*.js") have no single file to assert. Announce
      # the skip rather than dropping it silently — a silent skip is the same
      # class of bug this script exists to catch.
      echo "  skip: $field -> $target (subpath pattern, no single file to assert)"
      skipped=$((skipped + 1))
      continue
      ;;
    */)
      # A trailing slash is a DIRECTORY export ("./styles/": "./dist/styles/").
      # Deprecated in favour of "./styles/*", but still legal and still
      # supported by Node, and it names a folder — so "is a directory, not a
      # file" was a false failure on a correctly populated package. Same
      # treatment as a subpath pattern: nothing single to assert, so announce
      # and move on.
      echo "  skip: $field -> $target (trailing-slash directory export, no single file to assert)"
      skipped=$((skipped + 1))
      continue
      ;;
    /* | [a-z]*://*)
      echo "  skip: $field -> $target (not a relative path)"
      skipped=$((skipped + 1))
      continue
      ;;
  esac

  rel="${target#./}"
  checked=$((checked + 1))
  in_tarball "$rel" && continue

  # Not in the tarball. Say WHICH of the three ways it went wrong, because the
  # fix differs: emit the file, fix the export path, or fix `files`/.npmignore.
  if [ -f "$dir/$rel" ]; then
    why="exists in the working tree but is EXCLUDED from the published tarball — fix the \"files\" field or .npmignore"
  elif [ -d "$dir/$rel" ]; then
    why="is a directory, not a file"
  else
    why="was never produced — the build exited 0 without emitting it"
  fi
  echo "::error title=Missing entry point::$name declares $field = \"$target\" but $rel $why"
  missing=$((missing + 1))
done <<EOF
$rows
EOF

# The loop above reads from a herestring, not from `< <(jq ...)`, precisely so a
# short read cannot end it early and silently. Assert it anyway: this counter is
# the difference between "every declared entry point was examined" and "the loop
# stopped somewhere and every counter still looks plausible".
if [ "$processed" -ne "$row_count" ]; then
  echo "::error::$name — package.json declares $row_count entry-point target(s) but only $processed were examined"
  exit 1
fi

if [ "$missing" -ne 0 ]; then
  echo "::error::$name — $missing of $checked declared entry point(s) missing from the published tarball"
  exit 1
fi

# A package that declares no entry point at all is legitimate (a template-only
# package, say), but say so instead of printing a reassuring "0 checked".
if [ "$checked" -eq 0 ]; then
  echo "ok: $name — declares no entry-point paths to verify ($skipped skipped)"
else
  echo "ok: $name — $checked declared entry point(s) present in the tarball$([ "$skipped" -gt 0 ] && echo ", $skipped skipped")"
fi
