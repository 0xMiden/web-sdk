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
the JS packages, the reporter). A docs-only follow-up push starts no bench and
cancels nothing,
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

**"This run stopped early."** The comment posted, but the run retained fewer
repetitions than it was configured for, and no verdict is issued from it — a run
whose length was decided mid-run by how the machine behaved is a selected sample,
and the noise floor was calibrated on complete runs. The measurements are still
real; read them as an indication. The note in the comment says which of three
things happened, because they want different responses — and only the first is
about the clock.

*It ran out of budget.* The remaining budget could not fund another repetition,
so the dropped ones were never attempted — except that a run also discards one
repetition it *did* finish when keeping it would leave the ABBA setup order
unbalanced, and the comment distinguishes the two. That is a sizing problem: raise
`BENCH_STEP_BUDGET_MINUTES` and the job's `timeout-minutes` together. Shrinking
the run instead is not a fix: both `--reps` and `--proves` are gated at their
calibrated counts, and below either one the report comes back without a verdict.
Read the `[budget]` line in the bench job's log first — it prints the measured
setup cost, which is what to size against.

*Work ran past a deadline.* Something started and did not finish. Whether it was
stuck or merely slower than the clock allowed is not decidable from the run, and
the bot does not guess — see [the budget section][budget-section]. The comment
gives you the deadline and the median setup cost measured on that runner: work
that overran a deadline far above the median was stuck, and a rayon deadlock in
the prover is the change class this benchmark exists to catch, so check the diff
before resizing anything. Below three setup samples the comment says there is too
little to lean on, and the job log is the next place to look.

*A page context would not close.* The clock was fine and nothing overran; a page
refused to go away, so every later repetition would have been measured next to a
live one and the run stopped instead. Nothing here is fixed by a larger budget.
The `[teardown]` line in the bench job's log has the close failure itself — a page
that will not close is usually a web worker still running, which is worth
understanding before trusting timings measured beside it.

**"Treat these numbers with suspicion … teardown failures."** The run could not
release a page, browser or server. Resources left open are measured against, so
the numbers are questionable and the bench job is red on purpose. Re-run.

**"The benchmark run produced no usable report."** The bench job failed, was
cancelled, or uploaded nothing readable. Its own log is the place to look — this
message is the reporter saying it found nothing, not a diagnosis.

**"This is a fault on the reporting side, not in the pull request."** A GitHub API
failure or rate limit. Re-run the reporter, or wait. Never the author's problem,
which is why it says so.

**"… was rejected by the comment renderer."** The artifact parsed as JSON but
failed one of the renderer's shape checks, so nothing was published rather than
something unverified. The reporter log carries the specific field and bound as a
`refusing to render:` line. Every such check is a producer/renderer contract, so
this is a bug in one of the two halves and not something to re-run — the message
names which field to look at.

**"… failed on its own code path."** The renderer crashed rather than declining,
which is always a bug in the reporter. The stack is in the reporter log. Re-running
will reproduce it.

**"… uploaded no `proving-bench-report` artifact"** / **"… has expired"** /
**"… is over the … limit the reporter will download."** Three states of the
artifact rather than of the pull request. No artifact means the bench job did not
reach its upload step — read that job. Expired means the report outlived the
artifact retention window; re-run the benchmark for a fresh one. Over the limit
means the producer wrote a bigger archive than the reporter will pull, which in
practice means a sample count far above the default. Bring it back to the default
`--reps 6 --proves 4` — which is also the only configuration the renderer will
rule on — and if the defaults produced the oversized archive, that is a bug worth
filing.

**"… head repository does not match"** / **"… is not a Proving Benchmark run."**
The reporter declined to attribute a report to a pull request whose identity it
could not confirm — the run came from a different repository than the pull
request's head, or from a workflow that is not the benchmark. Both are the trust
boundary doing its job. If you hit either on a legitimate run, it means the pull
request's head moved repositories mid-run (a fork was deleted and recreated, say),
and a fresh run on the current head is the fix.

## The bench did not run

- **The pull request has no `bench` label, and this is the usual answer.** While
  the noise floor is provisional the bot runs opt-in only, because a run costs
  about three runner-hours and the comment declines to rule until the floor has
  been measured on this runner class. Add the `bench` label to start a run on an
  open pull request. Removing the label does not stop a run already going.
  This gate disappears once the runner is calibrated — see
  [calibration.md](calibration.md), and the `if:` block in `bench.yml` names the
  two things to delete.
- **The pull request is a draft.** Drafts are skipped: that is where pushes are
  most frequent and a proving number least useful. Marking it ready for review
  starts the run that was skipped.
- The pull request changed only paths in `paths-ignore` — by design, and the
  denylist is deliberately conservative. If a change there could plausibly
  move a proving number, the list is wrong; fix the list. Currently ignored:
  markdown and `docs/**`, the JS packages, `.github/scripts/**` and
  `.github/workflows/bench-comment.yml`. The last two are ignored because a
  change to the reporter cannot move a proving number *and* cannot be exercised
  by this pull request's own bench run — `workflow_run` always executes the
  default branch's copy.
- Only the title or body was edited. `bench.yml` takes the `edited` event for
  retargeting and skips the rest, so the job is skipped and the reporter stays
  quiet. Intentional: without that guard every title edit published a "no usable
  report" check.
- A newer push cancelled it. The concurrency group is per pull request with
  `cancel-in-progress`, so rapid pushes cancel the expensive job each time.

## Nothing happens at all, on any pull request

Check which branch `bench-comment.yml` is on. `workflow_run` only ever fires the
**default branch's** copy of a workflow — `main` here — so until the reporter has
landed on `main` there is nothing to trigger, no matter how many bench runs
succeed. The symptom is silence rather than an error: the bench job goes green,
uploads its artifact, and no comment appears and no reporter run is listed.

This bites specifically when the change lands on `next` first, which is the normal
route for this repo. `bench.yml` works from any branch, because it runs on
`pull_request` in the pull request's own context. The reporter does not. So between
merging to `next` and `next` reaching `main`, the bot measures and says nothing.

There is no fix to apply on a pull request — it is a property of `workflow_run`.
Either land the reporter on `main`, or read the numbers from the bench run's job
summary, which is rendered in the bench job itself and does not depend on the
reporter.

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

[budget-section]:
  calibration.md#the-step-budget-is-sized-against-a-number-nobody-has-measured
