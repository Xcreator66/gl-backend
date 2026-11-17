import test from "node:test"; import assert from "node:assert/strict";
import { deletionBlockers, type Facts } from "./accountRules.ts";
const clean: Facts = { role: "individual", pending: 0, approved: 0, locked: 0, openRedemptions: 0, openDisputes: 0, openBatches: 0, unverifiedCollections: 0, ownsGroupWithMembers: false };
test("a clean household can delete", () => { assert.deepEqual(deletionBlockers(clean, false), []); });
test("unspent approved GREEN blocks unless the owner chooses to give it up", () => {
  assert.deepEqual(deletionBlockers({ ...clean, approved: 50 }, false), ["has_balance"]); assert.deepEqual(deletionBlockers({ ...clean, approved: 50 }, true), []);
});
test("pending money, open payouts, disputes, batches, unverified work and owned groups all block", () => {
  const b = deletionBlockers({ ...clean, role: "collector", pending: 5, locked: 1, openDisputes: 1, openBatches: 1, unverifiedCollections: 2, ownsGroupWithMembers: true }, true);
  for (const k of ["has_pending_balance", "open_redemption", "open_dispute", "open_batches", "unverified_collections", "owns_group"]) assert.ok(b.includes(k), k);
});
test("recyclers and admins cannot self-delete", () => { assert.deepEqual(deletionBlockers({ ...clean, role: "recycler" }, true), ["role_not_deletable"]); assert.ok(deletionBlockers({ ...clean, role: "admin" }, true).includes("role_not_deletable")); });
