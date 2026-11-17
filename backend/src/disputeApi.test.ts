import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
const s = fs.readFileSync(path.join(import.meta.dirname, "disputes.ts"), "utf8");
test("the person being reported never receives the other person's detail or the reviewer's note", () => {
  assert.ok(s.includes("CASE WHEN d.raised_by=$1 THEN d.detail END detail") && s.includes("CASE WHEN d.raised_by=$1 THEN d.resolution_note END resolution_note"));
});
test("reportable list applies the same rules as canRaise (verified, pending/approved, inside the window, none open) and is collector-only", () => {
  const i = s.indexOf('"/collector/reportable"'); const block = s.slice(i, i + 700);
  for (const k of ["requireRole(\"collector\")", "accepted_grams IS NOT NULL", "IN ('pending','approved')", "now() - ($2 || ' days')::interval", "NOT EXISTS (SELECT 1 FROM disputes d WHERE d.collection_id=c.id AND d.state='open')"]) assert.ok(block.includes(k), k);
});
test("disputes never import the ledger directly (only the adjust helper that can reverse, never add)", () => { assert.ok(!/ledger\.ts/.test(s)); });
