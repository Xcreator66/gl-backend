import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { safeCode } from "./httpErrors.ts";
const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
const db = path.join(import.meta.dirname, "..", "db");
// Source-scan guards for v0.29.0 fixes (no database needed). Database behaviour is covered by the DB tests and CI smoke run.
test("JWTs are signed and verified with HS256 pinned", () => {
  const a = src("auth.ts"); assert.match(a, /algorithm: "HS256"/); assert.match(a, /algorithms: \["HS256"\]/);
});
test("collection idempotency replay is limited to the same collector, household, material and weight", () => {
  const s = src("server.ts");
  for (const col of ["collector_id", "household_id", "material_id", "declared_grams"]) assert.match(s, new RegExp(`collections\\.${col}=EXCLUDED\\.${col}`));
  assert.match(s, /idempotency_key_conflict/);
});
test("/batches never returns raw internal error text", () => {
  const s = src("server.ts"); assert.ok(!/error: String\(e\.message\)/.test(s)); assert.match(s, /error: safeCode\(e\)/);
});
test("safeCode passes business codes and rethrows database-style errors", () => {
  assert.equal(safeCode(new Error("collections_not_eligible")), "collections_not_eligible");
  assert.throws(() => safeCode(Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" })));
  assert.throws(() => safeCode(new Error("some free text with spaces")));
});
test("ledger is protected against TRUNCATE and the integrity check requires that trigger", () => {
  const m = fs.readFileSync(path.join(db, "020_ledger_audit_guards.sql"), "utf8");
  assert.match(m, /BEFORE TRUNCATE ON ledger_entries/); assert.match(m, /ledger_no_truncate/);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "integrity.sql"), "utf8"), /ledger_no_truncate/);
});
test("money settings come only from validated config, never raw Number(process.env...)", () => {
  for (const f of ["server.ts", "redemption.ts", "revenueApi.ts"]) assert.ok(!/Number\(process\.env\.(COMMISSION_BPS|TOLERANCE_PCT|GREEN_PER_INR|MIN_REDEEM_GREEN)/.test(src(f)), f);
});
test("redemption stays off unless explicitly enabled", () => {
  assert.match(src("redemption.ts"), /REDEMPTION_ENABLED === "true"/);
});
test("audit log is append-only and the integrity check requires it", () => {
  const m = fs.readFileSync(path.join(db, "020_ledger_audit_guards.sql"), "utf8");
  assert.match(m, /BEFORE UPDATE OR DELETE ON audit_log/); assert.match(m, /BEFORE TRUNCATE ON audit_log/);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "integrity.sql"), "utf8"), /audit_no_change/);
  for (const f of fs.readdirSync(import.meta.dirname).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")))
    assert.ok(!/(UPDATE|DELETE FROM)\s+audit_log/i.test(src(f)), `${f} must not modify audit_log`);
});
test("admin routes validate numeric ids and /collections checks the material", () => {
  assert.match(src("commissions.ts"), /parseId\(req\.params\.id\)/); assert.match(src("revenueApi.ts"), /parseId\(req\.params\.id\)/);
  assert.match(src("server.ts"), /material_not_available/);
});
