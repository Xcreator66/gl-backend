import test from "node:test"; import assert from "node:assert/strict";
import { canRaise, outcomeState } from "./disputeRules.ts";
const now = new Date("2026-06-20T00:00:00Z"), base = { household_id: "H", collector_id: "C", accepted_grams: 3000, state: "approved", created_at: "2026-06-15T00:00:00Z" };
test("household and collector may raise; strangers may not", () => {
  assert.deepEqual(canRaise(base, "H", now), { ok: true, who: "household" }); assert.deepEqual(canRaise(base, "C", now), { ok: true, who: "collector" });
  assert.deepEqual(canRaise(base, "X", now), { ok: false, error: "not_your_collection" });
});
test("unverified, adjusted and old collections are refused", () => {
  assert.equal((canRaise({ ...base, accepted_grams: null }, "H", now) as any).error, "not_verified_yet");
  assert.equal((canRaise({ ...base, state: "adjusted" }, "H", now) as any).error, "not_disputable");
  assert.equal((canRaise({ ...base, created_at: "2026-05-01T00:00:00Z" }, "H", now) as any).error, "window_closed");
});
test("outcomes: only reject is 'rejected'; adjust and acknowledge are 'upheld'", () => {
  assert.equal(outcomeState("reject"), "rejected"); assert.equal(outcomeState("adjust"), "upheld"); assert.equal(outcomeState("acknowledge"), "upheld");
});
