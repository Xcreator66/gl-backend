import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
test("every route in moderation.ts is behind the moderator guard", () => {
  const s = src("moderation.ts"); const routes = s.match(/moderation\.(get|post)\([^\n]*/g) ?? [];
  assert.ok(routes.length >= 4); for (const r of routes) assert.ok(/, mod,/.test(r), `unguarded route: ${r}`);
  assert.ok(/adminOnly\("moderator"\)/.test(s));
});
test("restore only touches moderator-hidden content of live accounts; hide only touches visible content", () => {
  const s = src("moderation.ts");
  assert.ok(s.includes("t.mod_hidden_at IS NOT NULL") && s.includes("u.deleted_at IS NULL"));
  assert.ok(s.includes("AND NOT hidden RETURNING user_id"));
});
test("no admin route is left unguarded in community.ts, and moderation never imports the ledger", () => {
  for (const line of src("community.ts").split("\n").filter(l => /community\.(get|post)\("\/admin\//.test(l))) assert.ok(/adminOnly\(/.test(line), line);
  assert.ok(!/ledger\.ts/.test(src("moderation.ts")));
});
test("migration 019 adds comment reports and the moderator-hidden marker; account deletion removes the person's reports", () => {
  const m = fs.readFileSync(path.join(import.meta.dirname, "..", "db", "019_comment_moderation.sql"), "utf8");
  for (const t of ["CREATE TABLE comment_reports", "ALTER TABLE posts    ADD COLUMN mod_hidden_at", "ALTER TABLE comments ADD COLUMN mod_hidden_at", "ALTER TABLE reports  ADD COLUMN resolved_at"]) assert.ok(m.includes(t), t);
  const a = src("account.ts"); assert.ok(a.includes("DELETE FROM comment_reports WHERE reporter=$1") && a.includes("DELETE FROM reports WHERE reporter=$1"));
});
