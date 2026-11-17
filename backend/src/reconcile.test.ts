import test from "node:test"; import assert from "node:assert/strict";
import { reconcile } from "./reconcile.ts"; import { greenFor, greenToPaise } from "./rewards.ts";
test("spec example: 3 + 2.5 + 4.5 kg declared, 9.8 kg received", () => {
  const r = reconcile([{txId:"A",grams:3000},{txId:"B",grams:2500},{txId:"C",grams:4500}], 9800, 1);
  assert.equal(r.acceptedTotal, 9800); assert.equal(r.discrepancyGrams, 200);
  assert.deepEqual(r.allocations.map(a=>a.acceptedGrams), [2940,2450,4410]); assert.equal(r.flagged, true);
});
test("allocations sum to accepted; never exceed declared", () => {
  const r = reconcile([{txId:"A",grams:333},{txId:"B",grams:333},{txId:"C",grams:334}], 1000);
  assert.equal(r.allocations.reduce((s,a)=>s+a.acceptedGrams,0), 1000);
  assert.equal(reconcile([{txId:"A",grams:500}], 900).acceptedTotal, 500);
});
test("rewards: 10 GREEN = INR 1", () => { assert.equal(greenFor(2940, 40), 117); assert.equal(greenToPaise(100), 1000); });
test("fuzz: allocations always sum to min(verified, declared) and never exceed declared", () => {
  for (let i = 0; i < 500; i++) {
    const d = Array.from({ length: 1 + Math.floor(Math.random() * 8) }, (_, k) => ({ txId: `t${k}`, grams: 1 + Math.floor(Math.random() * 20000) }));
    const total = d.reduce((s, x) => s + x.grams, 0), verified = Math.floor(Math.random() * total * 1.3);
    const r = reconcile(d, verified);
    assert.equal(r.allocations.reduce((s, a) => s + a.acceptedGrams, 0), Math.min(verified, total));
    r.allocations.forEach(a => assert.ok(a.acceptedGrams >= 0 && a.acceptedGrams <= a.declaredGrams));
  }
});
