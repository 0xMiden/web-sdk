import assert from "node:assert/strict";
import test from "node:test";

import {
  opensBaseFirst,
  orderBalance,
  proveOrder,
  proveSlotFlipped,
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
