import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
// Source-scan guards for v0.30.0 (no database needed). Database behaviour is NOT covered here: it needs the DB integration run (see docs/V0.30.0_STATUS.md).
const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
const sql = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "db", f), "utf8");
test("reward reversal reverses commission and XP inside the same function (one transaction) and is idempotent", () => {
  const a = src("adjust.ts"); assert.match(a, /reverseCommissionForCollection\(/); assert.match(a, /reverseXpForCollection\(/); assert.match(a, /idempotency_key/); assert.ok(!/\bBEGIN\b|\bCOMMIT\b/.test(a), "must run in the caller's transaction");
});
test("commission reversal never withdraws externally: shortfalls go to commission_recoverables and the override is recorded, not silent", () => {
  const r = src("commissionReversal.ts"); assert.match(r, /commission_recoverables/); assert.match(r, /override_waived/); assert.ok(!/UPDATE ledger_entries|DELETE FROM ledger_entries/i.test(r));
});
test("manual commission reversal is retired and the adjust override needs super + explicit permission", () => {
  const c = src("commissions.ts"); assert.match(c, /use_collection_adjustment/); assert.match(c, /commission\.override_reversal/); assert.match(c, /adminTier === "super"/);
});
test("role change checks blockers in the same transaction with the user row locked; override needs super + role.override", () => {
  const a = src("admin.ts"); assert.match(a, /FOR UPDATE/); assert.match(a, /findRoleBlockers\(c,/); assert.match(a, /role\.override/); assert.match(a, /role_change_blocked/);
});
test("payouts: approval is a different person with its own permission, and nothing is paid by approval or while execution is disabled", () => {
  const p = src("payouts.ts"); assert.match(p, /adminPermission\("payout\.approve"\)/); assert.match(p, /approverAllowed\(/); assert.match(p, /PAYOUT_EXECUTION_ENABLED === "true"/);
  const approveBlock = p.slice(p.indexOf('"/admin/payouts/:pid/approve"'), p.indexOf('"/admin/payouts/:pid/reject"')); assert.ok(!/ledger|await post\(|status='paid'/.test(approveBlock), "approve must not pay");
  assert.ok(p.slice(p.indexOf('"/admin/payouts/:pid/paid"')).includes("execEnabled()"));
});
test("the old single-admin payout path is closed", () => { const r = src("redemption.ts"); assert.match(r, /use_payout_workflow/); assert.match(r, /payout_in_progress/); });
test("finance permissions are explicit: super does not imply them", () => { const a = src("adminAuth.ts"); assert.match(a, /admin_permissions/); const g = a.slice(a.indexOf("adminPermission")); assert.ok(!/=== "super"/.test(g)); });
test("migrations 021-024 exist, are additive and never touch existing ledger rows", () => {
  for (const f of ["021_commission_reversal.sql", "022_admin_permissions.sql", "023_payouts.sql", "024_green_identity.sql"]) { const s = sql(f).replace(/--.*$/gm, ""); assert.ok(!/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE ledger_entries|INSERT INTO ledger_entries/i.test(s), `${f} must be additive`); }
  assert.match(sql("023_payouts.sql"), /payout_no_self_approval/); assert.match(sql("023_payouts.sql"), /payouts_one_active/); assert.match(sql("021_commission_reversal.sql"), /commission_reversed_le_green/);
});
test("identity awards XP from approved weight only and the approval path calls it", () => {
  const i = src("identity.ts"); assert.match(i, /state !== "approved"/); assert.match(i, /accepted_grams > 0/); assert.match(src("server.ts"), /awardXpForCollection\(c, x\.id\)/);
});
test("real-money payouts stay off by default: no env defaults enable execution or redemption", () => {
  for (const f of fs.readdirSync(path.join(import.meta.dirname, "..")).filter(f => /^\.env/.test(f))) assert.ok(!/(PAYOUT_EXECUTION_ENABLED|REDEMPTION_ENABLED)\s*=\s*true/.test(fs.readFileSync(path.join(import.meta.dirname, "..", f), "utf8")));
});
