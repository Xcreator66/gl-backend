import test from "node:test"; import assert from "node:assert/strict";
import { commissionDelta, splitRecoverable } from "./commissionMath.ts";
const base = { commissionGreen: 50, batchGreen: 1000, collectionGreen: 400, alreadyProcessedForCollection: 0, alreadyProcessedForCommission: 0 };
test("full reversal of a collection reverses its proportional share of the batch commission", () => { assert.equal(commissionDelta({ ...base, rewardReversedAfter: 400 }), 20); });
test("partial reversals accumulate without drifting and never exceed the collection's share", () => {
  const a = commissionDelta({ ...base, rewardReversedAfter: 100 }); assert.equal(a, 5);
  const b = commissionDelta({ ...base, rewardReversedAfter: 300, alreadyProcessedForCollection: a, alreadyProcessedForCommission: a }); assert.equal(b, 10);
  const c = commissionDelta({ ...base, rewardReversedAfter: 400, alreadyProcessedForCollection: a + b, alreadyProcessedForCommission: a + b }); assert.equal(c, 5);
  assert.equal(a + b + c, 20);
  assert.equal(commissionDelta({ ...base, rewardReversedAfter: 400, alreadyProcessedForCollection: 20, alreadyProcessedForCommission: 20 }), 0);
});
test("cumulative reversals can never exceed the original commission", () => {
  assert.equal(commissionDelta({ ...base, collectionGreen: 1000, rewardReversedAfter: 1000, alreadyProcessedForCommission: 45 }), 5);
  assert.equal(commissionDelta({ ...base, collectionGreen: 1000, rewardReversedAfter: 5000 }), 50);
});
test("zero or missing inputs reverse nothing", () => { for (const k of ["commissionGreen", "batchGreen", "collectionGreen"] as const) assert.equal(commissionDelta({ ...base, [k]: 0, rewardReversedAfter: 400 }), 0); });
test("rounding never reverses more than the share, and dust stays with the collector", () => { assert.equal(commissionDelta({ commissionGreen: 5, batchGreen: 100, collectionGreen: 33, rewardReversedAfter: 33, alreadyProcessedForCollection: 0, alreadyProcessedForCommission: 0 }), 1); });
test("already-spent commission becomes recoverable, not an error", () => {
  assert.deepEqual(splitRecoverable(20, 50), { take: 20, recoverable: 0 }); assert.deepEqual(splitRecoverable(20, 5), { take: 5, recoverable: 15 });
  assert.deepEqual(splitRecoverable(20, 0), { take: 0, recoverable: 20 }); assert.deepEqual(splitRecoverable(20, -9), { take: 0, recoverable: 20 });
});
