import test from "node:test"; import assert from "node:assert/strict";
import { canMove, TRANSITIONS, PAYOUT_STATUSES, approverAllowed, canStartNewAttempt, reservationFits, isPermission } from "./payoutRules.ts";
test("approval is required before processing, and approved is never paid directly", () => {
  assert.ok(canMove("draft", "pending_approval")); assert.ok(canMove("pending_approval", "approved")); assert.ok(canMove("approved", "processing")); assert.ok(canMove("processing", "paid"));
  assert.ok(!canMove("draft", "approved")); assert.ok(!canMove("pending_approval", "processing")); assert.ok(!canMove("approved", "paid"));
});
test("terminal states have no exits", () => { for (const s of ["paid", "failed", "cancelled", "rejected"] as const) assert.equal(TRANSITIONS[s].length, 0); });
test("every status has a transition entry", () => { for (const s of PAYOUT_STATUSES) assert.ok(s in TRANSITIONS); });
test("no self-approval, for any actor", () => { assert.ok(!approverAllowed("a", "a")); assert.ok(approverAllowed("a", "b")); });
test("retry only after failure/cancel/reject, never after paid or while active", () => {
  assert.ok(canStartNewAttempt(["failed"])); assert.ok(canStartNewAttempt(["rejected", "cancelled"])); assert.ok(!canStartNewAttempt(["failed", "paid"])); assert.ok(!canStartNewAttempt(["processing"]));
});
test("reservations cannot exceed the locked balance and duplicates are caught", () => {
  assert.ok(reservationFits(1000, 0, 1000)); assert.ok(!reservationFits(1000, 1, 1000)); assert.ok(!reservationFits(1000, 0, 0)); assert.ok(!reservationFits(500, 0, 1000));
});
test("permission names are validated", () => { assert.ok(isPermission("payout.approve")); assert.ok(!isPermission("payout.everything")); assert.ok(!isPermission(undefined)); });
