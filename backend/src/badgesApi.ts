import { Router } from "express";
import type pg from "pg";
import { pool } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { notify } from "./notify.ts";
import { evaluate, BADGE_IDS, CATALOGUE, type Audience, type Stats } from "./badges.ts";
// NOTE: deliberately no import of ledger.ts: badges and referrals can never move GREEN (a test enforces this).

type Q = pg.Pool | pg.PoolClient;
/** Verified weight only: collections the admin approved after independent weighing. Adjusted/reversed collections are excluded, so badges they supported disappear. */
export async function loadStats(q: Q, userId: string): Promise<Stats> {
  const [hh, mats, col] = await Promise.all([
    q.query("SELECT COALESCE(SUM(accepted_grams),0)::bigint g, COUNT(*)::int n FROM collections WHERE household_id=$1 AND state='approved' AND accepted_grams>0", [userId]),
    q.query("SELECT material_id, SUM(accepted_grams)::bigint g FROM collections WHERE household_id=$1 AND state='approved' AND accepted_grams>0 GROUP BY 1", [userId]),
    q.query("SELECT COALESCE(SUM(accepted_grams),0)::bigint g, COUNT(DISTINCT household_id)::int h FROM collections WHERE collector_id=$1 AND state='approved' AND accepted_grams>0", [userId])]);
  return { totalGrams: Number(hh.rows[0].g), collections: hh.rows[0].n, byMaterial: Object.fromEntries(mats.rows.map(r => [r.material_id, Number(r.g)])), handledGrams: Number(col.rows[0].g), households: col.rows[0].h };
}
const audienceOf = (role: string): Audience | null => role === "individual" ? "individual" : role === "collector" ? "collector" : null;
/** Records newly earned badges (idempotent) and optionally notifies. Call inside the approval transaction so it commits or rolls back with it. */
export async function awardBadges(q: Q, userId: string, role: string, opts: { notify: boolean } = { notify: true }) {
  const a = audienceOf(role); if (!a) return [];
  const earned = evaluate(await loadStats(q, userId), a).filter(b => b.earned);
  const fresh: typeof earned = [];
  for (const b of earned) {
    const r = await q.query("INSERT INTO user_badges(user_id,badge_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING badge_id", [userId, b.id]);
    if (r.rowCount) { fresh.push(b); if (opts.notify) await notify(q as pg.PoolClient, userId, "badge", "New badge", `You earned "${b.title}" from verified recycling.`); }
  }
  return fresh;
}

export const badgesApi = Router();
const member = requireRole("individual", "collector");
badgesApi.get("/me/badges", member, async (req, res) => {
  const role = req.auth!.role, a = audienceOf(role)!;
  await awardBadges(pool, req.auth!.sub, role, { notify: false }); // silently records badges earned before this feature existed
  const stats = await loadStats(pool, req.auth!.sub);
  const rec = new Map((await pool.query("SELECT badge_id, earned_at, shared_at FROM user_badges WHERE user_id=$1", [req.auth!.sub])).rows.map(r => [r.badge_id, r]));
  res.json({ verifiedGrams: a === "individual" ? stats.totalGrams : stats.handledGrams,
    badges: evaluate(stats, a).map(b => ({ ...b, earnedAt: b.earned ? rec.get(b.id)?.earned_at ?? null : null, shared: b.earned && !!rec.get(b.id)?.shared_at })) });
});
// The post text is built here from the catalogue; a client cannot supply it, and the badge must be currently earned. One share per badge.
badgesApi.post("/me/badges/:id/share", member, rateLimit(5, 60_000), async (req, res) => {
  const id = req.params.id, a = audienceOf(req.auth!.role)!;
  if (!BADGE_IDS.has(id)) return res.status(404).json({ error: "unknown_badge" });
  const b = evaluate(await loadStats(pool, req.auth!.sub), a).find(x => x.id === id);
  if (!b?.earned) return res.status(409).json({ error: "not_earned" });
  await awardBadges(pool, req.auth!.sub, req.auth!.role, { notify: false });
  const u = await pool.query("UPDATE user_badges SET shared_at=now() WHERE user_id=$1 AND badge_id=$2 AND shared_at IS NULL RETURNING badge_id", [req.auth!.sub, id]);
  if (!u.rowCount) return res.status(409).json({ error: "already_shared" });
  await pool.query("INSERT INTO posts(user_id,kind,body) VALUES($1,'achievement',$2)", [req.auth!.sub, `Earned the "${CATALOGUE.find(d => d.id === id)!.title}" badge from verified recycling on GREENLOOP`]);
  res.status(201).json({ ok: true });
});
