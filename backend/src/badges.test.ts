import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { evaluate, emptyStats, CATALOGUE, BADGE_IDS, type Stats } from "./badges.ts";
import { parseReferralCode, newReferralCode, formatReferralCode } from "./referralCode.ts";
const st = (o: Partial<Stats>): Stats => ({ ...emptyStats(), ...o });
const earned = (s: Stats, a: "individual" | "collector") => evaluate(s, a).filter(b => b.earned).map(b => b.id);
test("nothing verified means no badges, and progress starts at zero", () => {
  assert.deepEqual(earned(emptyStats(), "individual"), []); assert.deepEqual(earned(emptyStats(), "collector"), []);
  assert.ok(evaluate(emptyStats(), "individual").every(b => b.progress === 0 && b.target > 0));
});
test("weight milestones switch on exactly at the threshold, not before", () => {
  assert.ok(!earned(st({ totalGrams: 999, collections: 1 }), "individual").includes("verified_1kg"));
  assert.ok(earned(st({ totalGrams: 1000, collections: 1 }), "individual").includes("verified_1kg"));
  const big = earned(st({ totalGrams: 500_000, collections: 60 }), "individual");
  for (const id of ["verified_1kg", "verified_10kg", "verified_50kg", "verified_100kg", "verified_500kg", "collections_10", "collections_50"]) assert.ok(big.includes(id), id);
});
test("material and variety badges use per-material verified grams", () => {
  const e = earned(st({ totalGrams: 20_000, collections: 5, byMaterial: { PET: 5000, ALU: 999, PAP: 14_001 } }), "individual");
  assert.ok(e.includes("pet_5kg")); assert.ok(!e.includes("alu_1kg")); assert.ok(e.includes("variety_3")); assert.ok(!e.includes("gls_10kg"));
  assert.ok(!earned(st({ byMaterial: { PET: 1, ALU: 1, GLS: 0 } }), "individual").includes("variety_3"), "zero grams does not count as a material");
});
test("audiences are separate: household badges never show for collectors and vice versa", () => {
  const s = st({ totalGrams: 1_000_000, collections: 99, handledGrams: 60_000, households: 6 });
  const c = evaluate(s, "collector").map(b => b.id), i = evaluate(s, "individual").map(b => b.id);
  assert.ok(c.every(id => CATALOGUE.find(d => d.id === id)!.audience === "collector")); assert.ok(i.every(id => CATALOGUE.find(d => d.id === id)!.audience === "individual"));
  assert.deepEqual(earned(s, "collector").sort(), ["handled_50kg", "households_5"]);
});
test("progress is capped at the target and never negative; fractions are floored", () => {
  for (const b of evaluate(st({ totalGrams: 9_999_999, collections: 9999 }), "individual")) assert.ok(b.progress <= b.target);
  assert.ok(evaluate(st({ totalGrams: -5 }), "individual").every(b => b.progress >= 0));
});
test("catalogue ids are unique, safe and match the database check", () => { assert.equal(BADGE_IDS.size, CATALOGUE.length); for (const d of CATALOGUE) assert.match(d.id, /^[a-z0-9_]{3,40}$/); });
test("badges and referrals can never post GREEN: they do not import the ledger or reward modules", () => {
  for (const f of ["badges.ts", "badgesApi.ts", "referrals.ts", "referralCode.ts"]) { const src = fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
    assert.ok(!/from\s+["']\.\/(ledger|rewards|redemption|commissions)\.ts["']/.test(src), `${f} must not import money code`);
    assert.ok(!/INSERT INTO ledger_entries/i.test(src), `${f} must not write the ledger`); }
  const refSrc = fs.readFileSync(path.join(import.meta.dirname, "referrals.ts"), "utf8"); assert.ok(!/badge|user_badges/i.test(refSrc.replace(/\/\/.*$/gm, "")), "referrals must not feed badges");
});
test("referral codes: random, canonical, forgiving of typing, strict about everything else", () => {
  const c = newReferralCode(); assert.match(c, /^[0-9A-HJKMNP-TV-Z]{8}$/); assert.equal(parseReferralCode(c), c); assert.equal(parseReferralCode(formatReferralCode(c).toLowerCase()), c);
  assert.equal(parseReferralCode("oooooooo"), "00000000"); assert.equal(parseReferralCode("ILILILIL"), "11111111");
  for (const bad of [null, 5, "", "1234567", "123456789", "UUUUUUUU", "ABCD EFG!", "x".repeat(50)]) assert.equal(parseReferralCode(bad as any), null);
  assert.equal(new Set(Array.from({ length: 2000 }, newReferralCode)).size, 2000);
});
