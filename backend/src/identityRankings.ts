import { Router } from "express";
import { z } from "zod";
import { pool } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { STATES, isStateCode, normalizeCity, scopeValue, lastCompletedPeriod, periodFromStartDate, validateLevels, validateRanks, validateTitle, MIN_GEO_PARTICIPANTS,
  type Period, type PeriodKind, type ScopeKind, type Location } from "./identityRankRules.ts";
// NOTE: deliberately no ledger/rewards imports. Rankings are reputation; nothing here can move GREEN (a test enforces this).

const member = requireRole("individual", "collector");
const audienceOf = (role: string) => (role === "individual" || role === "collector" ? role : null);
const NAME = "COALESCE(u.display_name, u.role_id, u.public_id)";
const scopeKindSchema = z.enum(["india", "state", "city"]).default("india");
export const viewerLocation = async (uid: string): Promise<Location & { city: string | null }> => {
  const r = (await pool.query("SELECT home_state, home_city, home_city_key FROM users WHERE id=$1", [uid])).rows[0];
  return { state: r?.home_state ?? null, city: r?.home_city ?? null, cityKey: r?.home_city_key ?? null };
};

/** Closes one period: stores the top 50 per audience and scope (India, each state and each city that has enough participants). Idempotent per (kind, start):
 *  a second call, a second server instance or a retry creates nothing. Rows are never edited afterwards. */
export async function generateSnapshot(kind: PeriodKind, p: Period, createdBy: string | null) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const run = await c.query("INSERT INTO leaderboard_snapshot_runs(period_kind,period_start,period_end,created_by) VALUES($1,$2,$3,$4) ON CONFLICT (period_kind,period_start) DO NOTHING RETURNING id", [kind, p.start, p.end, createdBy]);
    if (!run.rowCount) { await c.query("ROLLBACK"); const ex = await pool.query("SELECT id FROM leaderboard_snapshot_runs WHERE period_kind=$1 AND period_start=$2", [kind, p.start]); return { created: false, runId: String(ex.rows[0]?.id ?? ""), rows: 0 }; }
    const runId = run.rows[0].id; let rows = 0;
    for (const audience of ["individual", "collector"] as const) {
      const r = await c.query(`WITH base AS (
          SELECT u.id user_id, u.home_state, u.home_city_key, SUM(x.xp)::int xp FROM xp_ledger x JOIN users u ON u.id=x.user_id
          WHERE x.audience=$1 AND x.created_at >= $2 AND x.created_at < $3 AND u.leaderboard_opt_out=false AND u.deleted_at IS NULL GROUP BY u.id HAVING SUM(x.xp) > 0),
        scoped AS (
          SELECT 'india'::text scope_kind, ''::text scope_value, user_id, xp FROM base
          UNION ALL SELECT 'state', home_state, user_id, xp FROM base WHERE home_state IS NOT NULL
          UNION ALL SELECT 'city', home_state||':'||home_city_key, user_id, xp FROM base WHERE home_state IS NOT NULL AND home_city_key IS NOT NULL),
        ranked AS (SELECT scope_kind, scope_value, user_id, xp, COUNT(*) OVER w n, ROW_NUMBER() OVER (w ORDER BY xp DESC, user_id) pos FROM scoped WINDOW w AS (PARTITION BY scope_kind, scope_value))
        INSERT INTO leaderboard_snapshots(run_id,audience,scope_kind,scope_value,user_id,position,xp,participants)
        SELECT $4::bigint,$1::text,scope_kind,scope_value,user_id,pos::int,xp,n::int FROM ranked WHERE pos <= 50 AND (scope_kind='india' OR n >= $5::int)`, [audience, p.start, p.end, runId, MIN_GEO_PARTICIPANTS]);
      rows += r.rowCount ?? 0;
    }
    await c.query("COMMIT"); return { created: true, runId: String(runId), rows };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
/** Hourly check that the most recent finished week and month have a snapshot. Safe on several instances (the unique run key decides). Off in tests or with SNAPSHOT_AUTO=false. */
export function startSnapshotWorker() {
  if (process.env.NODE_ENV === "test" || process.env.SNAPSHOT_AUTO === "false") return;
  const tick = async () => { for (const kind of ["weekly", "monthly"] as const) { try { await generateSnapshot(kind, lastCompletedPeriod(kind, new Date()), null); } catch (e) { console.error("snapshot worker", kind, (e as Error).message); } } };
  setTimeout(tick, 30_000).unref(); setInterval(tick, 3_600_000).unref();
}

export const identityRankings = Router();
// ---- location: coarse, optional, self-declared. It only places the person on state and city boards.
identityRankings.get("/me/identity/location", member, async (req, res) => {
  const l = await viewerLocation(req.auth!.sub); res.json({ stateCode: l.state, stateName: l.state ? STATES[l.state] : null, city: l.city, states: Object.entries(STATES).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name)), minParticipants: MIN_GEO_PARTICIPANTS });
});
identityRankings.post("/me/identity/location", member, rateLimit(10, 60_000), async (req, res) => {
  const b = z.object({ stateCode: z.string().max(2).nullable(), city: z.string().max(80).nullable().optional() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const { stateCode } = b.data; if (stateCode === null) { await pool.query("UPDATE users SET home_state=NULL, home_city=NULL, home_city_key=NULL WHERE id=$1", [req.auth!.sub]); return res.json({ ok: true }); }
  if (!isStateCode(stateCode)) return res.status(400).json({ error: "invalid_state" });
  let city: { city: string; key: string } | null = null; if (b.data.city !== null && b.data.city !== undefined && b.data.city.trim() !== "") { city = normalizeCity(b.data.city); if (!city) return res.status(400).json({ error: "invalid_city" }); }
  await pool.query("UPDATE users SET home_state=$2, home_city=$3, home_city_key=$4 WHERE id=$1", [req.auth!.sub, stateCode, city?.city ?? null, city?.key ?? null]); res.json({ ok: true });
});

// ---- live leaderboard with a scope. State and city boards use the viewer's own declared area, so nobody can probe another town's board.
identityRankings.get("/leaderboard/:audience", member, async (req, res) => {
  const aud = req.params.audience, period = String(req.query.period ?? "monthly"); const PERIOD: Record<string, string | null> = { weekly: "7 days", monthly: "30 days", yearly: "365 days", lifetime: null };
  if (aud !== "individual" && aud !== "collector") return res.status(400).json({ error: "invalid_audience" }); if (!(period in PERIOD)) return res.status(400).json({ error: "invalid_period" });
  const sk = scopeKindSchema.safeParse(req.query.scope ?? undefined); if (!sk.success) return res.status(400).json({ error: "invalid_scope" });
  const kind: ScopeKind = sk.data, loc = await viewerLocation(req.auth!.sub), sv = scopeValue(kind, loc); if (sv === null) return res.status(409).json({ error: "location_not_set", scope: kind });
  const r = await pool.query(`WITH b AS (SELECT u.id, ${NAME} name, SUM(x.xp)::int xp FROM xp_ledger x JOIN users u ON u.id=x.user_id
      WHERE x.audience=$1 AND u.leaderboard_opt_out=false AND u.deleted_at IS NULL AND ($2::text IS NULL OR x.created_at >= now() - $2::interval)
        AND ($4='india' OR ($4='state' AND u.home_state=$5) OR ($4='city' AND u.home_state||':'||u.home_city_key=$5))
      GROUP BY u.id HAVING SUM(x.xp) > 0)
    SELECT name, xp, (id=$3) me, COUNT(*) OVER()::int n FROM b ORDER BY xp DESC, id LIMIT 50`, [aud, PERIOD[period], req.auth!.sub, kind, sv]);
  const n = r.rows[0]?.n ?? 0; if (kind !== "india" && n < MIN_GEO_PARTICIPANTS) return res.json({ audience: aud, period, scope: kind, entries: [], reason: "too_few_participants", minParticipants: MIN_GEO_PARTICIPANTS });
  res.json({ audience: aud, period, scope: kind, participants: n, entries: r.rows.map((e, i) => ({ position: i + 1, name: e.name, xp: e.xp, me: e.me })) });
});

// ---- history: finished weeks and months, frozen when they were closed
const kindSchema = z.enum(["weekly", "monthly"]).default("monthly");
identityRankings.get("/leaderboard/:audience/snapshots", member, async (req, res) => {
  const k = kindSchema.safeParse(req.query.kind ?? undefined); if (!k.success || !audienceOf(req.params.audience)) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("SELECT id::text, period_start, period_end FROM leaderboard_snapshot_runs WHERE period_kind=$1 ORDER BY period_start DESC LIMIT 12", [k.data]);
  res.json({ kind: k.data, runs: r.rows.map(x => ({ id: x.id, periodStart: x.period_start, periodEnd: x.period_end })) });
});
identityRankings.get("/leaderboard/:audience/snapshots/:id", member, async (req, res) => {
  const aud = req.params.audience, sk = scopeKindSchema.safeParse(req.query.scope ?? undefined); if ((aud !== "individual" && aud !== "collector") || !sk.success || !/^\d{1,15}$/.test(req.params.id)) return res.status(400).json({ error: "invalid" });
  const run = (await pool.query("SELECT id,period_kind,period_start,period_end FROM leaderboard_snapshot_runs WHERE id=$1", [req.params.id])).rows[0]; if (!run) return res.status(404).json({ error: "not_found" });
  const sv = scopeValue(sk.data, await viewerLocation(req.auth!.sub)); if (sv === null) return res.status(409).json({ error: "location_not_set", scope: sk.data });
  const r = await pool.query(`SELECT s.position, s.xp, s.participants, ${NAME} name, (u.id=$5) me FROM leaderboard_snapshots s JOIN users u ON u.id=s.user_id
    WHERE s.run_id=$1 AND s.audience=$2 AND s.scope_kind=$3 AND s.scope_value=$4 AND u.leaderboard_opt_out=false AND u.deleted_at IS NULL ORDER BY s.position`, [run.id, aud, sk.data, sv, req.auth!.sub]);
  res.json({ audience: aud, scope: sk.data, kind: run.period_kind, periodStart: run.period_start, periodEnd: run.period_end, participants: r.rows[0]?.participants ?? 0, entries: r.rows.map(e => ({ position: e.position, name: e.name, xp: e.xp, me: e.me })) });
});
// Your own finished-period results. Only the top 50 of each board are stored, so a missing period means you were outside the top 50 (or had no XP / were hidden).
identityRankings.get("/me/identity/rank-history", member, async (req, res) => {
  const k = kindSchema.safeParse(req.query.kind ?? undefined); if (!k.success) return res.status(400).json({ error: "invalid" });
  const r = await pool.query(`SELECT r.id::text run_id, r.period_start, r.period_end, s.scope_kind, s.position, s.xp, s.participants FROM leaderboard_snapshots s JOIN leaderboard_snapshot_runs r ON r.id=s.run_id
    WHERE s.user_id=$1 AND s.audience=$2 AND r.period_kind=$3 ORDER BY r.period_start DESC, s.scope_kind LIMIT 60`, [req.auth!.sub, audienceOf(req.auth!.role), k.data]);
  res.json({ kind: k.data, results: r.rows.map(x => ({ runId: x.run_id, periodStart: x.period_start, periodEnd: x.period_end, scope: x.scope_kind, position: x.position, xp: x.xp, participants: x.participants })) });
});

// ---- admin: snapshots and configuration. Super admin only. Every change is written to the audit log with the reason.
export const identityRankingsAdmin = Router();
identityRankingsAdmin.get("/admin/identity/snapshots", adminOnly(), async (_req, res) => {
  const r = await pool.query(`SELECT r.id::text, r.period_kind, r.period_start, r.period_end, r.created_at, r.created_by IS NULL AS automatic, (SELECT COUNT(*)::int FROM leaderboard_snapshots s WHERE s.run_id=r.id) AS row_count FROM leaderboard_snapshot_runs r ORDER BY r.period_start DESC, r.period_kind LIMIT 60`);
  res.json(r.rows.map(x => ({ id: x.id, kind: x.period_kind, periodStart: x.period_start, periodEnd: x.period_end, createdAt: x.created_at, automatic: x.automatic, rows: x.row_count })));
});
identityRankingsAdmin.post("/admin/identity/snapshots", adminOnly(), rateLimit(10, 60_000), async (req, res) => {
  const b = z.object({ kind: z.enum(["weekly", "monthly"]), periodStart: z.string().max(10).optional() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const now = new Date(), p = b.data.periodStart ? periodFromStartDate(b.data.kind, b.data.periodStart, now) : lastCompletedPeriod(b.data.kind, now); if (!p) return res.status(400).json({ error: "invalid_period" });
  const out = await generateSnapshot(b.data.kind, p, req.auth!.sub);
  if (out.created) await pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.snapshot',$2)", [req.auth!.sub, { kind: b.data.kind, label: p.label, runId: out.runId, rows: out.rows }]);
  res.status(out.created ? 201 : 409).json(out.created ? { ok: true, ...out, label: p.label } : { error: "already_generated", runId: out.runId });
});
// Levels are computed live from XP, so a new curve takes effect immediately for everyone and nothing stored needs rewriting. Past XP is never touched.
identityRankingsAdmin.post("/admin/identity/levels", adminOnly(), rateLimit(10, 60_000), async (req, res) => {
  const b = z.object({ levels: z.array(z.object({ level: z.number().int(), xpRequired: z.number().int() })).max(200), reason: z.string().min(5).max(300) }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const bad = validateLevels(b.data.levels); if (bad) return res.status(400).json({ error: "invalid_levels", detail: bad });
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); const before = (await c.query("SELECT level,xp_required FROM identity_levels ORDER BY level FOR UPDATE")).rows;
    await c.query("DELETE FROM identity_levels"); await c.query("INSERT INTO identity_levels(level,xp_required) SELECT l, x FROM unnest($1::int[], $2::int[]) t(l, x)", [b.data.levels.map(l => l.level), b.data.levels.map(l => l.xpRequired)]);
    await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.levels',$2)", [req.auth!.sub, { reason: b.data.reason, before: before.map(x => x.xp_required), after: [...b.data.levels].sort((a, z) => a.level - z.level).map(x => x.xpRequired) }]); await c.query("COMMIT"); res.json({ ok: true, levels: b.data.levels.length });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
});
identityRankingsAdmin.post("/admin/identity/ranks", adminOnly(), rateLimit(10, 60_000), async (req, res) => {
  const b = z.object({ ranks: z.array(z.object({ code: z.string().max(30), name: z.string().max(60), minScore: z.number().int() })).max(20), reason: z.string().min(5).max(300) }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); const before = (await c.query("SELECT code,name,position,min_score FROM identity_ranks ORDER BY position FOR UPDATE")).rows;
    const bad = validateRanks(b.data.ranks, before); if (bad) { await c.query("ROLLBACK"); return res.status(400).json({ error: "invalid_ranks", detail: bad }); }
    for (const r of b.data.ranks) await c.query("UPDATE identity_ranks SET name=$2, min_score=$3 WHERE code=$1", [r.code, r.name.trim(), r.minScore]);
    await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.ranks',$2)", [req.auth!.sub, { reason: b.data.reason, before: before.map(x => ({ code: x.code, name: x.name, minScore: x.min_score })), after: b.data.ranks }]); await c.query("COMMIT"); res.json({ ok: true });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
});
const titleBody = { name: z.string().min(2).max(60), description: z.string().min(10).max(300), eligibleRoles: z.array(z.string().max(20)).max(5), verification: z.string().min(5).max(300),
  criteria: z.object({ materials: z.array(z.string().max(12)).max(10).optional(), min_grams: z.number().int().optional() }).strict() };
const unknownMaterials = async (m?: string[]) => !!m?.length && (await pool.query("SELECT id FROM materials WHERE id = ANY($1)", [m])).rows.length !== m.length;
identityRankingsAdmin.post("/admin/identity/titles", adminOnly(), rateLimit(20, 60_000), async (req, res) => {
  const b = z.object({ id: z.string().regex(/^[a-z0-9_]{3,40}$/), awardMode: z.enum(["automatic", "admin_verified"]), ...titleBody }).strict().safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const bad = validateTitle({ awardMode: b.data.awardMode, eligibleRoles: b.data.eligibleRoles, criteria: b.data.criteria }); if (bad) return res.status(400).json({ error: "invalid_title", detail: bad });
  if (await unknownMaterials(b.data.criteria.materials)) return res.status(400).json({ error: "unknown_material" });
  const r = await pool.query("INSERT INTO identity_titles(id,name,description,eligible_roles,award_mode,criteria,verification) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id", [b.data.id, b.data.name.trim(), b.data.description.trim(), b.data.eligibleRoles, b.data.awardMode, b.data.criteria, b.data.verification.trim()]);
  if (!r.rowCount) return res.status(409).json({ error: "title_exists" });
  await pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.title.create',$2)", [req.auth!.sub, b.data]); res.status(201).json({ ok: true });
});
// The id and award mode are fixed once a title exists. Holders keep a title if criteria change: a new bar applies to people evaluated from then on, and fraud is corrected by revoke.
identityRankingsAdmin.post("/admin/identity/titles/:id/update", adminOnly(), rateLimit(20, 60_000), async (req, res) => {
  const b = z.object({ ...Object.fromEntries(Object.entries(titleBody).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), active: z.boolean().optional(), reason: z.string().min(5).max(300) }).strict().safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const d = b.data as any, cur = (await pool.query("SELECT id,name,description,eligible_roles,award_mode,criteria,verification,active FROM identity_titles WHERE id=$1", [req.params.id])).rows[0]; if (!cur) return res.status(404).json({ error: "unknown_title" });
  const next = { name: (d.name ?? cur.name).trim(), description: (d.description ?? cur.description).trim(), eligibleRoles: d.eligibleRoles ?? cur.eligible_roles, criteria: d.criteria ?? cur.criteria, verification: (d.verification ?? cur.verification).trim(), active: d.active ?? cur.active };
  const bad = validateTitle({ awardMode: cur.award_mode, eligibleRoles: next.eligibleRoles, criteria: next.criteria }); if (bad) return res.status(400).json({ error: "invalid_title", detail: bad });
  if (await unknownMaterials(next.criteria.materials)) return res.status(400).json({ error: "unknown_material" });
  await pool.query("UPDATE identity_titles SET name=$2, description=$3, eligible_roles=$4, criteria=$5, verification=$6, active=$7 WHERE id=$1", [cur.id, next.name, next.description, next.eligibleRoles, next.criteria, next.verification, next.active]);
  await pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'identity.title.update',$2)", [req.auth!.sub, { id: cur.id, reason: d.reason, before: { name: cur.name, description: cur.description, eligibleRoles: cur.eligible_roles, criteria: cur.criteria, verification: cur.verification, active: cur.active }, after: next }]); res.json({ ok: true });
});
