import test from "node:test"; import assert from "node:assert/strict";
import { checkMaterial } from "./quality.ts";
const d = [{ txId: "A", grams: 3000 }, { txId: "B", grams: 2500 }, { txId: "C", grams: 4500 }];
test("no rejection behaves like plain reconciliation", () => {
  const q = checkMaterial(d, 9800, 0, 2, 10); assert.equal(q.rewards.acceptedTotal, 9800); assert.equal(q.flagged, false);
});
test("rejected weight earns nothing and is split fairly; heavy rejection flags the batch", () => {
  const q = checkMaterial(d, 9800, 500, 2, 5);
  assert.equal(q.rewards.acceptedTotal, 9300); assert.equal(q.rewards.allocations.reduce((s, a) => s + a.acceptedGrams, 0), 9300);
  assert.ok(q.rejectedPct > 5 && q.contaminationFlag && q.flagged);
});
test("rejection within the limit does not flag; no limit set never flags", () => {
  assert.equal(checkMaterial(d, 9900, 300, 2, 10).flagged, false); assert.equal(checkMaterial(d, 9900, 900, 2, null).contaminationFlag, false);
});
test("rejected more than received is refused", () => { assert.throws(() => checkMaterial(d, 1000, 1001, 2, 10), /rejected_exceeds_received/); });
