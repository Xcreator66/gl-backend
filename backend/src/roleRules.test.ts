import test from "node:test"; import assert from "node:assert/strict";
import { blocker, overrideValid, ADVICE } from "./roleRules.ts";
test("a blocker appears only when something is outstanding, with advice and capped record list", () => {
  assert.equal(blocker("open_batches", 0), null);
  const b = blocker("open_batches", 30, Array.from({ length: 30 }, (_, i) => `B${i}`))!; assert.equal(b.records.length, 20); assert.equal(b.resolve, ADVICE.open_batches);
});
test("override needs a reason of 10+ characters and the exact confirmation phrase", () => {
  assert.ok(overrideValid({ reason: "Migrating to recycler per ops ticket 42", confirm: "OVERRIDE GL-U-100001" }, "GL-U-100001"));
  assert.ok(!overrideValid({ reason: "short", confirm: "OVERRIDE GL-U-100001" }, "GL-U-100001"));
  assert.ok(!overrideValid({ reason: "long enough reason", confirm: "yes" }, "GL-U-100001")); assert.ok(!overrideValid({ reason: "long enough reason", confirm: "OVERRIDE GL-U-100002" }, "GL-U-100001")); assert.ok(!overrideValid(null, "x"));
});
