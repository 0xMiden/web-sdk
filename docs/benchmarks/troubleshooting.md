# The proving benchmark bot: when something looks wrong

For whoever is looking at a pull request that should have a benchmark comment and
does not, or one whose comment says something surprising. The methodology and the
noise floor are in [calibration.md](calibration.md); this file is only about
operating the thing.

## First: there is always a reason somewhere

The bot has two halves. `bench.yml` runs on the pull request, builds both sides
and measures; `bench-comment.yml` runs on the default branch afterwards, holds the
write token, and posts. **The second one is where reports get declined**, and it
is not the workflow run you are looking at — it does not appear in the pull
request's own checks list, because it belongs to the default branch.

Whenever it declines, it publishes a neutral check run named **Proving
Benchmark** on the head commit, whose summary states the cause and links the
reporter's log. So the order to look in things is:

1. The **Proving Benchmark** check run on the head commit. If it exists and says
   nothing was posted, its summary is the answer.
2. The **Proving Benchmark** workflow run on the pull request — did the
   measurement itself succeed?
3. The **Proving Benchmark Comment** run on the default branch (Actions → that
   workflow), whose log carries the specific notice.

If none of the three exists, the bench never started; skip to
[the bench did not run](#the-bench-did-not-run).

## Common causes, in the order they actually happen

**"The pull request moved to a newer commit while the benchmark was running."**
You pushed while a bench was in flight. The numbers were measured on the old
commit, so they were not posted. Normally the push that moved the head starts a
replacement bench and its report arrives a couple of hours later — but **not if
that push only touched paths in `bench.yml`'s `paths-ignore`** (docs, markdown,
the JS packages). A docs-only follow-up push starts no bench and cancels nothing,
so no report is coming. Re-run the *Proving Benchmark* workflow on the pull
request to get one.

**"The pull request was closed (or merged) before the benchmark report was
ready."** Nothing to
do. Expected on any long-running run.

**"The benchmark measured against `<sha>`, which is not in `<base>`'s
history."**
The pull request was retargeted (this repo moves things between `main` and `next`)
after the run started, so the comparison was against a base this pull request no
longer has. A retarget now starts a fresh bench by itself; if you also edited the
title or body in the same action, check that a new run appeared.

**"This run stopped early."** The comment posted, but the run hit its
wall-clock budget and reported fewer repetitions than it was configured for. The
comparison is still sound — see
[the truncation section](calibration.md#a-run-that-runs-out-of-clock-keeps-an-even-number-of-repetitions)
— but with less power, and below six repetitions it will not issue a verdict at
all. If this recurs, the budget is too tight rather than the run too slow: raise
`BENCH_STEP_BUDGET_MINUTES` and the job's `timeout-minutes` together, or lower
`--proves`.

**"Treat these numbers with suspicion … teardown failures."** The run could not
release a page, browser or server. Resources left open are measured against, so
the numbers are questionable and the bench job is red on purpose. Re-run.

**"The benchmark run produced no usable report."** The bench job failed, was
cancelled, or uploaded nothing readable. Its own log is the place to look — this
message is the reporter saying it found nothing, not a diagnosis.

**"This is a fault on the reporting side, not in the pull request."** A GitHub API
failure or rate limit. Re-run the reporter, or wait. Never the author's problem,
which is why it says so.

## The bench did not run

- The pull request changed only paths in `paths-ignore` — by design, and the
  denylist is deliberately conservative. If a change there could plausibly
  move a proving number, the list is wrong; fix the list.
- Only the title or body was edited. `bench.yml` takes the `edited` event for
  retargeting and skips the rest, so the job is skipped and the reporter stays
  quiet. Intentional: without that guard every title edit published a "no usable
  report" check.
- A newer push cancelled it. The concurrency group is per pull request with
  `cancel-in-progress`, so rapid pushes cancel the expensive job each time.

## Re-running by hand

The reporter accepts a `workflow_dispatch` with a bench `run_id`, which re-renders
an existing artifact without re-measuring. Useful when the render or the post
failed but the measurement is fine, and the only way to exercise a renderer change
against real data — note that `workflow_run` always executes the **default
branch's** copy of the renderer, so a change to it cannot be tested from the pull
request that introduces it.

```bash
gh workflow run "Proving Benchmark Comment" -f run_id=<bench run id>
```

## Before changing either workflow

```bash
make lint-bench-workflows   # actionlint, scoped to these two files
make test-bench-scripts     # renderer, interleave and extractor unit tests
```

The bot's correctness lives largely in workflow expressions, where a typo in an
`if:` disables a job silently rather than failing loudly. Both commands are fast
and neither needs a build.
