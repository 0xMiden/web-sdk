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

**Normality.** It assumes the deltas are roughly normal, which the grind lottery
below argues against in the tails.

**One benchmark.** It is the rate for a single benchmark. This suite has exactly
one today, but N independent benchmarks each tested at 3σ give a familywise
false-positive rate near `N × 0.3%`, so adding benchmarks means either widening
the threshold or accepting more noise in the verdict.

The renderer does not rest the verdict on the threshold alone, for exactly these
reasons. A movement is reported as significant only when it clears the floor
**and** every repetition's paired difference agrees on its direction; base and
head run interleaved within a repetition, so those differences are a genuine
paired sample and the agreement requirement is a sign test that assumes nothing
about the shape of the distribution (2/2⁶ ≈ 3% at the default six repetitions).
A movement that clears the floor while its repetitions disagree is reported as
**unresolved** rather than as a result — which is the honest label for an
aggregate whose spread is wider than the effect.

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
`provesPerRep` finite numbers, or the renderer refuses the artifact and the bot
posts nothing. Changing the shape of that array means bumping `schemaVersion` on
both sides.

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
