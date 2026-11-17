import test from "node:test"; import assert from "node:assert/strict";
import { batchRatios } from "./batchStats.ts";
test("10 kg declared, 9.8 kg received, 0.5 kg rejected", () => { assert.deepEqual(batchRatios(10000, 9800, 500), { discrepancy_pct: 2, rejection_pct: 5.1 }); });
test("unverified batches show no ratios; more received than declared is a negative discrepancy", () => {
  assert.deepEqual(batchRatios(10000, 0, 0), { discrepancy_pct: null, rejection_pct: null }); assert.equal(batchRatios(1000, 1100, 0).discrepancy_pct, -10);
});
