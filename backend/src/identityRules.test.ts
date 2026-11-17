import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { levelFor, xpForGrams, capXp, rankScore, rankFor, titleEarned, WEIGHTS } from "./identityRules.ts";
const levels = Array.from({ length: 50 }, (_, i) => ({ level: i + 1, xp_required: 50 * i * i }));
const ranks = [["newcomer", 1, 0], ["contributor", 2, 15], ["guardian", 3, 30], ["champion", 4, 45], ["eco_leader", 5, 60], ["earth_legend", 6, 85]].map(([code, position, min_score]) => ({ code, name: String(code), position, min_score })) as any;
test("levels progress from XP and cap at the top", () => {
  assert.deepEqual(levelFor(0, levels), { level: 1, xp: 0, levelStartXp: 0, nextLevelXp: 50, progressPct: 0 }); assert.equal(levelFor(50, levels).level, 2); assert.equal(levelFor(49, levels).level, 1);
  assert.equal(levelFor(25, levels).progressPct, 50); const top = levelFor(10_000_000, levels); assert.equal(top.level, 50); assert.equal(top.nextLevelXp, null); assert.equal(top.progressPct, 100); assert.equal(levelFor(-5, levels).xp, 0);
});
test("xp comes from verified grams only and the daily cap limits farming", () => { assert.equal(xpForGrams(1050, 100), 10); assert.equal(xpForGrams(0, 100), 0); assert.equal(xpForGrams(-1, 100), 0); assert.equal(capXp(500, 0, 300), 300); assert.equal(capXp(50, 290, 300), 10); assert.equal(capXp(50, 400, 300), 0); });
test("weights sum to 100 and no single metric can reach a high rank alone", () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const huge = rankScore({ verifiedGrams: 1e9, activeWeeksOf12: 0, upheldDisputes: 0, verifiedCollections: 0 }); assert.equal(huge.score, WEIGHTS.impact); assert.equal(rankFor(huge.score, ranks).code, "guardian");
});
test("rank score rewards consistency and reliability, and upheld disputes cost reliability", () => {
  const good = rankScore({ verifiedGrams: 500_000, activeWeeksOf12: 12, upheldDisputes: 0, verifiedCollections: 40 }); assert.equal(good.score, 70); assert.equal(rankFor(good.score, ranks).code, "eco_leader");
  assert.ok(rankScore({ verifiedGrams: 500_000, activeWeeksOf12: 12, upheldDisputes: 2, verifiedCollections: 40 }).score < good.score);
  assert.equal(rankScore({ verifiedGrams: 0, activeWeeksOf12: 0, upheldDisputes: 9, verifiedCollections: 50 }).parts.reliability, 0);
  assert.equal(rankFor(0, ranks).code, "newcomer");
});
test("automatic titles count only the stated materials", () => {
  assert.ok(titleEarned({ materials: ["PET", "PLS"], min_grams: 25000 }, { PET: 20000, PLS: 5000 }, 99999)); assert.ok(!titleEarned({ materials: ["PET", "PLS"], min_grams: 25000 }, { ALU: 90000 }, 90000));
  assert.ok(titleEarned({ min_grams: 1000 }, {}, 1000)); assert.ok(!titleEarned({}, {}, 5));
});
test("identity code can never post GREEN: no ledger, rewards or payout imports and no ledger writes", () => {
  for (const f of ["identityRules.ts", "identity.ts"]) { const p = path.join(import.meta.dirname, f); if (!fs.existsSync(p)) continue; const src = fs.readFileSync(p, "utf8");
    assert.ok(!/from\s+["']\.\/(ledger|rewards|redemption|commissions|payouts|adjust|commissionReversal)\.ts["']/.test(src), `${f} must not import money code`); assert.ok(!/INSERT INTO ledger_entries/i.test(src)); }
});
