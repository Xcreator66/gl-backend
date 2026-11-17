import { Router } from "express";
import { tx, pool } from "./db.ts";
import { adminOnly } from "./adminAuth.ts";
import { parseId } from "./pickupRules.ts";
import { notify } from "./notify.ts";

/** Moderator tools for posts and comments. Reports only ever lead to a human decision; nothing here touches GREEN.
 *  Hide works only on visible content, restore only on content a moderator hid (never on what the author deleted or an erased account left behind). */
export const moderation = Router();
const mod = adminOnly("moderator");
const KINDS = { post: { table: "posts", reports: "reports", key: "post_id", label: "post" }, comment: { table: "comments", reports: "comment_reports", key: "comment_id", label: "comment" } } as const;
type Kind = keyof typeof KINDS;
const audit = (c: { query: Function }, actor: string, action: string, detail: object) => c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [actor, action, detail]);

// Open reports, most reported first. A report is "open" until a moderator hides the content or dismisses it.
moderation.get("/admin/reports", mod, async (_req, res) => {
  res.json((await pool.query(`SELECT p.id::text post_id, p.body, p.hidden, COUNT(*)::int reports, MAX(r.created_at) last_report
    FROM reports r JOIN posts p ON p.id=r.post_id WHERE r.resolved_at IS NULL GROUP BY p.id ORDER BY reports DESC, last_report DESC LIMIT 100`)).rows);
});
moderation.get("/admin/comment-reports", mod, async (_req, res) => {
  res.json((await pool.query(`SELECT c.id::text comment_id, c.post_id::text post_id, c.body, c.hidden, COUNT(*)::int reports, MAX(r.created_at) last_report
    FROM comment_reports r JOIN comments c ON c.id=r.comment_id WHERE r.resolved_at IS NULL GROUP BY c.id ORDER BY reports DESC, last_report DESC LIMIT 100`)).rows);
});
// What moderators have hidden, newest first, so a mistake can be undone.
moderation.get("/admin/hidden", mod, async (_req, res) => {
  res.json((await pool.query(`SELECT * FROM (
      SELECT 'post' kind, p.id::text id, p.body, p.mod_hidden_at FROM posts p WHERE p.mod_hidden_at IS NOT NULL AND p.hidden
      UNION ALL SELECT 'comment', c.id::text, c.body, c.mod_hidden_at FROM comments c WHERE c.mod_hidden_at IS NOT NULL AND c.hidden) t
    ORDER BY mod_hidden_at DESC LIMIT 100`)).rows);
});

for (const kind of Object.keys(KINDS) as Kind[]) {
  const k = KINDS[kind], path = `/admin/${k.table}/:id`;
  moderation.post(`${path}/hide`, mod, async (req, res) => {
    const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
    const out = await tx(async c => {
      const r = await c.query(`UPDATE ${k.table} SET hidden=true, mod_hidden_at=now() WHERE id=$1 AND NOT hidden RETURNING user_id`, [id]);
      if (!r.rowCount) return false; // missing, or already hidden (by its author or a moderator)
      await c.query(`UPDATE ${k.reports} SET resolved_at=now() WHERE ${k.key}=$1 AND resolved_at IS NULL`, [id]);
      await notify(c, r.rows[0].user_id, "moderation", "Content removed", `A moderator removed one of your ${k.label}s for not following the community rules.`);
      await audit(c, req.auth!.sub, `${k.label}.hide`, { [k.label]: id }); return true;
    });
    out ? res.json({ ok: true }) : res.status(404).json({ error: "not_found" });
  });
  moderation.post(`${path}/restore`, mod, async (req, res) => {
    const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
    const out = await tx(async c => {
      const r = await c.query(`UPDATE ${k.table} t SET hidden=false, mod_hidden_at=NULL FROM users u
        WHERE t.id=$1 AND t.hidden AND t.mod_hidden_at IS NOT NULL AND u.id=t.user_id AND u.deleted_at IS NULL RETURNING t.id`, [id]);
      if (!r.rowCount) return false;
      await audit(c, req.auth!.sub, `${k.label}.restore`, { [k.label]: id }); return true;
    });
    out ? res.json({ ok: true }) : res.status(404).json({ error: "not_found" });
  });
  moderation.post(`${path}/dismiss`, mod, async (req, res) => {
    const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
    const out = await tx(async c => {
      const r = await c.query(`UPDATE ${k.reports} SET resolved_at=now() WHERE ${k.key}=$1 AND resolved_at IS NULL`, [id]);
      if (!r.rowCount) return false;
      await audit(c, req.auth!.sub, `${k.label}.dismiss_reports`, { [k.label]: id, reports: r.rowCount }); return true;
    });
    out ? res.json({ ok: true }) : res.status(404).json({ error: "not_found" });
  });
}

// Stories have their own expiry-aware report queue. Moderation never awards or reverses GREEN/XP.
moderation.get("/admin/story-reports", mod, async (_req, res) => {
  const r = await pool.query(`SELECT s.id::text story_id,s.body,s.audience,s.created_at,s.expires_at,s.hidden,
      COALESCE(u.display_name,u.public_id) author,u.public_id author_id,
      COUNT(sr.id)::int reports,MAX(sr.created_at) last_report,
      string_agg(DISTINCT left(sr.reason,120), ' · ') reasons
    FROM story_reports sr JOIN stories s ON s.id=sr.story_id JOIN users u ON u.id=s.user_id
    WHERE sr.resolved_at IS NULL GROUP BY s.id,u.id ORDER BY reports DESC,last_report DESC LIMIT 100`);
  res.json(r.rows);
});
moderation.post("/admin/stories/:id/hide", mod, async (req,res)=>{
  const id=parseId(req.params.id); if(!id) return res.status(400).json({error:"invalid"});
  const out=await tx(async c=>{
    const r=await c.query("UPDATE stories SET hidden=true WHERE id=$1 AND NOT hidden RETURNING user_id",[id]);
    if(!r.rowCount) return false;
    await c.query("UPDATE story_reports SET resolved_at=now() WHERE story_id=$1 AND resolved_at IS NULL",[id]);
    await notify(c,r.rows[0].user_id,"moderation","Story removed","A moderator removed one of your stories for not following the community rules.");
    await audit(c,req.auth!.sub,"story.hide",{story:id}); return true;
  });
  out?res.json({ok:true}):res.status(404).json({error:"not_found"});
});
moderation.post("/admin/stories/:id/dismiss", mod, async (req,res)=>{
  const id=parseId(req.params.id); if(!id) return res.status(400).json({error:"invalid"});
  const out=await tx(async c=>{
    const r=await c.query("UPDATE story_reports SET resolved_at=now() WHERE story_id=$1 AND resolved_at IS NULL",[id]);
    if(!r.rowCount) return false;
    await audit(c,req.auth!.sub,"story.dismiss_reports",{story:id,reports:r.rowCount}); return true;
  });
  out?res.json({ok:true}):res.status(404).json({error:"not_found"});
});
