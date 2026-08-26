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
# `unzip -j` is. It discards every directory component of every entry name, so
# no entry can address anything outside `-d`, and the explicit member list means
# an entry that is not one of the two expected names is never even considered.
# There is nothing left to sanitize because nothing about the archive's names is
# used to choose a path.
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

# Exactly what the reporter reads. `ctx.json` is deliberately absent: the
# reporter rebuilds its rendering context from trusted event fields and must
# never read the artifact's copy.
members=(results.json pr.json)

if [ ! -f "$zip_path" ]; then
  echo "::error title=Proving Benchmark::No artifact archive at ${zip_path}."
  exit 1
fi

mkdir -p "$dest"

for member in "${members[@]}"; do
  # `-j` junks paths, `-o` overwrites (a zip may carry duplicate names), and the
  # member is matched against the full stored name, so `a/results.json` does not
  # match `results.json`.
  #
  # Exit 11 is "no matching files", which is the ordinary shape of an artifact
  # from a bench job that failed before writing results. Anything else is a
  # broken or hostile archive: drop what came out of it and report nothing.
  rc=0
  unzip -o -j -d "$dest" "$zip_path" "$member" > /dev/null || rc=$?
  if [ "$rc" -eq 11 ]; then
    continue
  fi
  if [ "$rc" -ne 0 ]; then
    echo "::notice title=Proving Benchmark::Could not read ${member} from the artifact (unzip rc=${rc}); nothing to post." >&2
    rm -f "${dest:?}/${member}"
    continue
  fi

  size=$(wc -c < "$dest/$member" | tr -d '[:space:]')
  if [ "$size" -gt "$max_bytes" ]; then
    echo "::notice title=Proving Benchmark::${member} is ${size} bytes (limit ${max_bytes}); refusing to render." >&2
    rm -f "${dest:?}/${member}"
  fi
done

# stdout carries the sentinel and nothing else — every diagnostic above goes to
# stderr, which the runner still scans for workflow commands — so the caller can
# read this as a plain command substitution.
if [ -f "$dest/results.json" ] && [ -f "$dest/pr.json" ]; then
  echo "usable"
fi
