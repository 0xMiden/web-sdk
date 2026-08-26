#!/usr/bin/env bash
#
# Tests for extract-bench-artifact.sh.
#
# The extraction step is the one part of the reporter that touches a
# fork-controlled archive, and it used to live inline in the workflow where
# nothing could test it. The traversal cases below are the ones that defeated the
# previous two attempts at this guard, so they are the reason this file exists:
# the first attempt extracted into $GITHUB_WORKSPACE, the second moved to
# $RUNNER_TEMP and checked the extracted directory afterwards — which cannot see
# a file that landed outside it.
#
# Run with `bash .github/scripts/extract-bench-artifact.test.sh` or
# `make test-bench-scripts`.

set -uo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
subject="$script_dir/extract-bench-artifact.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pass=0
fail=0

check() {
  local label=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    pass=$((pass + 1))
    echo "ok   - $label"
  else
    fail=$((fail + 1))
    echo "NOT OK - $label"
    echo "         expected: $expected"
    echo "         actual:   $actual"
  fi
}

# Builds a zip from `name=content` pairs. Uses python's zipfile rather than the
# `zip` CLI because only zipfile will store an entry name the shell and `zip`
# would both normalize away — which is exactly what an attacker sends.
make_zip() {
  local out=$1
  shift
  python3 - "$out" "$@" <<'PY'
import sys, zipfile
out, *pairs = sys.argv[1:]
with zipfile.ZipFile(out, "w") as z:
    for pair in pairs:
        name, _, content = pair.partition("=")
        z.writestr(name, content)
PY
}

# --- a well-formed artifact -------------------------------------------------

zip1="$work/good.zip"
make_zip "$zip1" 'results.json={"schemaVersion":2}' 'pr.json={"number":7}' 'ctx.json={}'
dest1="$work/d1"
out1=$("$subject" "$zip1" "$dest1")
check "well-formed artifact reports usable" "usable" "$out1"
check "results.json extracted" "yes" "$([ -f "$dest1/results.json" ] && echo yes || echo no)"
check "pr.json extracted" "yes" "$([ -f "$dest1/pr.json" ] && echo yes || echo no)"
check "results.json content intact" '{"schemaVersion":2}' "$(cat "$dest1/results.json")"
# ctx.json is in the archive but is not a member the reporter reads: it rebuilds
# its rendering context from trusted event fields instead.
check "ctx.json is NOT extracted" "no" "$([ -f "$dest1/ctx.json" ] && echo yes || echo no)"

# --- traversal: the case that defeated the previous guard -------------------

# Laid out like a real runner: $RUNNER_TEMP/_github_workflow/event.json is
# GITHUB_EVENT_PATH, and work/_actions holds the staged code for every `uses:`
# the privileged job runs.
runner="$work/runner"
mkdir -p "$runner/work/_temp/_github_workflow" "$runner/work/_actions/some-action"
printf '{"real":"event"}' > "$runner/work/_temp/_github_workflow/event.json"
printf 'REAL ACTION CODE' > "$runner/work/_actions/some-action/index.js"

zip2="$work/evil.zip"
make_zip "$zip2" \
  'results.json={"schemaVersion":2}' \
  'pr.json={"number":7}' \
  'x/../../_github_workflow/event.json={"head_sha":"POISONED"}' \
  'y/../../../_actions/some-action/index.js=PWNED' \
  'a/../../../../../../../../etc/hosts=PWNED'
dest2="$runner/work/_temp/bench-report"
out2=$("$subject" "$zip2" "$dest2")
check "hostile archive still reports usable on its real members" "usable" "$out2"
check "GITHUB_EVENT_PATH untouched" '{"real":"event"}' \
  "$(cat "$runner/work/_temp/_github_workflow/event.json")"
check "staged action code untouched" 'REAL ACTION CODE' \
  "$(cat "$runner/work/_actions/some-action/index.js")"
check "nothing landed outside the destination" "" \
  "$(find "$runner" -newer "$zip2" -type f -not -path "$dest2/*" 2>/dev/null)"
# Every extracted name is a bare basename: `-j` discarded the rest, so no entry
# name ever reached a path decision.
check "destination holds only the two members" "pr.json results.json" \
  "$(cd "$dest2" && find . -mindepth 1 | sed 's|^\./||' | sort | tr '\n' ' ' | sed 's/ $//')"

# A traversing entry must not be able to SUPPLY one of the members either —
# `a/../../results.json` is not the stored name `results.json`.
zip3="$work/spoof.zip"
make_zip "$zip3" \
  'a/../../results.json={"spoofed":true}' \
  'pr.json={"number":7}'
dest3="$work/d3"
out3=$("$subject" "$zip3" "$dest3")
check "a traversing entry cannot masquerade as a member" "" "$out3"
check "no spoofed results.json" "no" \
  "$([ -f "$dest3/results.json" ] && echo yes || echo no)"

# --- partial and absent artifacts ------------------------------------------

# bench.yml uploads unconditionally, so a job that died before running the
# benchmark still produces an artifact carrying only pr.json.
zip4="$work/partial.zip"
make_zip "$zip4" 'pr.json={"number":7}'
dest4="$work/d4"
out4=$("$subject" "$zip4" "$dest4")
rc4=$?
check "a partial artifact reports nothing usable" "" "$out4"
check "a partial artifact still exits 0" "0" "$rc4"

# --- the size cap ----------------------------------------------------------

zip5="$work/big.zip"
python3 - "$work/big.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    # Compresses to a few hundred bytes and inflates well past the cap.
    z.writestr("results.json", "0" * 5_000_000)
    z.writestr("pr.json", '{"number":7}')
PY
dest5="$work/d5"
out5=$("$subject" "$zip5" "$dest5" 4194304 2>"$work/e5")
check "an oversized member is dropped, not rendered" "" "$out5"
check "the size refusal is announced" "yes" \
  "$(grep -q "refusing to render" "$work/e5" && echo yes || echo no)"
check "the oversized file is removed" "no" \
  "$([ -f "$dest5/results.json" ] && echo yes || echo no)"
check "a member under the cap survives" "yes" \
  "$([ -f "$dest5/pr.json" ] && echo yes || echo no)"

# --- usage -----------------------------------------------------------------

"$subject" >/dev/null 2>&1
check "no arguments is a usage error" "2" "$?"
"$subject" "$work/nope.zip" "$work/d6" >/dev/null 2>&1
check "a missing archive fails loudly" "1" "$?"

echo
echo "# pass $pass"
echo "# fail $fail"
[ "$fail" -eq 0 ]
