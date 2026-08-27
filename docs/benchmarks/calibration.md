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

1. Run the calibration **20–30 times** on `warp-ubuntu-latest-x64-8x`. A
   developer laptop has background load a CI runner does not and will overstate
   the floor.
2. For each run take the reported Δ %.
3. Set the threshold at **3σ** of those deltas, rounded up.

A run that reports a delta is one sample of a distribution centred on zero. The
3σ point is the movement a genuinely unchanged PR will exceed about 0.3% of the
time — rare enough that the bot keeps its credibility. Tighter than the measured
floor turns the bot into a false-positive generator, and a bot that cries wolf
gets muted within a week.

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
  luckiest draw and inherit that lottery's heavy tail; averaging the
  per-repetition minima cancels it.

Two further corrections, also measured:

- **Alternate at the prove level, not the page level.** Base and head are driven
  one prove at a time rather than a batch each, so thermal ramp and
  noisy-neighbour drift hit both sides equally.
- **Flip the order every prove (ABBA).** With a fixed order, whichever side ran
  second paid a consistent penalty — **+1.19%** across six runs. That is a bias,
  not noise: no number of repetitions removes it.
- **Discard the first repetition.** The first repetition of a process pays
  OS-level warm-up (page cache, Chromium start-up, CPU governor ramp) that no
  later repetition pays.

Because a calibration run exercises this exact pipeline, the floor it measures
already includes everything above. That is the point: the threshold is defined
as "what this measurement setup does when nothing changed", not as a theoretical
bound.

## Applying the result

Set `thresholdPct` in `crates/web-client/scripts/bench-proving.mjs` to the
measured value and flip `thresholdProvisional` to `false`. Record the date, the
runner label, the sample count and the measured σ in the commit message so the
next person can tell whether the number has gone stale.

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
