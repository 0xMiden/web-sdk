import assert from "node:assert/strict";
import test from "node:test";

import {
  opensBaseFirst,
  orderBalance,
  proveOrder,
  proveSlotFlipped,
  balancedRetainedReps,
} from "./bench-order.mjs";

const CALIBRATED = { reps: 6, proves: 4 };

test("the calibrated default balances the retained proves", () => {
  // The regression this file exists for. When the prove flip was keyed on
  // `(i + rep) % 2` on top of an open order already keyed on `rep % 2`, the two
  // alternations cancelled and this came out 6/18 — base first in one retained
  // prove of three, the same way in every repetition. A fixed positional
  // asymmetry in the configuration the noise floor was calibrated at.
  const balance = orderBalance(CALIBRATED);
  assert.equal(balance.proveTotal, 18);
  assert.equal(balance.proveBaseFirst, 9);
  assert.ok(balance.provesBalanced);
});

test("the two alternations are independent", () => {
  // The direct statement of the bug: if the prove order depended on the
  // repetition parity as well as the prove index, the open-order flip would
  // cancel it. Within one repetition the order must be a function of the prove
  // index and the open order only — and across two repetitions with opposite
  // open orders, the same prove index must produce opposite provers.
  for (let i = 0; i < 6; i++) {
    const even = proveOrder(["base", "head"], i); // an even rep opens base first
    const odd = proveOrder(["head", "base"], i); // an odd rep opens head first
    assert.notEqual(
      even[0],
      odd[0],
      `prove ${i} put the same side first in both open orders`
    );
  }
});

test("base opens first on even repetitions only", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(opensBaseFirst), [
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
});

test("odd prove slots reverse the open order", () => {
  assert.deepEqual([0, 1, 2, 3].map(proveSlotFlipped), [
    false,
    true,
    false,
    true,
  ]);
  assert.deepEqual(proveOrder(["base", "head"], 0), ["base", "head"]);
  assert.deepEqual(proveOrder(["base", "head"], 1), ["head", "base"]);
});

test("proveOrder does not mutate the caller's array", () => {
  const sides = ["base", "head"];
  proveOrder(sides, 1);
  assert.deepEqual(sides, ["base", "head"]);
});

test("the warm-up repetition and the first prove are excluded", () => {
  // Both discards shift the parity of what has to balance, which is why the
  // condition is on `reps × (proves - 1)` and not on `reps × proves`.
  const balance = orderBalance({ reps: 2, proves: 3 });
  assert.equal(balance.setupTotal, 2, "repetition 0 is the warm-up");
  assert.equal(balance.proveTotal, 4, "prove 0 of each page is discarded");
  assert.deepEqual(
    balance.perRep.map((r) => r.rep),
    [1, 2],
    "the retained repetitions start at 1"
  );
});

test("aggregate prove balance holds exactly when reps x (proves-1) is even", () => {
  // The guard the producer prints is derived from these counts rather than from
  // this formula, so this test is what ties the two together. If the interleave
  // changes and this parity no longer characterises it, this fails rather than
  // the producer silently reporting a biased configuration as balanced.
  for (let reps = 1; reps <= 24; reps++) {
    for (let proves = 2; proves <= 12; proves++) {
      const balance = orderBalance({ reps, proves });
      assert.equal(
        balance.provesBalanced,
        (reps * (proves - 1)) % 2 === 0,
        `reps=${reps} proves=${proves}: counted ${balance.proveBaseFirst}/${balance.proveTotal}`
      );
    }
  }
});

test("setup balance holds exactly when reps is even", () => {
  for (let reps = 1; reps <= 24; reps++) {
    const balance = orderBalance({ reps, proves: 4 });
    assert.equal(balance.setupBalanced, reps % 2 === 0, `reps=${reps}`);
    assert.equal(balance.setupBaseFirst, Math.floor(reps / 2));
  }
});

test("per-repetition balance needs an even retained prove count", () => {
  // Stricter than the aggregate, and the one the paired sign test would want:
  // the verdict reads each repetition's delta separately.
  for (const proves of [2, 3, 4, 5, 6, 7]) {
    const balance = orderBalance({ reps: 6, proves });
    assert.equal(
      balance.perRepBalanced,
      (proves - 1) % 2 === 0,
      `proves=${proves} retains ${proves - 1} per repetition`
    );
  }
});

test("a per-repetition lean alternates direction rather than accumulating", () => {
  // Why the odd retained count is a note and not a warning: the lean flips sign
  // every repetition, so it makes unanimous sign agreement harder rather than
  // manufacturing it. If it ever stopped alternating, the sign test would be
  // reading a bias it cannot distinguish from an effect.
  const leans = orderBalance(CALIBRATED).perRep.map(
    (r) => r.baseFirst * 2 - r.total
  );
  assert.deepEqual(leans, [1, -1, 1, -1, 1, -1]);
  assert.equal(
    leans.reduce((a, b) => a + b, 0),
    0,
    "the leans must cancel across the run"
  );
});

test("the interleave composes both alternations, and the open order carries one of them", () => {
  // This is the property that broke twice, in opposite directions, and neither
  // time did anything fail. Base-first must alternate BETWEEN repetitions at the
  // calibrated default; if it is the same in every repetition the interleave has
  // collapsed to a function of the prove index and become a fixed positional
  // asymmetry — measurable as a bias, invisible as a test failure.
  const { perRep } = orderBalance({ reps: 6, proves: 4 });
  const counts = perRep.map((r) => r.baseFirst);
  assert.deepEqual(counts, [2, 1, 2, 1, 2, 1]);
  assert.ok(
    new Set(counts).size > 1,
    "base-first is identical in every repetition: the interleave collapsed"
  );

  // And why `proveOrder`'s input contract is load-bearing rather than stylistic.
  // Feeding it a canonicalised [base, head] — which the driver used to do —
  // strips the repetition parity out and produces exactly that collapse.
  const collapsed = [];
  for (let rep = 1; rep <= 6; rep++) {
    let baseFirst = 0;
    for (let i = 1; i < 4; i++) {
      if (proveOrder(["base", "head"], i)[0] === "base") baseFirst += 1;
    }
    collapsed.push(baseFirst);
  }
  assert.deepEqual(
    collapsed,
    [1, 1, 1, 1, 1, 1],
    "canonicalising the input should collapse the interleave; if it no longer does, proveOrder's contract changed"
  );
});

test("every retained prove slot is accounted for in the balance", () => {
  // `orderBalance` is what the printed note reports, so a drift between it and
  // the driver's own loop makes the note lie about the bias. Pin the totals it
  // claims against the arithmetic the driver's discards imply.
  for (const reps of [1, 2, 3, 6, 7]) {
    for (const proves of [1, 2, 3, 4, 5]) {
      const { proveTotal, setupTotal } = orderBalance({ reps, proves });
      assert.equal(
        proveTotal,
        reps * (proves - 1),
        `reps=${reps} proves=${proves}: retained prove count`
      );
      assert.equal(setupTotal, reps, `reps=${reps}: retained setup count`);
    }
  }
});

// A run that stops early keeps only an even number of repetitions, because the
// setup order alternates on parity. These pin the rule to the alternation it
// exists to protect: whatever `balancedRetainedReps` returns must produce an
// equal split of `opensBaseFirst`.
test("the retained count always leaves the setup order balanced", () => {
  for (let measured = 0; measured <= 40; measured++) {
    const retained = balancedRetainedReps(measured);
    assert.ok(
      retained <= measured,
      `retained ${retained} exceeds the ${measured} measured`
    );
    assert.ok(
      measured - retained <= 1,
      `dropped ${measured - retained} repetitions, which is more than the odd tail`
    );

    // The property that matters, checked against the alternation itself rather
    // than against a restatement of the parity rule.
    let baseFirst = 0;
    for (let rep = 1; rep <= retained; rep++) {
      if (opensBaseFirst(rep)) baseFirst += 1;
    }
    assert.equal(
      baseFirst,
      retained - baseFirst,
      `${retained} retained repetitions set up base first ${baseFirst} times and ` +
        `head first ${retained - baseFirst} times`
    );
  }
});

test("an even measured count is kept whole", () => {
  for (const n of [0, 2, 4, 6, 100]) assert.equal(balancedRetainedReps(n), n);
});

test("an odd measured count gives up exactly its last repetition", () => {
  for (const n of [1, 3, 5, 7, 101])
    assert.equal(balancedRetainedReps(n), n - 1);
});

test("a nonsensical measured count is refused rather than coerced", () => {
  for (const bad of [-1, 1.5, NaN, Infinity, "6", null, undefined]) {
    assert.throws(
      () => balancedRetainedReps(bad),
      TypeError,
      `accepted ${bad}`
    );
  }
});
