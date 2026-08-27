# Calibrating the proving benchmark's noise floor

The PR comment posted by the proving benchmark says whether a movement is
"beyond the noise floor". That sentence is only worth reading if the floor is a
number somebody measured on the runner the benchmark actually uses.

Until that measurement exists on `warp-ubuntu-latest-x64-8x`, the comment says
so explicitly and treats the threshold as **provisional**. This page is how the
placeholder gets replaced.

## What a calibration run is

Bench a build against a copy of itself. The true difference is exactly zero, so
every difference the run reports is measurement noise.

In CI, on the real runner:

```
Actions → Proving Benchmark → Run workflow → calibrate: true
```

Locally:

```bash
make bench-proving-calibrate
```

## How to derive the threshold

1. Run the calibration **20–30 times** on `warp-ubuntu-latest-x64-8x`, at the
   **same `reps` and `proves` the PR runs use**. A developer laptop has
   background load a CI runner does not and will overstate the floor; and a
   floor measured at one repetition count does not transfer to another, because
   the spread of a mean of per-repetition minima shrinks with `1/√reps`.
2. For each run take the reported Δ %.
3. Set the threshold at **3σ** of those deltas, rounded up.

A run that reports a delta is one sample of a distribution centred on zero. The
3σ point is the movement a genuinely unchanged PR will exceed about 0.3% of the
time — rare enough that the bot keeps its credibility. Tighter than the measured
floor turns the bot into a false-positive generator, and a bot that cries wolf
gets muted within a week.

Three caveats on that 0.3%, and the first is the one that bites.

**σ is estimated, not known.** 0.3% is the tail of a normal distribution with a
*known* standard deviation. Divide a fresh observation by an σ estimated from `n`
runs and the result follows a t distribution with `n − 1` degrees of freedom, not
a normal: beyond 3 that is roughly 0.7% at `n = 20`, 0.55% at `n = 30`, and about
**3%** at the `n = 6` the current placeholder rests on. So 20–30 runs is the
minimum for the figure to mean anything, and even then 3σ is closer to a 0.5%
rate than a 0.3% one. Treat the threshold as "rare", not as a calibrated rate.

The same `n = 6` also means the printed ±5.40% carries two digits it has not
earned. A χ²₅ interval around s = 1.79% puts σ in roughly [1.12%, 4.39%] at 95%
confidence, so 3σ is somewhere in **[3.4%, 13.2%]**. The comment marks the floor
"provisional" for this reason; the hundredths are there so the arithmetic is
reproducible, not because they are known.

**Normality.** It assumes the deltas are roughly normal, which the grind lottery
below argues against in the tails.

**One benchmark, and one run.** It is the rate for a single verdict, and with a
single benchmark in the suite the family that dominates today is not benchmarks
but *runs*: the bench fires on every push to a PR, so the relevant question is
how often a PR's whole life produces one spurious label. That number depends on
which rate is multiplied, so take it from the conjunction rather than from the
magnitude leg alone — see the table below, where ten pushes come to under 1%
rather than the ~6% the magnitude leg on its own would suggest. Adding benchmarks
multiplies it again.

The renderer does not rest the verdict on the threshold alone, for exactly these
reasons. A movement is reported as significant only when it clears the floor
**and** no repetition's paired difference contradicts that direction while a
majority positively agree (a repetition whose two sides come out exactly equal
neither agrees nor contradicts, and a run of fewer than four repetitions cannot
be called significant at all); base and
head run interleaved within a repetition, so those differences are a genuine
paired sample and the agreement requirement is a sign test that assumes nothing
about the shape of the distribution. A movement that clears the floor while its
repetitions disagree is reported as **unresolved** rather than as a result —
which is the honest label for an aggregate whose spread is wider than the effect.

2/2⁶ ≈ 3% is the sign test's *own* false-positive rate at six repetitions, and it
is a common mistake — made in an earlier draft of this file — to quote it as the
verdict's. The verdict is a conjunction, so its rate is the joint one, and it is
far smaller: see the table below. The 3% figure is only the ceiling the sign leg
contributes if the magnitude leg passed for free.

**The rep-count floor.** The sign test's one-sided rate is `1/2^(reps-1)`: 100%
at one repetition, 50% at two, 25% at three. At one repetition it passes
unconditionally, so the second leg would be pure decoration exactly where it is
needed most — and `reps` is a field in the artifact, so a fork could pick it. The
renderer therefore refuses to call anything significant below **four**
repetitions and reports it as unresolved instead.

**What the second leg costs.** Requiring unanimity is not free, and the price is
paid in false negatives. If a single repetition's delta clears zero with
probability `p`, unanimity across `reps` repetitions has probability `p^reps`, so
the conjunction's detection rate *falls* as repetitions are added for any fixed
effect size. Two consequences worth internalising before tuning anything:

- **±5.4% is not the detection point.** It is where the *magnitude* leg starts to
  pass. Simulating the renderer's exact rule — per-repetition deltas normal about
  the true effect, scaled so the aggregate carries the measured 1.79% — gives the
  three-way split below at the default six repetitions. Read the `silent` column
  first: it is the one that decides whether a regression reaches a human.
  Reproduce the tables with `node docs/benchmarks/verdict-power.mjs`, which
  mirrors the rule and is worth re-running whenever the rule changes.

  | true effect | `slower` | `unresolved` | silent |
  |---:|---:|---:|---:|
  | 0% | 0.08% | 0.21% | 99.71% |
  | 3% | 5.8% | 4.0% | 90.2% |
  | 5.4% (the floor) | 33.7% | 16.1% | 50.3% |
  | 6.2% | 49.2% | 17.4% | 33.3% |
  | 8% | 77.0% | 15.2% | 7.8% |
  | 10% | 94.2% | 5.3% | 0.4% |
  | 15% | 99.9% | 0.1% | 0.0% |

  So the 50%-detection point is ≈**6.2%**, not the floor: a true regression of
  exactly 5.4% is missed half the time. And the complement of a detection is not
  all unresolved — at 8% the split is 77 / 15 / 8, so roughly one such regression
  in thirteen is silent rather than flagged. The first row is the verdict's
  false-positive rate, 0.08% per benchmarked push, which is where the sub-1%
  familywise figure over ten pushes comes from.
- **More repetitions do not narrow this — they widen it.** Raising `--reps`
  sharpens the aggregate and simultaneously makes unanimity harder, which
  converts real regressions into ❔. The same simulation at a true 8% effect:

  | reps | `slower` | `unresolved` | silent |
  |---:|---:|---:|---:|
  | 4 | 89.6% | 2.7% | 7.7% |
  | 6 | 77.0% | 15.2% | 7.8% |
  | 12 | 25.5% | 67.0% | 7.5% |
  | 24 | 1.0% | 91.8% | 7.2% |

  At 24 repetitions a real 8% regression is called significant 1% of the time.
  The lever that actually helps is `--proves`: more proves per repetition lowers
  the variance of that repetition's minimum, which makes each individual sign
  more reliable without adding signs that all have to agree. The unresolved note
  in the comment says so. Anyone raising `--reps` past six to "be more careful"
  is making the bot quieter, not stricter.

When calibrating, record the standard deviation of the **per-repetition** deltas
as well as the aggregate. The aggregate alone cannot predict the conjunction's
behaviour, and it is the conjunction that decides what gets published.

## Why the estimator is what it is

The reported figure is the **mean of each repetition's fastest prove**. Both
levels are load-bearing, and the choice was measured rather than assumed —
six calibration runs of identical binaries, on a (busy) developer laptop:

| Statistic | σ | worst single run |
|---|---:|---:|
| median over all samples | 5.39% | 11.44% |
| minimum over all samples | 2.96% | 5.88% |
| **mean of per-repetition minima** | **1.79%** | **2.71%** |

- **Minimum within a repetition.** Every prove in one repetition is
  bit-identical work — the same `TransactionResult`, proven again. So the only
  thing that varies is interference, which only ever *adds* time. The
  repetition's fastest prove is its clean compute cost.
- **Mean across repetitions.** The faucet is not seedable here
  (`generate_faucet` uses `StdRng::from_os_rng`), so each repetition gets a
  different faucet id. That changes the note commitment and nullifier, hence the
  Fiat-Shamir transcript, hence how long the prover grinds to hit
  `QUERY_POW_BITS`. The grind is a geometric random variable: its expected work
  is fixed, its actual work is not. A *global* minimum would just pick the
  luckiest draw and inherit the whole spread of that lottery; averaging the
  per-repetition minima shrinks it towards its expectation.

  A geometric distribution is skewed, not heavy-tailed — its tail decays
  exponentially — so the word to use is "skewed". The practical consequence is
  the same for a minimum, which is drawn towards the luckiest draw either way.

  Note **shrinks**, not cancels. Base and head are separate pages served from
  separate dists, so each runs its own setup and draws its own grind — the
  comparison is not paired on the grind, and the residual is what more
  repetitions buy down. It is likely the largest single term in the floor, but
  nothing here has decomposed the variance to prove that: doing so needs a
  seeded faucet, which would also remove the term outright (see the last
  section). Until then, treat the attribution as a hypothesis.

Three further corrections, also measured:

- **Alternate at the prove level, not the page level.** Base and head are driven
  one prove at a time rather than a batch each, so thermal ramp and
  noisy-neighbour drift hit both sides equally.
- **Flip the order every prove (ABBA).** With a fixed order, whichever side ran
  second paid a consistent penalty — **+1.19%** across six runs. That is a bias,
  not noise: no number of repetitions removes it.

  The flip balances over *all* proves, but the first prove of each page is
  discarded, so what balances over the **retained** proves is
  `reps × (proves − 1)` — and only when that product is even. Keep it even
  (the default 6 × 3 is); the script warns when it is not.

  That balance is **aggregate only**, which now matters more than it did, because
  a per-repetition statistic gates the verdict. The retained count per repetition
  is `proves − 1`, and each repetition is internally balanced only when that is
  **even**:

  | `--proves` | retained/rep | base-ran-second per rep | balanced within a rep |
  | --- | --- | --- | --- |
  | 3 | 2 | 1, 1, 1, 1, 1, 1 | yes |
  | 4 (default) | 3 | 2, 1, 2, 1, 2, 1 | **no** |
  | 5 | 4 | 2, 2, 2, 2, 2, 2 | yes |

  So the default retains an odd 3 and every repetition is internally imbalanced
  by one prove, cancelling only in the mean across repetitions. That leaves an
  alternating positional bias inside the per-repetition deltas the sign test
  reads — small next to the deltas' own spread, but it is not something the
  aggregate balance removes. Prefer an odd `--proves` (even retained) at the next
  recalibration. Changing it now would invalidate the recorded floor, which was
  measured at 6 × 3 retained.

  The warning attaches no figure to the residual bias on purpose. The +1.19%
  penalty is *per prove*, while the reported statistic is a mean of per-repetition
  **minima**, and a minimum is not linear in a per-prove penalty: when a
  repetition's fastest prove ran first on both sides the penalty cancels outright,
  and when it ran second on one side it lands in full. Scaling 1.19% by the
  retained prove count would be precision this estimator cannot support.
- **Discard the first repetition.** The first repetition of a process pays
  OS-level warm-up (page cache, Chromium start-up, CPU governor ramp) that no
  later repetition pays.

Because a calibration run exercises this exact pipeline, the floor it measures
already includes everything above. That is the point: the threshold is defined
as "what this measurement setup does when nothing changed", not as a theoretical
bound.

### What the estimator cannot see

Every variance reduction above is bought by discarding data, and each discard is
a specific class of regression that this benchmark will report as `±0.00%`. None
of these is a reason to change the estimator — a noisier bot that nobody trusts
catches nothing at all — but they bound what a green result means.

- **A slowdown that misses the fastest prove.** The per-repetition minimum keeps
  one prove and drops the rest, so a change that makes two proves in three 50%
  slower moves the reported figure not at all: the untouched prove is still the
  minimum. That is the shape of a collection pause, a lock, a retry, or a cache
  that now misses on some fraction of calls. The renderer computes the same
  delta over *every* retained prove as a cross-check and prints a note when the
  two disagree, which is the only signal that this case was hit. The note is
  deliberately not a verdict, because the mean carries 5.39% σ against the
  estimator's 1.79%.
- **A cold-start regression.** Prove #0 of every page is discarded, and the
  entire first repetition is a warm-up. A change that only makes the *first*
  prove slower — a bigger precompile table, more one-time allocation, extra
  lazy-init work — is invisible by construction. Proving cost after warm-up is
  what this benchmark measures, and a user's first prove is not that.
- **Anything outside the timed interval.** The timer wraps the
  `proveTransaction` call and nothing else. Prover construction
  (`newLocalProver`), transaction execution, the faucet draw, the sync, and the
  production worker round-trip are all outside it. A regression confined to any
  of them cannot move this number, and the web worker path in particular is
  never exercised — the benchmark deliberately constructs the client with
  `globalThis.Worker` undefined, because a worker-backed prove reports the
  round-trip rather than the compute.
- **Both sides share one machine, simultaneously.** Base and head are separate
  browser contexts open at the same time, each having called `initThreadPool` for
  the full thread count. Only one of the two proves at any instant, so they do
  not contend for CPU during the timed interval, but they do share caches, memory
  bandwidth, and whatever the idle context's pool threads cost while parked. That
  is a symmetric cost — it is present on both sides, so it inflates the floor
  rather than favouring either side — and it is part of why the floor is as wide
  as it is.

## Applying the result

Set `THRESHOLD_PCT` in `.github/scripts/render-bench-comment.mjs` to the
measured value and flip `THRESHOLD_PROVISIONAL` to `false`. Record the date, the
runner label, the `reps` × `proves` configuration, the sample count and the
measured σ in the commit message so the next person can tell whether the number
has gone stale.

The threshold lives in the renderer rather than in `bench-proving.mjs` on
purpose: the renderer runs on the privileged side of the `workflow_run` split,
and the benchmark JSON it reads is written by a job the PR author controls. A
threshold taken from that JSON would let a fork set its own noise floor and
silence its own regression.

For the same reason the renderer does not read the summary statistics either. It
recomputes the reported figure, the median, the minimum and the maximum from the
per-repetition `samples` array, and ignores the `value` / `min` / `median` /
`max` that `bench-proving.mjs` writes alongside them — otherwise an artifact
could keep authoring the verdict by arithmetic rather than by flag. So `samples`
is the load-bearing field of the schema: it must hold exactly `reps` groups of
`provesPerRep` non-negative finite numbers, or the renderer refuses the artifact
and the bot posts nothing.

### The two halves are never at the same revision

`workflow_run` always runs the workflow and scripts from the repository's
**default branch**, never from the PR. So a change to the renderer — the
threshold, the verdict rules, the schema — takes effect for every open PR the
moment it lands on the default branch, and has no effect at all while it sits in
a PR. Two consequences worth knowing before you change either half:

- **A PR targeting `next` is judged by `main`'s renderer.** Editing
  `THRESHOLD_PCT` on `next` changes nothing until `next` reaches `main`. Verify a
  renderer change by dispatching the reporter, not by reading the diff on your
  branch.
- **Bumping `schemaVersion` has a required order.** The renderer accepts a *set*
  of versions (`ACCEPTED_SCHEMA_VERSIONS`); teach it the new version and land
  that on the default branch **first**, then bump the producer in
  `bench-proving.mjs`, then drop the old version once no open PR can still be
  carrying the old producer. Bumping the producer first, or swapping the
  renderer's single accepted version, silences the bot for every open PR until
  each one rebases.

The current placeholder is **5.4%** — 3σ of the 1.79% measured below
(3 × 1.79 = 5.37, rounded up).

Re-calibrate when the runner class changes, when the thread count changes, or
when the workload changes — each of those invalidates the previous number.

## If the floor is still too wide

The remaining variance is dominated by the grind lottery, which more repetitions
only average down slowly. The way to remove it outright is to make both sides
prove the *same* transaction, which needs a deterministic faucet. `newFaucet`
takes no seed on this branch, and `BasicFungibleFaucetComponent` is a reader
rather than a builder, so that route needs an SDK change first — building the
faucet from `AccountBuilder(init_seed)` plus a fungible-faucet component and
`newAccountWithSecretKey`. Worth doing if the measured CI floor stays above a
few percent.
