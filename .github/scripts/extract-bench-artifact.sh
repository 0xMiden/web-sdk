#!/usr/bin/env bash
#
# Extract the two files the benchmark reporter reads out of a fork-controlled
# artifact zip, and nothing else.
#
# WHY THIS EXISTS INSTEAD OF `actions/download-artifact`
# -----------------------------------------------------
# The zip is written by the UNTRUSTED half of the pipeline (`bench.yml` runs on
# `pull_request`, so a fork controls the workflow file on its own head and can
# upload a hand-crafted archive). The reporter that consumes it runs on the
# default branch with `pull-requests: write` and `checks: write`.
#
# `actions/download-artifact@v4` bundles a copy of `unzip-stream` whose path
# guard is `entry.path.replace(/^([/\\]*[.]+[/\\]+)*[/\\]*/, "")` — anchored at
# `^` and not global, so it strips only a LEADING `../`. An entry named
# `x/../../y` still escapes, because the guard never looks past the first
# segment. Verified against the action's own bundle.
#
# That escape is not theoretical on a GitHub runner. `$RUNNER_TEMP` is
# `/home/runner/work/_temp`, so from any extraction directory under it:
#
#   x/../../_github_workflow/event.json  -> $GITHUB_EVENT_PATH, which every
#                                           `actions/github-script` step parses
#                                           into `context` — including the
#                                           `workflow_run.head_sha` and
#                                           `head_repository.full_name` the PR
#                                           identity check compares against
#   y/../../../_actions/<action>/...     -> /home/runner/work/_actions, where the
#                                           runner has already staged the code
#                                           for every `uses:` in this job and
#                                           runs it with the write token
#
# So relocating the extraction directory does not help, and neither does
# inspecting it afterwards: the escaped files are not in it. Detection after the
# fact is the wrong shape for this problem.
#
# `unzip -p` is. It writes the member to STDOUT and never touches the
# filesystem, so the destination file is created by this script's own redirect:
# nothing in the archive chooses a path, a file mode, or a link target, and
# there is nothing left to sanitize.
#
# `unzip -j` was the first version of this and was not enough. It flattens entry
# names, which does confine the traversal, but it still RESTORES SYMLINKS — an
# entry named `results.json` carrying the symlink mode bit becomes a link to any
# absolute path the fork chooses, and the size check, the `[ -f ]` test and the
# renderer's `readFileSync` all follow it. That turns the reporter into an
# arbitrary-file-read whose output is a public PR comment, and with a duplicate
# entry of the same name `-o` writes THROUGH the link.
#
# The byte cap is applied by `head -c` on the stream rather than by `wc -c`
# afterwards, so it bounds what is actually written. A cap checked after
# extraction is not a cap: a 2 MiB zip of compressible bytes inflates to
# gigabytes on disk before anything measures it.
#
# Usage: extract-bench-artifact.sh <zip> <dest-dir> [max-bytes-per-file]
# Exit:  0 with the files extracted, or 0 having extracted nothing if the
#        archive does not carry them (a bench job that died before it produced
#        results uploads an artifact anyway). Non-zero only on a usage error or
#        an unreadable archive — never on a hostile one, which is a payload the
#        PR author chose and not a reason to fail a default-branch workflow.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $(basename "$0") <zip> <dest-dir> [max-bytes-per-file]" >&2
  exit 2
fi

zip_path=$1
dest=$2
# The real thing is tens of KB. The cap only has to sit far below what would
# exhaust the renderer, which holds every sample in memory while building the
# raw block: a ~200 KB zip inflates to ~200 MB of JSON.
max_bytes=${3:-4194304}
# Unvalidated, a non-numeric cap reaches `$((max_bytes + 1))`, where bash treats
# the word as a variable name and `set -u` aborts mid-loop with
# "nope: unbound variable" — a shell diagnostic in place of a usage error, after
# the destination has already been created.
case $max_bytes in
  '' | *[!0-9]*)
    echo "usage: $(basename "$0") <zip> <dest-dir> [max-bytes-per-file]" >&2
    echo "max-bytes-per-file must be a non-negative integer, got: ${max_bytes}" >&2
    exit 2
    ;;
esac

# Exactly what the reporter reads. `ctx.json` is deliberately absent: the
# reporter rebuilds its rendering context from trusted event fields and must
# never read the artifact's copy.
members=(results.json pr.json)

if [ ! -f "$zip_path" ]; then
  # stderr, like every other diagnostic here: the caller reads stdout through a
  # command substitution to get the sentinel, so anything written there is
  # swallowed whole — including this, which is the one message that explains why
  # the run produced nothing.
  echo "::error title=Proving Benchmark::No artifact archive at ${zip_path}." >&2
  exit 1
fi

mkdir -p "$dest"

for member in "${members[@]}"; do
  out="${dest:?}/${member}"
  rm -f "$out"

  # A zip may carry the same name twice, and `-p` would concatenate both to
  # stdout — a way to hide a second payload behind a benign-looking first one.
  # One entry per member or none.
  matches=$(unzip -Z1 "$zip_path" "$member" 2>/dev/null | grep -c . || true)
  if [ "$matches" -gt 1 ]; then
    echo "::notice title=Proving Benchmark::The artifact carries ${matches} entries named ${member}; refusing to render." >&2
    continue
  fi

  # `head -c` is given one byte more than the cap so an over-cap member is
  # detectable by size afterwards rather than being silently truncated into
  # something that might still parse.
  set +e
  unzip -p "$zip_path" "$member" 2>/dev/null | head -c "$((max_bytes + 1))" > "$out"
  codes=("${PIPESTATUS[@]}")
  set -e
  unzip_rc=${codes[0]}
  head_rc=${codes[1]}

  # `head` owns the only write to $out, so its status decides whether the file on
  # disk is the whole member. A failure part-way through a write (ENOSPC being
  # the realistic one) leaves a prefix behind, and a truncated prefix of a large
  # JSON document can still parse as valid JSON — fewer benchmarks, or fewer
  # samples in the last one — which would be published as a real result.
  if [ "$head_rc" -ne 0 ]; then
    echo "::notice title=Proving Benchmark::Failed while writing ${member} (rc=${head_rc}); refusing to render a partial file." >&2
    rm -f "$out"
    continue
  fi

  # 11 is "no matching files", the ordinary shape of an artifact from a bench job
  # that died before writing results. 141 is SIGPIPE, which only happens because
  # `head` closed the stream at the cap — handled by the size check below.
  # Anything else is a broken or hostile archive.
  if [ "$unzip_rc" -eq 11 ]; then
    # Named, because the caller only ever reports "no usable report" and the two
    # members fail for different reasons: a missing results.json is a bench job
    # that died before measuring, while a missing pr.json is one that died before
    # it even resolved the PR.
    echo "::notice title=Proving Benchmark::The artifact carries no ${member}." >&2
    rm -f "$out"
    continue
  fi
  if [ "$unzip_rc" -ne 0 ] && [ "$unzip_rc" -ne 141 ]; then
    echo "::notice title=Proving Benchmark::Could not read ${member} from the artifact (unzip rc=${unzip_rc}); nothing to post." >&2
    rm -f "$out"
    continue
  fi

  size=$(wc -c < "$out" | tr -d '[:space:]')
  if [ "$size" -gt "$max_bytes" ]; then
    echo "::notice title=Proving Benchmark::${member} exceeds the ${max_bytes}-byte limit; refusing to render." >&2
    rm -f "$out"
    continue
  fi
  # An empty member is not a member. `-p` on an entry that exists but is empty
  # is indistinguishable here from one that produced nothing, and either way
  # there is no JSON to parse. Announced like every other refusal above: the
  # caller only ever reports "no usable report", so without this line the log
  # named no reason at all for this one case.
  if [ "$size" -eq 0 ]; then
    echo "::notice title=Proving Benchmark::${member} is empty in the artifact; nothing to render." >&2
    rm -f "$out"
  fi
done

# stdout carries the sentinel and nothing else — every diagnostic above goes to
# stderr, which the runner still scans for workflow commands — so the caller can
# read this as a plain command substitution.
if [ -f "$dest/results.json" ] && [ -f "$dest/pr.json" ]; then
  echo "usable"
fi
