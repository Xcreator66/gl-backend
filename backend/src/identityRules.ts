/** PURE. Green Identity maths. No imports from money code; nothing here can move GREEN (a test enforces it). */
export interface LevelRow { level: number; xp_required: number }
export interface RankRow { code: string; name: string; position: number; min_score: number }
export function levelFor(xp: number, levels: LevelRow[]) {
  const sorted = [...levels].sort((a, b) => a.level - b.level); const x = Math.max(0, Math.floor(xp));
  let cur = sorted[0]; for (const l of sorted) if (x >= l.xp_required) cur = l;
  const next = sorted.find(l => l.level === cur.level + 1) ?? null;
  return { level: cur.level, xp: x, levelStartXp: cur.xp_required, nextLevelXp: next?.xp_required ?? null,
    progressPct: next ? Math.floor(((x - cur.xp_required) * 100) / (next.xp_required - cur.xp_required)) : 100 };
}
/** XP for verified grams under a rule. Integer floor. */
export const xpForGrams = (grams: number, gramsPerXp: number) => (grams > 0 && gramsPerXp > 0 ? Math.floor(grams / gramsPerXp) : 0);
/** Anti-farming: XP already earned today counts against the cap. Returns the XP that may still be awarded. */
export const capXp = (wanted: number, earnedToday: number, dailyCap: number) => Math.max(0, Math.min(wanted, dailyCap - Math.max(0, earnedToday)));
/** Rank score 0-100 from six capped components. Weights sum to 100 and every component is capped at its own weight, so no single metric can
 *  dominate. Components that cannot be measured yet (community, leadership, volunteering) are 0, not guessed. */
export const WEIGHTS = { impact: 35, consistency: 20, reliability: 15, community: 10, leadership: 10, volunteering: 10 } as const;
export interface Signals { verifiedGrams: number; activeWeeksOf12: number; upheldDisputes: number; verifiedCollections: number }
export function rankScore(s: Signals) {
  const impact = Math.min(WEIGHTS.impact, Math.floor((WEIGHTS.impact * Math.log10(1 + Math.max(0, s.verifiedGrams) / 1000)) / Math.log10(1 + 500))); // 500 kg earns the full impact weight
  const consistency = Math.min(WEIGHTS.consistency, Math.floor((WEIGHTS.consistency * Math.min(12, Math.max(0, s.activeWeeksOf12))) / 12));
  const reliability = s.verifiedCollections < 3 ? 0 : Math.max(0, WEIGHTS.reliability - 5 * Math.max(0, s.upheldDisputes)); // needs a track record; each upheld dispute costs 5
  const parts = { impact, consistency, reliability, community: 0, leadership: 0, volunteering: 0 };
  return { score: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}
export function rankFor(score: number, ranks: RankRow[]) {
  const sorted = [...ranks].sort((a, b) => a.position - b.position); let cur = sorted[0]; for (const r of sorted) if (score >= r.min_score) cur = r; return cur;
}
/** Automatic title criteria. Only recycler-verified, approved weight counts. */
export interface TitleCriteria { materials?: string[]; min_grams?: number }
export function titleEarned(c: TitleCriteria, byMaterial: Record<string, number>, totalGrams: number) {
  const g = c.materials ? c.materials.reduce((a, m) => a + (byMaterial[m] ?? 0), 0) : totalGrams; return g >= (c.min_grams ?? Infinity);
}
