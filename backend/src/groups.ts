import { Router } from "express";
import { z } from "zod";
import { safeCode } from "./httpErrors.ts";
import { randomInt } from "node:crypto";
import { pool, tx } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { parseId } from "./pickupRules.ts";
import { makeJoinCode, normalizeCode, rankGroups, MAX_GROUPS_PER_USER } from "./groupRules.ts";

/** Groups (societies, colleges, neighbourhoods) and events.
 *  Privacy: groups are joined by code only; who is in a group is visible only to its members; events show a going COUNT, never attendees;
 *  cross-group rankings hide groups under 3 members. Nothing here ever creates GREEN: rankings read verified weight, they do not write rewards. */
export const groups = Router();
const member = requireRole("individual", "collector");
const mod = adminOnly("moderator");
const name = "COALESCE(u.display_name,u.public_id)";
const days: Record<string, number> = { day: 1, week: 7, month: 30 };
const sinceOf = (period: unknown) => days[String(period)] ? new Date(Date.now() - days[String(period)] * 864e5) : new Date(0);
const audit = (c: { query: Function }, actor: string, action: string, detail: object) => c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [actor, action, detail]);
const isMember = async (gid: string, uid: string) => (await pool.query("SELECT 1 FROM community_members m JOIN communities c ON c.id=m.community_id WHERE m.community_id=$1 AND m.user_id=$2 AND c.active", [gid, uid])).rowCount! > 0;

// ---------- members ----------
groups.post("/groups/join", member, rateLimit(5, 60_000), async (req, res) => {
  const code = normalizeCode(req.body?.code); if (!code) return res.status(404).json({ error: "invalid_code" });
  try {
    const out = await tx(async c => {
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [req.auth!.sub]); // serialises this user's joins so the cap cannot be raced
      const g = (await c.query("SELECT id::text, name, kind FROM communities WHERE join_code=$1 AND active", [code])).rows[0];
      if (!g) throw new Error("invalid_code"); // same answer for unknown and deactivated codes
      const n = (await c.query("SELECT COUNT(*)::int n FROM community_members WHERE user_id=$1", [req.auth!.sub])).rows[0].n;
      const ins = await c.query("INSERT INTO community_members(community_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [g.id, req.auth!.sub]);
      if (ins.rowCount && n >= MAX_GROUPS_PER_USER) throw new Error("too_many_groups");
      return { ...g, alreadyMember: !ins.rowCount };
    });
    res.json(out);
  } catch (e: any) { const code = safeCode(e); res.status(code === "invalid_code" ? 404 : 409).json({ error: code }); }
});
groups.post("/groups/:id/leave", member, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
  await pool.query("DELETE FROM community_members WHERE community_id=$1 AND user_id=$2", [id, req.auth!.sub]); res.json({ ok: true });
});
groups.get("/me/groups", member, async (req, res) => {
  const r = await pool.query(`SELECT c.id::text, c.name, c.kind, (SELECT COUNT(*) FROM community_members x WHERE x.community_id=c.id)::int members
    FROM community_members m JOIN communities c ON c.id=m.community_id WHERE m.user_id=$1 AND c.active ORDER BY m.joined_at DESC`, [req.auth!.sub]);
  res.json(r.rows);
});
// Cross-group ranking: public to signed-in members, aggregate only, groups under 3 members hidden. Declared BEFORE /groups/:id.
groups.get("/groups/leaderboard", member, async (req, res) => {
  const r = await pool.query(`SELECT c.id::text, c.name, c.kind, COUNT(DISTINCT m.user_id)::int members, COALESCE(SUM(col.accepted_grams),0)::int grams,
    EXISTS(SELECT 1 FROM community_members me WHERE me.community_id=c.id AND me.user_id=$2) mine
    FROM communities c JOIN community_members m ON m.community_id=c.id
    LEFT JOIN collections col ON col.household_id=m.user_id AND col.state='approved' AND col.created_at>=$1
    WHERE c.active AND ($3::text IS NULL OR c.kind=$3) GROUP BY c.id`, [sinceOf(req.query.period), req.auth!.sub,
      ["society", "college", "neighbourhood"].includes(String(req.query.kind)) ? String(req.query.kind) : null]);
  res.json(rankGroups(r.rows).slice(0, 50));
});
// Members only (404 for everyone else, so group existence is not revealed). Ranks members by verified weight in the period.
groups.get("/groups/:id", member, async (req, res) => {
  const id = parseId(req.params.id); if (!id || !(await isMember(id, req.auth!.sub))) return res.status(404).json({ error: "not_found" });
  const [g, board] = await Promise.all([
    pool.query(`SELECT c.id::text, c.name, c.kind, (SELECT COUNT(*) FROM community_members x WHERE x.community_id=c.id)::int members,
      COALESCE((SELECT SUM(col.accepted_grams) FROM community_members x JOIN collections col ON col.household_id=x.user_id AND col.state='approved' AND col.created_at>=$2
        WHERE x.community_id=c.id),0)::int total_grams FROM communities c WHERE c.id=$1`, [id, sinceOf(req.query.period)]),
    pool.query(`SELECT u.public_id, ${name} name, COALESCE(SUM(col.accepted_grams),0)::int grams, (u.id=$3) mine
      FROM community_members m JOIN users u ON u.id=m.user_id
      LEFT JOIN collections col ON col.household_id=u.id AND col.state='approved' AND col.created_at>=$2
      WHERE m.community_id=$1 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$3 AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=$3))
      GROUP BY u.id ORDER BY grams DESC, name LIMIT 100`, [id, sinceOf(req.query.period), req.auth!.sub])]);
  res.json({ ...g.rows[0], board: board.rows });
});

// ---------- events ----------
const visibleEvent = `NOT e.cancelled AND e.starts_at > now() - interval '3 hours' AND (e.community_id IS NULL OR
  (EXISTS(SELECT 1 FROM community_members m WHERE m.community_id=e.community_id AND m.user_id=$1) AND EXISTS(SELECT 1 FROM communities c WHERE c.id=e.community_id AND c.active)))`;
groups.get("/events", member, async (req, res) => {
  const r = await pool.query(`SELECT e.id::text, e.title, e.description, e.location_text, e.starts_at, c.name group_name,
    (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id)::int going,
    EXISTS(SELECT 1 FROM event_rsvps r WHERE r.event_id=e.id AND r.user_id=$1) going_me
    FROM events e LEFT JOIN communities c ON c.id=e.community_id WHERE ${visibleEvent} ORDER BY e.starts_at LIMIT 50`, [req.auth!.sub]);
  res.json(r.rows);
});
groups.post("/events/:id/rsvp", member, async (req, res) => {
  const id = parseId(req.params.id), b = z.object({ going: z.boolean() }).safeParse(req.body); if (!id || !b.success) return res.status(400).json({ error: "invalid" });
  const ok = await pool.query(`SELECT 1 FROM events e WHERE e.id=$2 AND ${visibleEvent}`, [req.auth!.sub, id]); if (!ok.rowCount) return res.status(404).json({ error: "not_found" });
  b.data.going ? await pool.query("INSERT INTO event_rsvps VALUES($1,$2) ON CONFLICT DO NOTHING", [id, req.auth!.sub]) : await pool.query("DELETE FROM event_rsvps WHERE event_id=$1 AND user_id=$2", [id, req.auth!.sub]);
  res.json({ going: b.data.going });
});

// ---------- moderator/admin ----------
groups.post("/admin/groups", mod, async (req, res) => {
  const b = z.object({ name: z.string().trim().min(3).max(60), kind: z.enum(["society", "college", "neighbourhood"]) }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  for (let i = 0; i < 5; i++) {
    try {
      const r = await pool.query("INSERT INTO communities(name,kind,join_code,created_by) VALUES($1,$2,$3,$4) RETURNING id::text, name, kind, join_code", [b.data.name, b.data.kind, makeJoinCode(randomInt), req.auth!.sub]);
      await audit(pool, req.auth!.sub, "group.create", { id: r.rows[0].id, name: b.data.name }); return res.status(201).json(r.rows[0]);
    } catch (e: any) { if (e.code !== "23505") throw e; } // code collision: try another
  }
  res.status(500).json({ error: "code_generation_failed" });
});
groups.get("/admin/groups", mod, async (_req, res) => {
  res.json((await pool.query(`SELECT c.id::text, c.name, c.kind, c.join_code, c.active, (SELECT COUNT(*) FROM community_members m WHERE m.community_id=c.id)::int members FROM communities c ORDER BY c.id DESC LIMIT 200`)).rows);
});
groups.post("/admin/groups/:id/rotate-code", mod, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
  for (let i = 0; i < 5; i++) {
    try {
      const r = await pool.query("UPDATE communities SET join_code=$1 WHERE id=$2 RETURNING join_code", [makeJoinCode(randomInt), id]); // existing members stay; the old code stops working
      if (!r.rowCount) return res.status(404).json({ error: "not_found" });
      await audit(pool, req.auth!.sub, "group.rotate_code", { id }); return res.json(r.rows[0]);
    } catch (e: any) { if (e.code !== "23505") throw e; }
  }
  res.status(500).json({ error: "code_generation_failed" });
});
groups.post("/admin/groups/:id/active", mod, async (req, res) => {
  const id = parseId(req.params.id), b = z.object({ active: z.boolean() }).safeParse(req.body); if (!id || !b.success) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("UPDATE communities SET active=$1 WHERE id=$2", [b.data.active, id]); if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  await audit(pool, req.auth!.sub, "group.active", { id, active: b.data.active }); res.json({ ok: true });
});
groups.post("/admin/events", mod, async (req, res) => {
  const b = z.object({ communityId: z.string().nullable().optional(), title: z.string().trim().min(3).max(100), description: z.string().trim().max(500).optional(),
    locationText: z.string().trim().max(120).optional(), startsAt: z.string().datetime() }).safeParse(req.body);
  if (!b.success || new Date(b.data.startsAt) <= new Date()) return res.status(400).json({ error: "invalid" });
  const gid = b.data.communityId == null ? null : parseId(b.data.communityId); if (b.data.communityId != null && !gid) return res.status(400).json({ error: "invalid" });
  try {
    const out = await tx(async c => {
      if (gid && !(await c.query("SELECT 1 FROM communities WHERE id=$1 AND active", [gid])).rowCount) throw new Error("group_not_found");
      const e = (await c.query("INSERT INTO events(community_id,title,description,location_text,starts_at,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text",
        [gid, b.data.title, b.data.description ?? null, b.data.locationText ?? null, b.data.startsAt, req.auth!.sub])).rows[0];
      if (gid) await c.query("INSERT INTO notifications(user_id,kind,title,body) SELECT user_id,'event','New event',$2 FROM community_members WHERE community_id=$1", [gid, b.data.title]);
      await audit(c, req.auth!.sub, "event.create", { id: e.id, group: gid }); return e;
    });
    res.status(201).json(out);
  } catch (e: any) { if (e.message === "group_not_found") return res.status(404).json({ error: "group_not_found" }); throw e; }
});
groups.get("/admin/events", mod, async (_req, res) => {
  res.json((await pool.query(`SELECT e.id::text, e.title, e.starts_at, e.location_text, e.cancelled, c.name group_name, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id=e.id)::int going
    FROM events e LEFT JOIN communities c ON c.id=e.community_id WHERE e.starts_at > now() - interval '30 days' ORDER BY e.starts_at DESC LIMIT 100`)).rows);
});
groups.post("/admin/events/:id/cancel", mod, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("UPDATE events SET cancelled=true WHERE id=$1 AND NOT cancelled RETURNING community_id, title", [id]); if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  if (r.rows[0].community_id) await pool.query("INSERT INTO notifications(user_id,kind,title,body) SELECT user_id,'event','Event cancelled',$2 FROM community_members WHERE community_id=$1", [r.rows[0].community_id, r.rows[0].title]);
  await audit(pool, req.auth!.sub, "event.cancel", { id }); res.json({ ok: true });
});
