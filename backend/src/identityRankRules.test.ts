import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { periodContaining, lastCompletedPeriod, periodFromStartDate, normalizeCity, scopeValue, validateLevels, validateRanks, validateTitle, STATES, isStateCode, MIN_GEO_PARTICIPANTS } from "./identityRankRules.ts";
const iso = (d: Date) => d.toISOString();
test("weekly periods run Monday 00:00 IST to the next Monday and are stored as UTC instants", () => {
  const p = periodContaining("weekly", new Date("2026-11-17T09:00:00Z")); // Tuesday
  assert.equal(iso(p.start), "2026-11-15T18:30:00.000Z"); assert.equal(iso(p.end), "2026-11-22T18:30:00.000Z"); assert.equal(p.label, "2026-11-16");
  const sun = periodContaining("weekly", new Date("2026-11-22T18:29:59Z")); assert.equal(sun.label, "2026-11-16"); assert.equal(periodContaining("weekly", new Date("2026-11-22T18:30:00Z")).label, "2026-11-23");
});
test("the IST calendar day, not the UTC day, decides which period a moment belongs to", () => {
  assert.equal(periodContaining("monthly", new Date("2026-10-31T18:29:59Z")).label, "2026-10"); assert.equal(periodContaining("monthly", new Date("2026-10-31T18:30:00Z")).label, "2026-11");
});
test("monthly periods handle year end and leap February", () => {
  const dec = periodContaining("monthly", new Date("2026-12-20T00:00:00Z")); assert.equal(iso(dec.start), "2026-11-30T18:30:00.000Z"); assert.equal(iso(dec.end), "2026-12-31T18:30:00.000Z");
  assert.equal(iso(periodContaining("monthly", new Date("2028-02-10T00:00:00Z")).end), "2028-02-29T18:30:00.000Z");
});
test("the last completed period is the one before the current one", () => {
  const now = new Date("2026-11-17T09:00:00Z"); assert.equal(lastCompletedPeriod("weekly", now).label, "2026-11-09"); assert.equal(lastCompletedPeriod("monthly", now).label, "2026-10");
  assert.equal(lastCompletedPeriod("monthly", new Date("2027-01-02T00:00:00Z")).label, "2026-12");
});
test("a period named by start date must be valid, aligned and finished", () => {
  const now = new Date("2026-11-17T09:00:00Z");
  assert.equal(periodFromStartDate("weekly", "2026-11-09", now)?.label, "2026-11-09"); assert.equal(periodFromStartDate("weekly", "2026-11-10", now), null); // Tuesday
  assert.equal(periodFromStartDate("weekly", "2026-11-16", now), null); // still running
  assert.equal(periodFromStartDate("monthly", "2026-10-01", now)?.label, "2026-10"); assert.equal(periodFromStartDate("monthly", "2026-10-02", now), null); assert.equal(periodFromStartDate("monthly", "2026-11-01", now), null);
  assert.equal(periodFromStartDate("monthly", "2026-02-31", now), null); assert.equal(periodFromStartDate("monthly", "not-a-date", now), null);
});
test("city names meet across case, spacing and punctuation but stay distinct otherwise", () => {
  assert.equal(normalizeCity("Jandiala")!.key, normalizeCity("  JANDIALA ")!.key); assert.equal(normalizeCity("Jandiala Guru")!.key, normalizeCity("jandiala-guru")!.key);
  assert.equal(normalizeCity("St. John's")!.key, "st johns"); assert.notEqual(normalizeCity("Jandiala")!.key, normalizeCity("Jandiala Guru")!.key);
  assert.equal(normalizeCity("Jandiala  Guru")!.city, "Jandiala Guru"); assert.equal(normalizeCity("लुधियाना")!.key, "लुधियाना");
});
test("city input that is empty, too long or not a place name is rejected", () => {
  for (const bad of ["", " ", "A", "x".repeat(61), "1234", "Delhi<script>", "--", "Delhi; DROP TABLE users"]) assert.equal(normalizeCity(bad), null, bad);
});
test("scope values are state-qualified so same-named cities never merge, and missing location yields null", () => {
  assert.equal(scopeValue("india", { state: null, cityKey: null }), ""); assert.equal(scopeValue("state", { state: null, cityKey: null }), null);
  assert.equal(scopeValue("state", { state: "PB", cityKey: null }), "PB"); assert.equal(scopeValue("city", { state: "PB", cityKey: null }), null); assert.equal(scopeValue("city", { state: "PB", cityKey: "jandiala" }), "PB:jandiala");
  assert.notEqual(scopeValue("city", { state: "MH", cityKey: "aurangabad" }), scopeValue("city", { state: "BR", cityKey: "aurangabad" }));
});
test("state list has 36 entries, valid codes, and rejects prototype keys", () => {
  assert.equal(Object.keys(STATES).length, 36); assert.ok(isStateCode("PB")); assert.ok(!isStateCode("XX")); assert.ok(!isStateCode("constructor")); assert.ok(!isStateCode("__proto__")); assert.ok(MIN_GEO_PARTICIPANTS >= 5);
});
test("level curves must start at 0, be contiguous and strictly increase", () => {
  const ok = Array.from({ length: 10 }, (_, i) => ({ level: i + 1, xpRequired: 50 * i * i })); assert.equal(validateLevels(ok), null); assert.equal(validateLevels([...ok].reverse()), null);
  assert.match(validateLevels([{ level: 1, xpRequired: 10 }, { level: 2, xpRequired: 20 }])!, /level 1/); assert.match(validateLevels([{ level: 1, xpRequired: 0 }, { level: 3, xpRequired: 20 }])!, /gaps/);
  assert.match(validateLevels([{ level: 1, xpRequired: 0 }, { level: 2, xpRequired: 20 }, { level: 3, xpRequired: 20 }])!, /more XP/); assert.match(validateLevels([{ level: 1, xpRequired: 0 }])!, /between/);
  assert.match(validateLevels([{ level: 1, xpRequired: 0 }, { level: 2, xpRequired: 1.5 }])!, /whole/); assert.match(validateLevels([{ level: 1, xpRequired: 0 }, { level: 2, xpRequired: 2e9 }])!, /whole/);
  assert.match(validateLevels(Array.from({ length: 101 }, (_, i) => ({ level: i + 1, xpRequired: i })))!, /between/);
});
const existing = [["newcomer", 1], ["contributor", 2], ["guardian", 3]].map(([code, position]) => ({ code: code as string, position: position as number }));
test("ranks keep their set and order; only names and thresholds change", () => {
  const good = [{ code: "newcomer", name: "Seedling", minScore: 0 }, { code: "contributor", name: "Sprout", minScore: 10 }, { code: "guardian", name: "Guardian", minScore: 40 }]; assert.equal(validateRanks(good, existing), null);
  assert.match(validateRanks(good.slice(0, 2), existing)!, /cannot change/); assert.match(validateRanks([...good, { code: "extra", name: "Extra", minScore: 90 }], existing)!, /cannot change/);
  assert.match(validateRanks([{ ...good[0], minScore: 5 }, good[1], good[2]], existing)!, /start at 0/); assert.match(validateRanks([good[0], { ...good[1], minScore: 40 }, good[2]], existing)!, /higher/);
  assert.match(validateRanks([good[0], good[1], { ...good[2], minScore: 101 }], existing)!, /0 to 100/); assert.match(validateRanks([{ ...good[0], name: "X" }, good[1], good[2]], existing)!, /2-30/);
  assert.match(validateRanks([good[0], good[0], good[2]], existing)!, /cannot change/);
});
test("automatic titles need verified-weight criteria; admin-verified titles carry none", () => {
  assert.equal(validateTitle({ awardMode: "automatic", eligibleRoles: ["individual", "collector"], criteria: { materials: ["PET"], min_grams: 25000 } }), null);
  assert.equal(validateTitle({ awardMode: "admin_verified", eligibleRoles: ["individual", "recycler"], criteria: {} }), null);
  assert.match(validateTitle({ awardMode: "automatic", eligibleRoles: ["individual"], criteria: {} })!, /min_grams/); assert.match(validateTitle({ awardMode: "automatic", eligibleRoles: ["recycler"], criteria: { min_grams: 5000 } })!, /citizens and collectors/);
  assert.match(validateTitle({ awardMode: "admin_verified", eligibleRoles: ["individual"], criteria: { min_grams: 5000 } })!, /cannot have/); assert.match(validateTitle({ awardMode: "automatic", eligibleRoles: ["individual"], criteria: { min_grams: 5000, materials: ["a b"] } })!, /material/);
  assert.match(validateTitle({ awardMode: "automatic", eligibleRoles: ["individual"], criteria: { min_grams: 500 } })!, /min_grams/); assert.match(validateTitle({ awardMode: "automatic", eligibleRoles: ["admin"], criteria: { min_grams: 5000 } })!, /valid account/);
  assert.match(validateTitle({ awardMode: "automatic", eligibleRoles: [], criteria: { min_grams: 5000 } })!, /valid account/); assert.match(validateTitle({ awardMode: "automatic", eligibleRoles: ["individual"], criteria: { min_grams: 5000, bonus: 1 } as any })!, /unknown/);
});
test("migration 028 is additive, makes history immutable and touches no money tables", () => {
  const s = fs.readFileSync(path.join(import.meta.dirname, "..", "db", "028_identity_rankings.sql"), "utf8").replace(/--.*$/gm, "");
  assert.ok(!/DROP TABLE|TRUNCATE|DELETE FROM|ledger_entries/i.test(s)); assert.match(s, /leaderboard_snapshots_immutable[\s\S]*fin_record_immutable/); assert.match(s, /leaderboard_snapshot_runs_immutable/);
});
test("ranking code never imports money code", () => { for (const f of ["identityRankRules.ts", "identityRankings.ts"]) { const p = path.join(import.meta.dirname, f); if (fs.existsSync(p)) assert.ok(!/from "\.\/(ledger|rewards|commissions|payouts|redemption)\.ts"|ledger_entries/.test(fs.readFileSync(p, "utf8")), f); } });
