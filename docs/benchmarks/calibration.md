# Calibrating the proving benchmark's noise floor

For operating the bot rather than calibrating it — a comment that never
appeared, a report that was declined, a run that stopped early — see
[troubleshooting.md](troubleshooting.md).

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
   **same `reps` and `proves` the PR runs use**. A developer laptop and a shared
   CI runner differ in ways that do not have a known sign: the laptop has
   interactive background load the runner does not, and the runner has
   virtualisation, cold caches and neighbours the laptop does not. Do not assume
   the CI floor is tighter — measure it. A floor measured at one repetition count
   also does not transfer to another, because the spread of a mean of
   per-repetition minima shrinks with `1/√reps`.
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
magnitude leg alone — see the table below, where ten independent pushes come to
about 1.5% rather than the ~2.5% the magnitude leg on its own would suggest.
Adding benchmarks multiplies it again.

The renderer does not rest the verdict on the threshold alone, for exactly these
reasons. A movement is reported as significant only when it clears the floor
**and** no repetition's paired difference contradicts that direction while a
majority positively agree (a repetition whose two sides come out exactly equal
neither agrees nor contradicts, and a run of fewer than six repetitions cannot
be called significant at all — see "Below six repetitions there is no verdict at
all"); base and
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

**The rep-count floor.** The sign test's any-direction rate is `1/2^(reps-1)`
(`2/2^reps` — all-positive or all-negative, each `1/2^reps`): 100%
at one repetition, 50% at two, 25% at three. At one repetition it passes
unconditionally, so the second leg would be pure decoration exactly where it is
needed most — and `reps` is a field in the artifact, so a fork could pick it. The
renderer therefore refuses to call anything significant below **six**
repetitions — the calibrated count — and reports it as unresolved instead; see
"Below six repetitions there is no verdict at all" under
[How to derive the threshold](#how-to-derive-the-threshold).

**What the second leg costs.** Requiring unanimity is not free, and the price is
paid in false negatives. If a single repetition's delta clears zero with
probability `p`, unanimity across `reps` repetitions has probability `p^reps`, so
the conjunction's detection rate *falls* as repetitions are added for any fixed
effect size. Two consequences worth internalising before tuning anything:

- **±5.4% is not the detection point.** It is where the *magnitude* leg starts to
  pass. Simulating the renderer's headline rule gives the split below at the
  default six repetitions. Read the `silent` column first: it is the one that
  decides whether a regression reaches a human. Reproduce every table in this
  section with `node docs/benchmarks/verdict-power.mjs`, which mirrors the rule
  and is worth re-running whenever the rule changes.

  **What `silent` means here.** These tables cover the headline verdict, which is
  computed from the mean of per-repetition minima. The renderer *also* runs a
  mean cross-check that can raise ❔ Unresolved when the per-repetition means move
  while the minima do not, and the simulation cannot model it — it is fed
  per-repetition delta scalars and has no per-prove distribution to take a mean
  of. So `silent` means "the headline said nothing"; the comment may still carry
  the cross-check's note. This makes the `silent` column an upper bound on true
  silence, and by an amount nobody has measured, because the mean's own spread
  has never been measured either.

  | true effect | `slower` | `faster` | `unresolved` | silent |
  |---:|---:|---:|---:|---:|
  | 0% | 0.07% | 0.07% | 0.10% | 99.75% |
  | 3% | 5.94% | 0.00% | 3.17% | 90.89% |
  | 5.4% (the floor) | 36.10% | 0.00% | 13.98% | 49.92% |
  | 6.2% | 50.96% | 0.00% | 16.48% | 32.56% |
  | 8% | 78.53% | 0.00% | 14.21% | 7.26% |
  | 10% | 93.21% | 0.00% | 6.26% | 0.52% |
  | 15% | 99.82% | 0.00% | 0.18% | 0.00% |

  So the 50%-detection point is ≈**6.2%**, not the floor: a true regression of
  exactly 5.4% is missed half the time. And the complement of a detection is not
  all unresolved — at 8% the split is 79 / 14 / 7, so roughly one such regression
  in fourteen is silent rather than flagged. The first row is the false-positive
  rate, and it splits evenly by direction because the rule is symmetric under the
  null: **0.07%** of unchanged pushes are called slower and as many are called
  faster. Any spurious verdict is 0.15% per push, which compounds to **1.49%**
  over ten pushes — under this model's assumption that pushes are independent.
  Real pushes are not: they share runner state and build on each other's source,
  so treat that as a modelled figure rather than a measured familywise rate.

  **The model, stated plainly, because the table is only as good as it.** Each
  repetition's paired delta is drawn normal about the true effect, independent of
  the others, with a per-repetition σ of 1.79 × √6 = 4.38% — that is, the
  measured aggregate σ back-projected onto one repetition *on the assumption that
  repetitions are independent and identically distributed*. That assumption is
  not verified, and there is a specific reason to think it is optimistic: the
  1.79% was measured **across six whole runs**, so it contains any run-level
  component — runner state, cache warmth, another tenant on the host — and this
  projection charges all of it to within-run per-repetition noise. A run-level
  component does not shrink with `--reps`, so the 12- and 24-repetition rows and
  the "silence falls from 7.3% to 0.2%" claim are optimistic by an unquantified
  amount, and so is the "±5.4% is only 2.5σ at four repetitions" figure further
  down. Correlated repetitions or a residual ABBA position effect would likewise
  change the sign-unanimity power without changing the aggregate σ the projection
  starts from. The normal shape is also an approximation — the grind is geometric
  and interference is one-sided. Treat these figures as the behaviour of the
  *rule* under a reasonable model, not as measurements. Recording per-repetition
  deltas during calibration (below) is what would replace the projection with
  data.
- **More repetitions trade `slower` for ❔, but they do buy fewer misses.** The
  same simulation at a true 8% effect, varying only the repetition count:

  | reps | `slower` | `unresolved` | silent |
  |---:|---:|---:|---:|
  | 4 | 0.00% | 88.25% | 11.75% |
  | 6 | 78.53% | 14.21% | 7.26% |
  | 12 | 65.66% | 32.34% | 2.00% |
  | 24 | 43.62% | 56.22% | 0.17% |

  Above six, two effects run in opposite directions. Raising `--reps` sharpens
  the aggregate, so a real effect clears the fixed ±5.4% floor far more reliably
  — silence falls from 7.3% to 0.2%. But the zero-contradiction leg gets harder
  at the same time, because each added repetition is another sign that must not
  disagree, so detections migrate from `slower` to ❔ rather than disappearing. A
  long run is therefore *less* likely to miss a regression and *more* likely to
  hedge about it. Which you prefer depends on whether a ❔ in the comment gets
  read.

  The lever with no such trade-off is `--proves`: more proves per repetition
  lowers the variance of that repetition's minimum, which makes each individual
  sign more reliable without adding signs that all have to agree. The unresolved
  note in the comment says so.
- **Below six repetitions there is no verdict at all,** which is why the 4-reps
  row above is 0%. `MIN_REPS_FOR_SIGN_TEST` is pinned to the calibrated
  repetition count, and the reason is that both legs of the rule weaken together
  below it, not just the sign test:

  | reps | any verdict | `unresolved` | silent |
  |---:|---:|---:|---:|
  | 1 | 0.00% | 21.89% | 78.11% |
  | 2 | 0.00% | 8.20% | 91.80% |
  | 3 | 0.00% | 3.24% | 96.76% |
  | 4 | 0.00% | 1.41% | 98.59% |
  | 6 | 0.15% | 0.10% | 99.75% |
  | 12 | 0.00% | 0.00% | 100.00% |
  | 24 | 0.00% | 0.00% | 100.00% |

  ±5.4% is 3σ of the estimator **measured at six repetitions**, and that
  estimator's spread shrinks with 1/√reps, so the same fixed number is only about
  2.5σ of a four-repetition run's own spread — while unanimity across four signs
  happens by chance one run in eight. Before the floor was raised, four
  repetitions produced a spurious verdict on 1.07% of unchanged pushes, seven
  times the calibrated six's rate, in a *shorter* job. Above six the same rigidity
  works in our favour: the fixed threshold is more than 3σ of a longer run's
  tighter estimator, so only the downward direction needs blocking.

  Short runs still render — they report the movement and say the run was too
  short to judge it — so `--reps 2` remains useful for smoke-testing the
  pipeline. It is just not a measurement. Note the ❔ column climbing as
  repetitions fall: at one repetition 22% of *unchanged* pushes draw a question
  mark, because the magnitude leg alone is doing all the work.

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
  thing that varies is interference, which only ever *adds* time, and the
  repetition's fastest prove is its **best observed** warm prove.

  Not "its clean compute cost", which is what this said and is a stronger claim
  than the design earns. A minimum is a lower-tail order statistic: it equals the
  uncontended cost only if all remaining variation really is non-negative
  interference *and* one of the three proves happened to land in a near-zero-
  interference moment. Neither is established, and the estimator's bias toward
  the tail depends on how many proves are drawn — which is why the retained
  prove count is fixed at the calibrated value rather than left free.

  The consequence is a real blind spot, and it is worth stating next to the
  claim: an estimator built on best-case latency does not see a regression that
  leaves the best case alone. Two of three proves becoming 50% slower moves this
  headline not at all. That is what the mean cross-check below is for, and it is
  why a green headline is not a general assurance about proving performance.
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
  (the default 6 × 3 is). The producer refuses an odd `--reps` at parse time and
  asserts on the balance checks, so a violation cannot reach a measurement.

  Aggregate balance holds whenever `reps × (proves − 1)` is even, which is what
  the guard asserts. Balance is **aggregate**,
  which matters because a per-repetition statistic gates the verdict. The
  retained count per repetition is `proves − 1`, and a repetition is internally
  balanced only when that is **even**:

  | `--proves` | retained/rep | base-ran-second per rep | balanced within a rep |
  | --- | --- | --- | --- |
  | 3 | 2 | 1, 1, 1, 1, 1, 1 | yes |
  | 4 (default) | 3 | 1, 2, 1, 2, 1, 2 | **no**, alternates |
  | 5 | 4 | 2, 2, 2, 2, 2, 2 | yes |

  So the default retains an odd 3 and every repetition is internally imbalanced
  by one prove, in alternating directions, cancelling in the mean across
  repetitions but not within any single one. That leaves an alternating
  positional bias inside the per-repetition deltas the sign test reads. It works
  against a verdict rather than toward one — a bias that flips sign every
  repetition makes unanimous agreement harder, not easier — so it costs power and
  does not manufacture false positives. Prefer an odd `--proves` (even retained)
  at the next recalibration, which is due regardless.

  An odd product is no longer reachable: `--reps` must be even, and an even
  `--reps` makes both the retained-prove split and the setup order balanced for
  any `--proves`. The producer refuses an odd count at parse time rather than
  warning about it, because the imbalance it causes is the same fixed positional
  asymmetry a truncated run gives up a repetition to avoid — and a clean
  `--reps 7` run would otherwise have carried it into a *confident* verdict,
  being above the repetition floor, with only a stderr line to say so. The two
  balance checks in the producer are assertions now: reaching them means the
  interleave and the even-reps rule have diverged, which is a bug rather than a
  configuration.

  The per-repetition note attaches no figure to the residual bias on purpose.
  The +1.19%
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
  deliberately not a verdict: the spread of a mean over all proves has never
  been measured on this workload. It is *not* the 5.39% in the table above —
  that figure belongs to the **median** over all samples, a different
  statistic —
  and it cannot be inferred from the other rows either. So the note's ±5.4% gate
  is a bare effect-size filter ("large enough to be worth reading about"), not a
  confidence level, and the sign test over per-repetition mean deltas is what
  actually bounds how often the note fires on noise.
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

### A run that runs out of clock keeps an even number of repetitions, and no verdict

The step has a wall-clock budget, and a run that reaches it stops rather than
being killed. What it has already measured is written and reported — every
repetition in the samples is whole, since one is only recorded after both sides
finish, so there is nothing partial to discard.

The retained count is then rounded **down to even**, which costs a repetition and
is worth it. The setup order alternates by repetition, so an even count sets up
base first exactly as often as head first; an odd count cannot. Stopping at three
repetitions leaves one side having set up twice on an idle machine and the other
once, and that is a *fixed* positional asymmetry — the single class of error that
more repetitions do not average away, and the reason the order alternates in the
first place. Keeping the odd tail would buy one more sample at the cost of tilting
all of them.

#### A stopped run reports its numbers and does not rule on them

The obvious objection is selection bias: the run stopped because it was slow, so
the repetitions that survive are a sample chosen by their own runtime. The
reassuring answer, which this document used to give, is that the reported figure
is a **paired difference** rather than a level — both builds are measured inside
every repetition, so a slow machine period scales both sides and cancels.

That answer is true, and it is not enough. Selection acts on the run's total
duration, roughly `head + base`, while the reported quantity is `head - base`,
and the correlation between them is

```text
Cov(head + base, head - base) = Var(head) - Var(base)
```

which is zero **exactly when the two sides have the same run-level variance**.
The cancellation was never a property of pairing; it was a property of symmetry,
and nothing had checked the symmetry.

`truncation-selection.mjs` in this directory measures that identity, under a
model harsher than this workload: thermal drift across the run, a 5% chance of any
prove running 2.5x long, four proves per repetition with the first discarded, and
setup charged to the clock. The only knob is where a 12% run-level factor lives.

| Run-level factor | Stopped at 6 of 8 | Clean 6 of 6 | Shift |
| --- | --- | --- | --- |
| neither (the null) | -0.20% | -0.00% | -0.19pp |
| both sides | +1.28% | +1.47% | -0.19pp |
| head only | -18.92% | -0.02% | -18.90pp |
| base only | +24.09% | +1.42% | +22.66pp |

The symmetric rows shift by a fifth of a point, and they do so even with drift and
heavy tails — which is why making the noise nastier is not a way to break a paired
design. Give one side a run-level factor and nothing to the other, and truncation
shifts the estimate by many points, in whichever direction the asymmetry points,
while a complete run of the same model does not move at all. The exact magnitude
depends on how aggressively the clock cuts; the sign and the structure do not.

So: is the symmetry real? The two sides are the same benchmark on the same machine
in the same browser, differing only in the WASM binary — which is a good argument
that a run-level factor should hit them equally, and no measurement at all. A
change to allocation or memory layout is a plausible way for one binary to be more
sensitive to machine state than the other, and that is precisely the kind of change
this bot exists to catch.

The renderer therefore **withholds the verdict on a truncated run** and reports
its numbers as an indication. Nothing is hidden: the table, the samples and the
disclosure all render, and the comment says why it is not ruling. This costs
nothing in the common case, because a truncated run means the budget was already
too tight — the remedy is to fix the budget and re-run, which the note says. It
also retires a whole argument: no one has to be persuaded that an unmeasured
symmetry assumption holds before trusting a published number.

The same rule covers two more shapes the calibration does not reach, for the same
reason each time — the fixed threshold is 3σ *of this estimator at this
configuration*, and it does not transfer downward:

- **An odd retained count.** The setup order alternates by repetition, so an odd
  count sets one side up first once more than the other. The producer refuses an
  odd `--reps` outright, but `reps` is artifact-authored, so the renderer declines
  to rule rather than trusting the producer to have prevented it.
- **Fewer than three retained proves per repetition.** The threshold is 3σ of a
  mean of per-repetition *minima* taken over three proves. The minimum of fewer
  is a noisier statistic, so against it the same cutoff is under 3σ. Repetitions
  were already floored for this and proves were only footnoted, which was
  inconsistent: both legs weaken identically, and a one-repetition-one-prove
  artifact was the cheapest route to a confident verdict.

All three blocks are one-directional. More repetitions, or more proves, make the
estimator *tighter*, so the fixed threshold becomes more than 3σ rather than
less — conservative, and therefore still sound. Only the downward direction is
blocked.

#### The report says so

A truncated run is disclosed in the comment, above everything that quotes a
repetition count, stating what it retained and what it was configured for. The
note is composed on the trusted side from validated integers: the producer's
`stoppedEarly` message is read for its PRESENCE only and never rendered,
because a fork controls that string and comment prose is pinned on the
reporting side for the same reason the verdict is.

The artifact carries `repsRequested` and the true `repsExecuted` — the warm-up
plus every repetition that completed, including one dropped for parity — and the
renderer bounds them against each other, so an artifact claiming a truncation it
did not have, or a repetition count it did not run, is refused rather than
rendered. A run that keeps no balanced repetitions — nothing measured, or a single
one — fails instead, because there is nothing left to report.

If truncation starts happening routinely, the budget is wrong, not the run:
raise the step's `timeout-minutes` and `--budget-minutes` together, or lower
`--reps` / `--proves`. A report built on four repetitions is never as good as
one built on six.

## The step budget is sized against a number nobody has measured

Setup — mint, prove a block, sync — is untimed by the estimator and is by far the
largest consumer of the benchmark step's wall clock. It is also paid **twice per
repetition**, once for each side, so a default `--reps 6` run pays
`2 × (6 + 1) = 14` setups rather than 7. An earlier version of the budget
arithmetic in `bench.yml` counted 7 and sized the step at 20 minutes against an
estimated 80s setup. At 14 setups that is 21 minutes of setup alone: the run would
have retained 4 repetitions, below the 6 the renderer requires, and **every report
would have come back unresolved**.

The step is now 45 minutes. **This is a hypothesis about the operating point, not
a measured one**, and it is worth being precise about how it fails. Completion is
a distribution, not a threshold: the run has to fit fourteen setups, so what
matters is the mean setup cost *and* its spread. Simulating that, with CV the
coefficient of variation of a single setup:

| mean setup | CV = 0.10 | CV = 0.25 | CV = 0.50 |
| ---------- | --------: | --------: | --------: |
| 60s        |    100.0% |    100.0% |    100.0% |
| 90s        |    100.0% |    100.0% |    100.0% |
| 120s       |    100.0% |    100.0% |     99.1% |
| 150s       |     99.9% |     89.9% |     75.5% |
| 180s       |      0.0% |      7.3% |     24.7% |

Reproduce with `node docs/benchmarks/budget-reachability.mjs`.

Each cell is the probability that a default run completes, and therefore the
probability that it can be ruled on at all — a truncated run withholds its verdict
(see the section above). The behaviour is a cliff, not a slope: anywhere below
about 120s the budget is comfortable at any plausible spread, and by 180s the bot
is effectively silent. Between those the answer depends entirely on a number
nobody has measured.

So do not read the 45 minutes as "sized correctly". Read it as "sized so that the
estimate has to be wrong by about 1.7× before the bot goes quiet", which buys room
to find out but is not evidence of anything.

So the producer now measures it. Every run prints a line like

```text
[budget] 14 setups: mean 88.4s, slowest 96.1s, total 20.6 min of a 45-minute budget.
```

and writes `setupMsMean`, `setupMsMax` and `setupCount` into `results.json`. **Read
that line after the first green CI run and resize `BENCH_STEP_BUDGET_MINUTES` and
the job's `timeout-minutes` from it**, in the same pass as setting the threshold
below.

Those same measurements are also read back during the run. Classifying a timeout
needs to know what a setup normally costs — a grant far above that means a timeout
is a hang, a grant close to it means the clock simply ran out — and answering that
from the 90s estimate is wrong in the expensive direction: wherever the real cost
exceeds `90s × 2`, a healthy run with a legitimately slow setup has its timeout
called a hang, and every repetition already measured is discarded. So the producer
uses the **median** of the setups it has actually timed, floored at the estimate,
falling back to the estimate alone for the first setup of a run. The classification
follows the machine, and resizing the budget neither affects that nor needs to.

The median matters more than it sounds. The slack factor that turns an expected
duration into a starvation threshold is sized for what the work *normally* takes,
so handing it the slowest sample spends that slack twice: one slow-but-completing
setup would set the threshold at twice that outlier for every later grant, and a
real deadlock underneath it would be reported as the clock running out — keeping
the run, publishing measurements taken around a hang, and advising the reader to
raise a timeout that was never the problem. Across a sweep of deadlock scenarios
the maximum misreports 43.2% of them and the median 1.2%.

One consequence to know about. The expectation is clamped at half the work's
ceiling, so that a slow machine can never push the threshold past the point where
a hang is detectable at all. Above a five-minute measured median, that clamp binds
and only a timeout at the full ten-minute ceiling is still called a hang. That is
the right reading of a machine whose setup approaches its own ceiling, but hang
detection does narrow as the machine slows, and a runner that slow is a signal in
its own right.

Sizing from a measurement costs nothing once the run exists; sizing from
an estimate is how the 2× setup-count error survived unnoticed in the first
place.

## Applying the result

Until this is done the bot is opt-in: a pull-request run needs the `bench` label,
because three runner-hours for a report that declines to rule is not a trade worth
making by default. Calibrating is what removes that gate — the `if:` block in
`bench.yml` names the two clauses to delete once `THRESHOLD_PROVISIONAL` is false.

**This has an owner and a deadline, or it does not happen.** Until the runner is
calibrated the comment carries a "provisional floor" banner on every report,
which is the honest state but a weak signal — a real regression under the laptop
floor goes unreported. Whoever lands the first green benchmark run on `main` owns
collecting the 20–30 runs below and setting the threshold; leaving the
laptop-derived number in place indefinitely is the failure mode to avoid, not a
safe default.

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
  `THRESHOLD_PCT` on `next` changes nothing until `next` reaches `main`. Verify
  a
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
