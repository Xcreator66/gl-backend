import test from "node:test"; import assert from "node:assert/strict";
import { nextState, parseId, type PickupState, type PickupAction } from "./pickupRules.ts";
test("claim only from open; release/done only from assigned", () => {
  assert.equal(nextState("open", "claim"), "assigned"); assert.equal(nextState("assigned", "claim"), null);
  assert.equal(nextState("assigned", "release"), "open"); assert.equal(nextState("open", "release"), null);
  assert.equal(nextState("assigned", "done"), "done"); assert.equal(nextState("open", "done"), null);
});
test("household can cancel open or assigned, never finished requests", () => {
  assert.equal(nextState("open", "cancel"), "cancelled"); assert.equal(nextState("assigned", "cancel"), "cancelled");
  assert.equal(nextState("done", "cancel"), null); assert.equal(nextState("cancelled", "cancel"), null);
});
test("terminal states allow nothing", () => {
  for (const s of ["done", "cancelled"] as PickupState[]) for (const a of ["claim", "release", "done", "cancel"] as PickupAction[]) assert.equal(nextState(s, a), null);
});
test("parseId rejects non-integers and SQL-ish input", () => {
  assert.equal(parseId("42"), "42");
  for (const bad of ["0", "-1", "1.5", "1e3", "abc", "", "1 OR 1=1", "01", "9".repeat(30)]) assert.equal(parseId(bad), null);
});
