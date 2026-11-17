import { Router } from "express";
import { z } from "zod";
import type pg from "pg";
import { pool } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { notify } from "./notify.ts";
import { levelFor, rankFor, rankScore, titleEarned, xpForGrams, capXp, type Signals, type TitleCriteria } from "./identityRules.ts";
// NOTE: deliberately no ledger/rewards imports. XP, levels, ranks and titles are reputation; they can never move GREEN (a test enforces this).

type Q = pg.Pool | pg.PoolClient;
const audienceOf = (role: string) => (role === "individual" || role === "collector" ? role : null);

/** XP for one APPROVED, recycler-verified collection. Idempotent per (rule, collection, user). Daily cap counts what the user already earned today.
 *  Call inside the approval transaction. Unverified or declared-only weight never reaches here. */
export async function awardXpForCollection(c: pg.PoolClient, collectionId: string) {
  const x = (await c.query("SELECT id, household_id, collector_id, accepted_grams, state FROM collections WHERE id=$1", [collectionId])).rows[0];
  if (!x || x.state !== "approved" || !(x.accepted_grams > 0)) return;
  for (const [uid, audience] of [[x.household_id, "individual"], [x.collector_id, "collector"]] as const) {
    const rule = (await c.query("SELECT code,version,grams_per_xp,daily_cap_xp FROM xp_rules WHERE audience=$1 AND active", [audience])).rows[0]; if (!rule) continue;
    const key = `xp:${rule.code}:${collectionId}:${uid}`;
    if ((await c.query("SELECT 1 FROM xp_ledger WHERE idempotency_key=$1", [key])).rowCount) continue;
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [uid]); // serialises the daily-cap check per user
    const today = Number((await c.query("SELECT COALESCE(SUM(xp),0)::int s FROM xp_ledger WHERE user_id=$1 AND audience=$2 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')", [uid, audience])).rows[0].s);
    const xp = capXp(xpForGrams(x.accepted_grams, rule.grams_per_xp), today, rule.daily_cap_xp);
    const before = await totalXp(c, uid, audience);
    if (xp > 0) await c.query("INSERT INTO xp_ledger(user_id,audience,rule_code,rule_version,xp,collection_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7)", [uid, audience, rule.code, rule.version, xp, collectionId, key]);
    if (xp > 0) await announceLevelUp(c, uid, before, before + xp);
    await awardAutomaticTitles(c, uid, audience);
  }
}
/** Reverses XP when a reward is reversed (full or partial): a negative row per original row, proportional to the reward reversed. Idempotent. */
export async function reverseXpForCollection(c: pg.PoolClient, collectionId: string, reversedGreen: number, awardedGreen: number, key: string) {
  if (reversedGreen <= 0 || awardedGreen <= 0) return;
  const rows = (await c.query(`SELECT x.id,x.user_id,x.audience,x.rule_code,x.rule_version,x.xp,
      COALESCE((SELECT SUM(-r.xp) FROM xp_ledger r WHERE r.reverses_id=x.id),0)::int already FROM xp_ledger x WHERE x.collection_id=$1 AND x.xp>0 AND x.reverses_id IS NULL`, [collectionId])).rows;
  for (const r of rows) {
    const cumulative = Math.min(r.xp, Math.ceil((r.xp * (reversedGreen >= awardedGreen ? awardedGreen : reversedGreen)) / awardedGreen)), amount = Math.min(r.xp - r.already, cumulative);
    if (amount > 0) await c.query("INSERT INTO xp_ledger(user_id,audience,rule_code,rule_version,xp,collection_id,reverses_id,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING",
      [r.user_id, r.audience, r.rule_code, r.rule_version, -amount, collectionId, r.id, `${key}:${r.id}`]);
  }
}
const totalXp = async (q: Q, uid: string, audience: string) => Number((await q.query("SELECT COALESCE(SUM(xp),0)::int s FROM xp_ledger WHERE user_id=$1 AND audience=$2", [uid, audience])).rows[0].s);
async function announceLevelUp(c: pg.PoolClient, uid: string, before: number, after: number) {
  const levels = (await c.query("SELECT level,xp_required FROM identity_levels")).rows; const a = levelFor(before, levels).level, b = levelFor(after, levels).level;
  if (b > a) await notify(c, uid, "identity", "Level up", `You reached level ${b} through verified environmental activity.`); // server-controlled; clients cannot create achievements
}
async function activityStreak(q: Q, uid: string) {
  const days = (await q.query(`SELECT DISTINCT activity_day FROM (
      SELECT to_char(approved_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') activity_day
      FROM collections WHERE (household_id=$1 OR collector_id=$1) AND state='approved' AND accepted_grams>0 AND approved_at IS NOT NULL
      UNION ALL
      SELECT to_char(verified_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') activity_day
      FROM campaign_attendance WHERE user_id=$1 AND status='verified' AND verified_at IS NOT NULL
    ) a WHERE activity_day IS NOT NULL ORDER BY activity_day DESC LIMIT 500`, [uid])).rows.map((x: any) => String(x.activity_day));
  const today = String((await q.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') today")).rows[0].today);
  const set = new Set(days), dayMs = 86_400_000;
  const asUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const latest = days[0] ?? null;
  const current = latest && (asUtc(today) - asUtc(latest)) / dayMs <= 1
    ? (() => { let n = 0, cursor = asUtc(latest); while (set.has(new Date(cursor).toISOString().slice(0,10))) { n++; cursor -= dayMs; } return n; })() : 0;
  let best = 0, run = 0, previous = -1;
  for (const d of [...days].sort()) { const n = asUtc(d); run = previous >= 0 && n - previous === dayMs ? run + 1 : 1; best = Math.max(best, run); previous = n; }
  return { current, best, lastActivityDate: latest, timezone: "Asia/Kolkata" };
}

export async function awardXpForCampaignAttendance(c: pg.PoolClient, attendanceId: string, userId: string) {
  const u = (await c.query("SELECT role FROM users WHERE id=$1 AND deleted_at IS NULL",[userId])).rows[0];
  const audience = u?.role === "individual" ? "individual" : u?.role === "collector" ? "collector" : null;
  if (!audience) return;
  const code = audience === "individual" ? "volunteer_verified" : "volunteer_verified_collector";
  const rule = (await c.query("SELECT code,version,fixed_xp,daily_cap_xp FROM xp_rules WHERE code=$1 AND active AND fixed_xp IS NOT NULL",[code])).rows[0];
  if (!rule || Number(rule.fixed_xp) <= 0) return;
  await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
  const key = `xp:volunteer_verified:${attendanceId}:${userId}`;
  if ((await c.query("SELECT 1 FROM xp_ledger WHERE idempotency_key=$1", [key])).rowCount) return;
  const today = Number((await c.query("SELECT COALESCE(SUM(xp),0)::int s FROM xp_ledger WHERE user_id=$1 AND audience=$2 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')", [userId,audience])).rows[0].s);
  const award = Math.min(Number(rule.fixed_xp), Math.max(0, Number(rule.daily_cap_xp) - today));
  if (award <= 0) return;
  const before = await totalXp(c, userId, audience);
  await c.query(`INSERT INTO xp_ledger(user_id,audience,rule_code,rule_version,xp,collection_id,source_kind,source_id,idempotency_key)
    VALUES($1,$2,$3,$4,$5,NULL,'campaign_attendance',$6,$7)`, [userId, audience, rule.code, rule.version, award, attendanceId, key]);
  await announceLevelUp(c, userId, before, before + award);
}

async function statsFor(q: Q, uid: string, audience: "individual" | "collector") {
  const col = audience === "individual" ? "household_id" : "collector_id";
  const [m, w, d, n] = await Promise.all([
    q.query(`SELECT material_id, SUM(accepted_grams)::bigint g FROM collections WHERE ${col}=$1 AND state='approved' AND accepted_grams>0 GROUP BY 1`, [uid]),
    q.query(`SELECT COUNT(DISTINCT date_trunc('week', created_at))::int w FROM collections WHERE ${col}=$1 AND state='approved' AND accepted_grams>0 AND created_at >= now() - interval '12 weeks'`, [uid]),
    q.query(`SELECT COUNT(*)::int n FROM disputes d JOIN collections c ON c.id=d.collection_id WHERE d.state='upheld' AND c.${col}=$1 AND d.raised_by<>$1`, [uid]),
    q.query(`SELECT COUNT(*)::int n FROM collections WHERE ${col}=$1 AND state='approved' AND accepted_grams>0`, [uid])]);
  const byMaterial = Object.fromEntries(m.rows.map(r => [r.material_id, Number(r.g)])); const totalGrams = Object.values(byMaterial).reduce((a, b) => a + b, 0);
  return { byMaterial, totalGrams, signals: { verifiedGrams: totalGrams, activeWeeksOf12: w.rows[0].w, upheldDisputes: d.rows[0].n, verifiedCollections: n.rows[0].n } as Signals };
}
/** Titles with automatic criteria. Recorded once; later reversals do not silently strip a title (admins correct fraud via revoke). */
export async function awardAutomaticTitles(q: pg.PoolClient, uid: string, audience: "individual" | "collector") {
  const titles = (await q.query("SELECT id,name,criteria FROM identity_titles WHERE active AND award_mode='automatic' AND $1=ANY(eligible_roles)", [audience])).rows; if (!titles.length) return;
  const st = await statsFor(q, uid, audience);
  for (const t of titles) if (titleEarned(t.criteria as TitleCriteria, st.byMaterial, st.totalGrams)) {
    const r = await q.query("INSERT INTO user_titles(user_id,title_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING title_id", [uid, t.id]);
    if (r.rowCount) await notify(q as pg.PoolClient, uid, "identity", "New title", `You earned the title "${t.name}" from verified recycling.`);
  }
}

export const identity = Router();
const member = requireRole("individual", "collector");
identity.get("/me/identity", member, async (req, res) => {
  const uid = req.auth!.sub, audience = audienceOf(req.auth!.role)!;
  const [levels, ranks, xp, st, titles, badges, hist, me, streak] = await Promise.all([
    pool.query("SELECT level,xp_required FROM identity_levels"), pool.query("SELECT code,name,position,min_score FROM identity_ranks"), totalXp(pool, uid, audience), statsFor(pool, uid, audience),
    pool.query("SELECT t.id,t.name,t.description,ut.awarded_at,ut.displayed FROM user_titles ut JOIN identity_titles t ON t.id=ut.title_id WHERE ut.user_id=$1 AND ut.revoked_at IS NULL ORDER BY ut.awarded_at", [uid]),
    pool.query("SELECT badge_id,earned_at FROM user_badges WHERE user_id=$1 ORDER BY earned_at", [uid]), // existing badges, read as-is
    pool.query("SELECT xp, rule_code, created_at FROM xp_ledger WHERE user_id=$1 AND audience=$2 ORDER BY id DESC LIMIT 30", [uid, audience]),
    pool.query("SELECT leaderboard_opt_out FROM users WHERE id=$1", [uid]), activityStreak(pool, uid)]);
  const rs = rankScore(st.signals), rank = rankFor(rs.score, ranks.rows as any), lv = levelFor(xp, levels.rows as any);
  const next = [...ranks.rows].sort((a, b) => a.position - b.position).find(r => r.position === rank.position + 1) ?? null;
  res.json({ audience, level: lv, rank: { code: rank.code, name: rank.name, score: rs.score, parts: rs.parts, nextRank: next ? { name: next.name, minScore: next.min_score } : null },
    verifiedGrams: st.totalGrams, titles: titles.rows, badges: badges.rows, history: hist.rows, leaderboardOptOut: me.rows[0].leaderboard_opt_out, streak });
});
// Share cards are generated from authoritative identity data. Clients cannot submit fabricated XP, ranks or title claims.
identity.post("/me/identity/share", member, rateLimit(5, 60_000), async (req, res) => {
  const b = z.object({ kind: z.enum(["level", "rank", "title"]), titleId: z.string().regex(/^[a-z0-9_]{3,40}$/).optional() }).safeParse(req.body);
  if (!b.success || (b.data.kind === "title") !== !!b.data.titleId) return res.status(400).json({ error: "invalid" });
  const uid = req.auth!.sub, audience = audienceOf(req.auth!.role)!;
  let body = "";
  if (b.data.kind === "title") {
    const title = (await pool.query(`SELECT t.name,t.description FROM user_titles ut JOIN identity_titles t ON t.id=ut.title_id
      WHERE ut.user_id=$1 AND ut.title_id=$2 AND ut.revoked_at IS NULL`, [uid,b.data.titleId])).rows[0];
    if (!title) return res.status(409).json({ error: "title_not_held" });
    body = `I earned the “${title.name}” Green Identity title on GREENLOOP. ${title.description}`;
  } else {
    const [levels,ranks,xp,st] = await Promise.all([pool.query("SELECT level,xp_required FROM identity_levels"),pool.query("SELECT code,name,position,min_score FROM identity_ranks"),totalXp(pool,uid,audience),statsFor(pool,uid,audience)]);
    if (b.data.kind === "level") { const lv = levelFor(xp,levels.rows as any); body = `I reached Green Identity Level ${lv.level} on GREENLOOP with ${xp.toLocaleString("en-IN")} verified-impact XP.`; }
    else { const rs = rankScore(st.signals), rank = rankFor(rs.score,ranks.rows as any); body = `My Green Identity rank is ${rank.name} on GREENLOOP, earned through verified environmental activity.`; }
  }
  const out = await pool.query("INSERT INTO posts(user_id,kind,body) VALUES($1,'achievement',$2) RETURNING id::text",[uid,body]);
  res.status(201).json({ ok:true, postId:out.rows[0].id, body });
});
// Display choice only: a user can show or hide titles they already hold, and opt out of public leaderboards. They cannot grant anything.
identity.post("/me/identity/titles/:id/display", member, async (req, res) => {
  const b = z.object({ displayed: z.boolean() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("UPDATE user_titles SET displayed=$1 WHERE user_id=$2 AND title_id=$3 AND revoked_at IS NULL RETURNING title_id", [b.data.displayed, req.auth!.sub, req.params.id]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "title_not_held" });
});
identity.post("/me/identity/leaderboard", member, async (req, res) => {
  const b = z.object({ optOut: z.boolean() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  await pool.query("UPDATE users SET leaderboard_opt_out=$1 WHERE id=$2", [b.data.optOut, req.auth!.sub]); res.json({ ok: true });
});
// Leaderboards (live, scoped to India / your state / your city, and frozen history) live in identityRankings.ts.

// Admin: configuration and title management. Rules are versioned: a change adds a new version and retires the old one; old XP rows keep their version.
export const identityAdmin = Router();
identityAdmin.get("/admin/identity/config", adminOnly(), async (_req, res) => {
  const [rules, levels, ranks, titles] = await Promise.all([pool.query("SELECT code,version,audience,grams_per_xp,fixed_xp,daily_cap_xp,active,note FROM xp_rules ORDER BY code,version"), pool.query("SELECT level,xp_required FROM identity_levels ORDER BY level"),
    pool.query("SELECT code,name,position,min_score FROM identity_ranks ORDER BY position"), pool.query("SELECT id,name,description,eligible_roles,award_mode,criteria,verification,active FROM identity_titles ORDER BY id")]);
  res.json({ rules: rules.rows, levels: levels.rows, ranks: ranks.rows, titles: titles.rows });
});
identityAdmin.post("/admin/identity/rules", adminOnly(), async (req, res) => {
  const b = z.object({ code: z.string().regex(/^[a-z0-9_]{3,40}$/), gramsPerXp: z.number().int().min(1).max(100000), fixedXp: z.number().int().min(1).max(10000).nullable().optional(), dailyCapXp: z.number().int().min(1).max(10000), note: z.string().max(200).optional() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); const cur = (await c.query("SELECT version,audience,fixed_xp FROM xp_rules WHERE code=$1 AND active FOR UPDATE", [b.data.code])).rows[0];
    if (!cur) { await c.query("ROLLBACK"); return res.status(404).json({ error: "unknown_rule" }); }
    await c.query("UPDATE xp_rules SET active=false WHERE code=$1 AND version=$2", [b.data.code, cur.version]);
    await c.query("INSERT INTO xp_rules(code,version,audience,grams_per_xp,fixed_xp,daily_cap_xp,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [b.data.code, cur.version + 1, cur.audience, b.data.gramsPerXp, b.data.fixedXp === undefined ? cur.fixed_xp : b.data.fixedXp, b.data.dailyCapXp, b.data.note ?? null, req.auth!.sub]);
    await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.rule',$2)", [req.auth!.sub, { ...b.data, version: cur.version + 1 }]); await c.query("COMMIT"); res.json({ ok: true, version: cur.version + 1 });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
});
// Admin-verified titles need a recorded evidence note. Revocation keeps the row (history) and records the reason.
identityAdmin.post("/admin/identity/titles/:id/award", adminOnly(), async (req, res) => {
  const b = z.object({ pid: z.string().max(40), note: z.string().min(10).max(300) }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const t = (await pool.query("SELECT id,name,award_mode,eligible_roles FROM identity_titles WHERE id=$1 AND active", [req.params.id])).rows[0]; if (!t) return res.status(404).json({ error: "unknown_title" });
  if (t.award_mode !== "admin_verified") return res.status(409).json({ error: "title_is_automatic" });
  const u = (await pool.query("SELECT id,role FROM users WHERE public_id=$1 AND deleted_at IS NULL", [b.data.pid])).rows[0]; if (!u || !t.eligible_roles.includes(u.role)) return res.status(409).json({ error: "not_eligible" });
  const r = await pool.query("INSERT INTO user_titles(user_id,title_id,awarded_by,evidence_note) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING title_id", [u.id, t.id, req.auth!.sub, b.data.note]);
  if (!r.rowCount) return res.status(409).json({ error: "already_awarded" });
  await pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.title.award',$2)", [req.auth!.sub, { pid: b.data.pid, title: t.id, note: b.data.note }]);
  await pool.query("INSERT INTO notifications(user_id,kind,title,body) VALUES($1,'identity','New title',$2)", [u.id, `You were awarded the title "${t.name}".`]); res.json({ ok: true });
});
identityAdmin.post("/admin/identity/titles/:id/revoke", adminOnly(), async (req, res) => {
  const b = z.object({ pid: z.string().max(40), reason: z.string().min(5).max(300) }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("UPDATE user_titles SET revoked_at=now(), revoke_reason=$3, displayed=false WHERE title_id=$2 AND revoked_at IS NULL AND user_id=(SELECT id FROM users WHERE public_id=$1) RETURNING user_id", [b.data.pid, req.params.id, b.data.reason]);
  if (!r.rowCount) return res.status(404).json({ error: "not_held" });
  await pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.title.revoke',$2)", [req.auth!.sub, { pid: b.data.pid, title: req.params.id, reason: b.data.reason }]); res.json({ ok: true });
});
