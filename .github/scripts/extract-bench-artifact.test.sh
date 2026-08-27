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
# Every extracted name is a bare basename because this script's own redirect
# chooses every destination path — `unzip -p` writes to stdout and never touches
# the filesystem, so an entry name cannot steer a write, so no entry
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

# --- symlink entries -------------------------------------------------------

# `unzip -j` restores symlinks: an entry named results.json carrying the Unix
# symlink mode bit becomes a link to any absolute path the fork picks, and the
# size check, the `[ -f ]` test and the renderer's readFileSync all follow it.
# The reporter renders results.json into a PUBLIC PR comment, so that is an
# arbitrary-file read with a public sink.
secret="$work/secret.txt"
printf 'SECRET CONTENT' > "$secret"
zips="$work/symlink.zip"
python3 - "$zips" "$secret" <<'PY'
import sys, zipfile
out, target = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w") as z:
    info = zipfile.ZipInfo("results.json")
    info.create_system = 3            # Unix
    info.external_attr = 0o120777 << 16  # S_IFLNK
    z.writestr(info, target)
    z.writestr("pr.json", '{"number":7}')
PY
dests="$work/ds"
"$subject" "$zips" "$dests" >/dev/null 2>&1
check "a symlink entry does not become a symlink" "no" \
  "$([ -L "$dests/results.json" ] && echo yes || echo no)"
check "a symlink entry does not read through to its target" "no" \
  "$(grep -q 'SECRET CONTENT' "$dests/results.json" 2>/dev/null && echo yes || echo no)"
check "the secret file is not modified" "SECRET CONTENT" "$(cat "$secret")"

# Duplicate names would let `-p` concatenate a second payload behind a benign
# first one.
zipd="$work/dup.zip"
make_zip "$zipd" 'results.json={"schemaVersion":2}' 'results.json={"evil":1}' 'pr.json={"number":7}'
destd="$work/dd"
outd=$("$subject" "$zipd" "$destd" 2>/dev/null)
check "duplicate member names are refused" "" "$outd"
check "no concatenated results.json" "no" \
  "$([ -f "$destd/results.json" ] && echo yes || echo no)"

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
    # ~500 KB compressed, 500 MB inflated. A cap checked with `wc -c` after
    # extraction would have written all of it to disk first.
    z.writestr("results.json", "0" * 500_000_000)
    z.writestr("pr.json", '{"number":7}')
PY
dest5="$work/d5"
out5=$("$subject" "$zip5" "$dest5" 4194304 2>"$work/e5")
check "an oversized member is dropped, not rendered" "" "$out5"
check "the size refusal is announced" "yes" \
  "$(grep -q "exceeds the" "$work/e5" && echo yes || echo no)"
check "the oversized file is removed" "no" \
  "$([ -f "$dest5/results.json" ] && echo yes || echo no)"
check "a member under the cap survives" "yes" \
  "$([ -f "$dest5/pr.json" ] && echo yes || echo no)"
# The cap has to bound what is WRITTEN, not just what is kept — and measuring
# that after the run cannot show it, because the script deletes the over-cap file
# itself. Measured here DURING the run, by a poller that records the largest size
# results.json ever reached. Without the `head -c` stream cap this observes a
# multi-hundred-MB peak; with it, the cap plus a byte.
dest5b="$work/d5b"
mkdir -p "$dest5b"
peak_file="$work/peak"
echo 0 > "$peak_file"
(
  peak=0
  # Outlives the subject only briefly: the loop exits as soon as the marker
  # appears, and the `wait` below joins it before the check runs.
  while [ ! -f "$work/extract-done" ]; do
    if [ -f "$dest5b/results.json" ]; then
      size=$(wc -c < "$dest5b/results.json" 2>/dev/null | tr -d '[:space:]')
      [ -n "$size" ] && [ "$size" -gt "$peak" ] && peak=$size
    fi
    echo "$peak" > "$peak_file"
  done
  echo "$peak" > "$peak_file"
) &
poller=$!
"$subject" "$zip5" "$dest5b" 4194304 >/dev/null 2>&1 || true
touch "$work/extract-done"
wait "$poller"
observed_peak=$(cat "$peak_file")
# Both bounds. The upper one is the actual claim; the lower one is what stops the
# claim from being vacuous — if the poller raced and never sampled the file,
# observed_peak is 0, which satisfies any upper bound and reports a pass for a
# measurement that did not happen.
check "the peak-usage poller actually observed the extraction" "yes" \
  "$([ "$observed_peak" -gt 0 ] && echo yes || echo no)"
check "the stream cap bounds bytes written, not just bytes kept" "yes" \
  "$([ "$observed_peak" -le 8388608 ] && echo yes || echo no)"

# --- write failures and unreadable archives --------------------------------

# `head` owns the only write, so its exit status decides whether what landed on
# disk is the whole member. A prefix of a large JSON document can still parse as
# valid JSON — fewer benchmarks, or fewer samples — and would be published as a
# real result. Stubbed via PATH rather than by filling the disk.
stub_dir="$work/stub"
mkdir -p "$stub_dir"
cat > "$stub_dir/head" <<'STUB'
#!/bin/sh
cat > /dev/null
exit 1
STUB
chmod +x "$stub_dir/head"
dest10="$work/d10"
out10=$(PATH="$stub_dir:$PATH" "$subject" "$zip1" "$dest10" 2>"$work/e10")
check "a failed member write yields nothing usable" "" "$out10"
check "the write failure is announced" "yes" \
  "$(grep -q "Failed while writing" "$work/e10" && echo yes || echo no)"
check "no partial file survives a failed write" "no" \
  "$([ -f "$dest10/results.json" ] && echo yes || echo no)"

# A corrupt archive is not a missing one: the missing case exits 1, but bytes
# that are not a zip at all have to come out as "nothing to post" and exit 0,
# because a fork can upload whatever it likes.
printf 'this is not a zip file at all' > "$work/garbage.zip"
dest11="$work/d11"
out11=$("$subject" "$work/garbage.zip" "$dest11" 2>"$work/e11")
# Captured on the invocation itself. Read after the `check` below, $? is that
# check's status — and `check` ends in an echo, so it is always 0 and the
# assertion could never fail.
rc11=$?
check "a corrupt archive yields nothing usable" "" "$out11"
check "a corrupt archive still exits 0" "0" "$rc11"
check "the unreadable archive is announced" "yes" \
  "$(grep -q "Could not read" "$work/e11" && echo yes || echo no)"

# An entry that exists but is empty is not a member. Distinct from the over-cap
# branch, which a zero cap would hit instead.
python3 - "$work/empty.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("results.json", "")
    z.writestr("pr.json", '{"number":7}')
PY
dest12="$work/d12"
out12=$("$subject" "$work/empty.zip" "$dest12" 2>/dev/null)
check "an empty member yields nothing usable" "" "$out12"
check "an empty member is removed" "no" \
  "$([ -f "$dest12/results.json" ] && echo yes || echo no)"

# --- usage -----------------------------------------------------------------

"$subject" >/dev/null 2>&1
check "no arguments is a usage error" "2" "$?"
"$subject" "$work/nope.zip" "$work/d6" >/dev/null 2>&1
check "a missing archive fails loudly" "1" "$?"

# The caller reads stdout through a command substitution to get the sentinel, so
# a diagnostic written there is swallowed — and the missing-archive message is the
# one that explains why a run produced nothing.
missing_out=$("$subject" "$work/nope.zip" "$work/d6b" 2>"$work/e6b" || true)
check "the missing-archive message is not on stdout" "" "$missing_out"
check "the missing-archive message reaches stderr" "yes" \
  "$(grep -q "No artifact archive" "$work/e6b" && echo yes || echo no)"

# A non-numeric cap used to reach `$((max_bytes + 1))`, where bash reads the word
# as a variable name and `set -u` aborts mid-loop with "unbound variable" — a
# shell trace in place of a usage error, after the destination was created.
"$subject" "$zip1" "$work/d7" nope >/dev/null 2>"$work/e7"
check "a non-numeric byte cap is a usage error" "2" "$?"
check "the byte-cap error names the argument" "yes" \
  "$(grep -q "max-bytes-per-file must be" "$work/e7" && echo yes || echo no)"
check "no shell trace leaks for a bad byte cap" "no" \
  "$(grep -q "unbound variable" "$work/e7" && echo yes || echo no)"
"$subject" "$zip1" "$work/d8" -5 >/dev/null 2>&1
check "a negative byte cap is a usage error" "2" "$?"

# A cap of zero admits nothing, which is the boundary of the size check rather
# than an error: every member comes out empty and empty is not a member.
zero_out=$("$subject" "$zip1" "$work/d9" 0 2>/dev/null)
check "a zero byte cap yields nothing usable" "" "$zero_out"
check "a zero byte cap leaves no files behind" "no" \
  "$([ -f "$work/d9/results.json" ] && echo yes || echo no)"

echo
echo "# pass $pass"
echo "# fail $fail"
[ "$fail" -eq 0 ]
