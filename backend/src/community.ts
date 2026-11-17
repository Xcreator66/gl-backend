import { Router } from "express";
import { z } from "zod";
import { pool, tx } from "./db.ts";
import { signedMediaUrl } from "./media.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { parseId } from "./pickupRules.ts";
import { thread } from "./thread.ts";
import { cleanDisplayName } from "./names.ts";

export const community = Router();
const member = requireRole("individual", "collector");
const name = "COALESCE(u.display_name,u.public_id)"; // never expose phone/address
/** SQL: true when a block exists in EITHER direction between users a and b (parameters/columns passed as SQL text). */
const blocked = (a: string, b: string) => `EXISTS(SELECT 1 FROM blocks bl WHERE (bl.blocker=${a} AND bl.blocked=${b}) OR (bl.blocker=${b} AND bl.blocked=${a}))`;
const muted = (me: string, other: string) => `EXISTS(SELECT 1 FROM mutes mu WHERE mu.muter=${me} AND mu.muted=${other})`;
const bad = (res: any) => res.status(400).json({ error: "invalid" });

async function enrichPosts(rows: any[], viewerId: string) {
  if (!rows.length) return rows.map(r => ({ ...r, attachments: [] }));
  const [viewer, assets] = await Promise.all([
    pool.query("SELECT public_id FROM users WHERE id=$1", [viewerId]),
    pool.query(`SELECT pa.post_id::text post_id,a.id::text asset_id,a.media_kind,a.content_type,a.width,a.height,a.duration_ms,a.byte_size
      FROM post_attachments pa JOIN media_assets a ON a.id=pa.asset_id
      WHERE pa.post_id=ANY($1::bigint[]) AND a.status='ready' ORDER BY pa.post_id,pa.position`, [rows.map(r => r.id)]),
  ]);
  const publicId = viewer.rows[0]?.public_id ?? "";
  const grouped = new Map<string, any[]>();
  for (const a of assets.rows) {
    const list = grouped.get(a.post_id) ?? [];
    list.push({ id: a.asset_id, kind: a.media_kind, contentType: a.content_type, width: a.width, height: a.height, durationMs: a.duration_ms, byteSize: Number(a.byte_size), url: signedMediaUrl(a.asset_id, publicId) });
    grouped.set(a.post_id, list);
  }
  return rows.map(r => ({ ...r, attachments: grouped.get(r.id) ?? [] }));
}

async function visibleStory(me: string, id: string) {
  return (await pool.query(`SELECT s.id,s.user_id,s.body,s.audience,s.audience_group_id,s.shared_post_id,s.created_at,s.expires_at
    FROM stories s WHERE s.id=$1 AND NOT s.hidden AND s.expires_at>now()
      AND (s.user_id=$2 OR s.audience='everyone'
        OR (s.audience='followers' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower=$2 AND f.followee=s.user_id))
        OR (s.audience='group' AND EXISTS(SELECT 1 FROM community_members cm WHERE cm.community_id=s.audience_group_id AND cm.user_id=$2)))
      AND NOT ${blocked("$2", "s.user_id")} AND NOT ${muted("$2", "s.user_id")}`, [id, me])).rows[0] ?? null;
}

async function attachAssets(postId: string, userId: string, ids: string[], c: any) {
  if (new Set(ids).size !== ids.length || ids.some(id => !/^\d{1,18}$/.test(id))) throw new Error("invalid_attachments");
  if (!ids.length) return;
  const assets = await c.query("SELECT id,media_kind,byte_size FROM media_assets WHERE id=ANY($1::bigint[]) AND owner_id=$2 AND status='ready' FOR UPDATE", [ids, userId]);
  if (assets.rowCount !== ids.length) throw new Error("media_not_ready_or_owned");
  const totalBytes=assets.rows.reduce((n:any,a:any)=>n+Number(a.byte_size),0);
  if(totalBytes>150*1024*1024) throw new Error("media_total_size_exceeded");
  const byId = new Map(assets.rows.map((asset: any) => [String(asset.id), asset]));
  let videoCount = 0;
  for (let i = 0; i < ids.length; i++) {
    const asset: any = byId.get(ids[i]);
    if (asset.media_kind === "video") videoCount++;
    await c.query("INSERT INTO post_attachments(post_id,asset_id,position) VALUES($1,$2,$3)", [postId, asset.id, i]);
  }
  if (videoCount > 2) throw new Error("too_many_videos");
}
/** A post the caller may interact with: exists, not hidden, no block either way with its author. */
async function loadPost(me: string, id: string | null) {
  if (!id) return null;
  const r = await pool.query(`SELECT p.id, p.user_id FROM posts p WHERE p.id=$1 AND NOT p.hidden AND NOT ${blocked("$2", "p.user_id")}`, [id, me]);
  return r.rows[0] ?? null;
}
/** A person the caller may see/act on: a household or collector, not self-blocked either way. */
async function loadPerson(me: string, pid: string) {
  const r = await pool.query(`SELECT u.id, u.public_id, ${name} name FROM users u WHERE u.public_id=$1 AND u.role IN ('individual','collector') AND NOT ${blocked("$2", "u.id")}`, [pid, me]);
  return r.rows[0] ?? null;
}

community.get("/feed", member, async (req, res) => {
  const before = req.query.before ? parseId(String(req.query.before)) : null;
  if (req.query.before && !before) return bad(res);
  const followingOnly = req.query.tab === "following";
  const r = await pool.query(`SELECT p.id::text, p.kind, p.body, p.created_at, ${name} author, u.public_id author_id, (p.user_id=$1) mine,
    (SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id)::int likes,
    (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND NOT c.hidden)::int comments,
    EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=$1) liked,
    EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.post_id=p.id AND sp.user_id=$1) saved
    FROM posts p JOIN users u ON u.id=p.user_id WHERE NOT p.hidden AND ($2::bigint IS NULL OR p.id<$2::bigint)
    AND NOT ${blocked("$1", "p.user_id")} AND NOT ${muted("$1", "p.user_id")}
    AND (NOT $3::boolean OR p.user_id=$1 OR EXISTS(SELECT 1 FROM follows f WHERE f.follower=$1 AND f.followee=p.user_id))
    ORDER BY p.id DESC LIMIT 20`, [req.auth!.sub, before, followingOnly]);
  res.json(await enrichPosts(r.rows, req.auth!.sub));
});
community.post("/posts", member, rateLimit(10, 60_000), async (req, res) => {
  const b = z.object({ body: z.string().trim().max(500).optional().default(""), attachmentIds: z.array(z.string()).max(8).optional().default([]) }).safeParse(req.body);
  if (!b.success || (!b.data.body.trim() && !b.data.attachmentIds.length)) return bad(res);
  try {
    const out = await tx(async c => {
      const p = (await c.query("INSERT INTO posts(user_id,body) VALUES($1,$2) RETURNING id::text", [req.auth!.sub, b.data.body.trim()])).rows[0];
      await attachAssets(p.id, req.auth!.sub, b.data.attachmentIds, c);
      return p;
    });
    res.status(201).json(out);
  } catch (e: any) {
    if (["invalid_attachments", "media_not_ready_or_owned", "too_many_videos", "media_total_size_exceeded"].includes(e.message)) return res.status(409).json({ error: e.message });
    throw e;
  }
});
community.post("/posts/:id/edit", member, rateLimit(10, 60_000), async (req, res) => {
  const id = parseId(req.params.id), b = z.object({ body: z.string().trim().max(500), attachmentIds: z.array(z.string()).max(8).optional().default([]) }).safeParse(req.body);
  if (!id || !b.success || (!b.data.body && !b.data.attachmentIds.length)) return bad(res);
  try {
    await tx(async c => {
      const p = await c.query("SELECT id FROM posts WHERE id=$1 AND user_id=$2 AND kind='text' AND NOT hidden FOR UPDATE", [id, req.auth!.sub]);
      if (!p.rowCount) throw new Error("not_found");
      await c.query("DELETE FROM post_attachments WHERE post_id=$1", [id]);
      await c.query("UPDATE posts SET body=$1,updated_at=now(),edited_at=now() WHERE id=$2", [b.data.body,id]);
      await attachAssets(id, req.auth!.sub, b.data.attachmentIds, c);
    });
    res.json({ ok: true });
  } catch (e: any) {
    if (e.message === "not_found") return res.status(404).json({ error: "not_found" });
    if (["invalid_attachments", "media_not_ready_or_owned", "too_many_videos", "media_total_size_exceeded"].includes(e.message)) return res.status(409).json({ error: e.message });
    throw e;
  }
});
// Save/unsave is a private convenience; it does not affect reach, XP, GREEN or rankings.
community.post("/posts/:id/save", member, async (req, res) => {
  const p = await loadPost(req.auth!.sub, parseId(req.params.id)); if (!p) return res.status(404).json({ error: "not_found" });
  const d = await pool.query("DELETE FROM saved_posts WHERE user_id=$1 AND post_id=$2", [req.auth!.sub,p.id]);
  if (!d.rowCount) await pool.query("INSERT INTO saved_posts(user_id,post_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.auth!.sub,p.id]);
  res.json({ saved: !d.rowCount });
});
community.get("/me/saved-posts", member, async (req, res) => {
  const r = await pool.query(`SELECT p.id::text,p.kind,p.body,p.created_at,${name} author,u.public_id author_id,(p.user_id=$1) mine,
      (SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id)::int likes,(SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND NOT c.hidden)::int comments,
      EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=$1) liked,true saved
    FROM saved_posts sp JOIN posts p ON p.id=sp.post_id JOIN users u ON u.id=p.user_id
    WHERE sp.user_id=$1 AND NOT p.hidden AND NOT ${blocked("$1","p.user_id")} AND NOT ${muted("$1","p.user_id")}
    ORDER BY sp.saved_at DESC LIMIT 100`, [req.auth!.sub]);
  res.json(await enrichPosts(r.rows, req.auth!.sub));
});

// Stories are accessible only while live and only to the audience selected by their creator.
community.get("/stories/feed", member, async (req, res) => {
  const me = req.auth!.sub;
  const r = await pool.query(`SELECT s.id::text,s.body,s.audience,s.shared_post_id::text,s.created_at,s.expires_at,u.public_id author_id,${name} author,
      sp.body shared_post_body,sp.kind shared_post_kind,COALESCE(su.display_name,su.public_id) shared_post_author,
      EXISTS(SELECT 1 FROM story_views v WHERE v.story_id=s.id AND v.viewer_id=$1) viewed,
      (SELECT COUNT(*) FROM story_views v WHERE v.story_id=s.id)::int views,
      (s.user_id=$1) mine
    FROM stories s JOIN users u ON u.id=s.user_id LEFT JOIN posts sp ON sp.id=s.shared_post_id AND NOT sp.hidden LEFT JOIN users su ON su.id=sp.user_id WHERE NOT s.hidden AND s.expires_at>now()
      AND (s.user_id=$1 OR s.audience='everyone' OR (s.audience='followers' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower=$1 AND f.followee=s.user_id))
        OR (s.audience='group' AND EXISTS(SELECT 1 FROM community_members cm WHERE cm.community_id=s.audience_group_id AND cm.user_id=$1)))
      AND NOT ${blocked("$1","s.user_id")} AND NOT ${muted("$1","s.user_id")}
    ORDER BY (s.user_id=$1) DESC,s.created_at ASC LIMIT 250`, [me]);
  const ids = r.rows.map(x => x.id);
  const own = await pool.query("SELECT public_id FROM users WHERE id=$1", [me]);
  const assets = ids.length ? await pool.query(`SELECT story_id,asset_id,media_kind,content_type,width,height,duration_ms,byte_size FROM (
      SELECT sa.story_id::text story_id,a.id::text asset_id,a.media_kind,a.content_type,a.width,a.height,a.duration_ms,a.byte_size,sa.position
      FROM story_attachments sa JOIN media_assets a ON a.id=sa.asset_id WHERE sa.story_id=ANY($1::bigint[]) AND a.status='ready'
      UNION ALL
      SELECT s.id::text story_id,a.id::text asset_id,a.media_kind,a.content_type,a.width,a.height,a.duration_ms,a.byte_size,pa.position
      FROM stories s JOIN post_attachments pa ON pa.post_id=s.shared_post_id JOIN media_assets a ON a.id=pa.asset_id
      WHERE s.id=ANY($1::bigint[]) AND NOT s.hidden AND s.expires_at>now() AND a.status='ready'
    ) media ORDER BY story_id,position`, [ids]) : { rows: [] };
  const byStory = new Map<string, any[]>();
  for (const a of assets.rows) { const list=byStory.get(a.story_id) ?? []; list.push({ id:a.asset_id,kind:a.media_kind,contentType:a.content_type,width:a.width,height:a.height,durationMs:a.duration_ms,byteSize:Number(a.byte_size),url:signedMediaUrl(a.asset_id,own.rows[0].public_id) }); byStory.set(a.story_id,list); }
  const byUser = new Map<string, any>();
  for (const row of r.rows) {
    const key=row.author_id;
    if (!byUser.has(key)) byUser.set(key,{ authorId:key,author:row.author,mine:row.mine,items:[] });
    byUser.get(key).items.push({ id:row.id,body:row.body,audience:row.audience,sharedPostId:row.shared_post_id,
      sharedPost:row.shared_post_id ? { id:row.shared_post_id,body:row.shared_post_body,kind:row.shared_post_kind,author:row.shared_post_author } : null,
      createdAt:row.created_at,expiresAt:row.expires_at,viewed:row.viewed,views:row.views,mine:row.mine,attachments:byStory.get(row.id) ?? [] });
  }
  res.json({ groups:[...byUser.values()] });
});
community.post("/stories", member, rateLimit(8,60_000), async (req,res) => {
  const b=z.object({ body:z.string().trim().max(300).optional(), assetIds:z.array(z.string()).max(1).optional().default([]), audience:z.enum(["everyone","followers","group"]).default("everyone"), groupId:z.string().optional(), sharedPostId:z.string().optional() }).safeParse(req.body);
  if (!b.success || (!(b.data.body?.trim()) && !b.data.assetIds.length && !b.data.sharedPostId)) return bad(res);
  const groupId=b.data.groupId ? parseId(b.data.groupId) : null, sharedId=b.data.sharedPostId ? parseId(b.data.sharedPostId) : null;
  if ((b.data.audience === "group" && !groupId) || (b.data.audience !== "group" && b.data.groupId) || (b.data.sharedPostId && !sharedId)) return bad(res);
  try {
    const out=await tx(async c => {
      if (groupId && !(await c.query("SELECT 1 FROM community_members WHERE community_id=$1 AND user_id=$2",[groupId,req.auth!.sub])).rowCount) throw new Error("not_group_member");
      if (sharedId) { const p=await c.query(`SELECT p.id FROM posts p WHERE p.id=$1 AND NOT p.hidden AND NOT ${blocked("$2","p.user_id")} AND NOT ${muted("$2","p.user_id")}`,[sharedId,req.auth!.sub]); if(!p.rowCount) throw new Error("shared_post_not_found"); }
      const story=(await c.query(`INSERT INTO stories(user_id,body,audience,audience_group_id,shared_post_id) VALUES($1,$2,$3,$4,$5) RETURNING id::text,expires_at`,[req.auth!.sub,b.data.body?.trim() || null,b.data.audience,groupId,sharedId])).rows[0];
      if (b.data.assetIds.length) {
        const ids=b.data.assetIds; if(new Set(ids).size!==ids.length || ids.some(x=>!/^\d{1,18}$/.test(x))) throw new Error("invalid_attachments");
        const a=await c.query("SELECT id FROM media_assets WHERE id=ANY($1::bigint[]) AND owner_id=$2 AND status='ready' AND media_kind IN ('image','video') FOR UPDATE",[ids,req.auth!.sub]);
        if(a.rowCount!==ids.length) throw new Error("media_not_ready_or_owned");
        await c.query("INSERT INTO story_attachments(story_id,asset_id,position) VALUES($1,$2,0)",[story.id,a.rows[0].id]);
      }
      return story;
    });
    res.status(201).json(out);
  } catch(e:any) { if(["not_group_member","shared_post_not_found","invalid_attachments","media_not_ready_or_owned"].includes(e.message)) return res.status(409).json({error:e.message}); throw e; }
});
community.post("/stories/:id/view", member, async (req,res) => {
  const id=parseId(req.params.id); if(!id) return bad(res); const s=await visibleStory(req.auth!.sub,id); if(!s) return res.status(404).json({error:"not_found"});
  if(s.user_id!==req.auth!.sub) await pool.query("INSERT INTO story_views(story_id,viewer_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[id,req.auth!.sub]);
  res.json({ok:true});
});
community.post("/stories/:id/react", member, rateLimit(30,60_000), async(req,res)=>{
  const id=parseId(req.params.id),b=z.object({reaction:z.enum(["like","love","clap","leaf"])}).safeParse(req.body); if(!id||!b.success) return bad(res);
  if(!(await visibleStory(req.auth!.sub,id))) return res.status(404).json({error:"not_found"});
  await pool.query("INSERT INTO story_reactions(story_id,user_id,reaction) VALUES($1,$2,$3) ON CONFLICT(story_id,user_id) DO UPDATE SET reaction=EXCLUDED.reaction,created_at=now()",[id,req.auth!.sub,b.data.reaction]); res.json({ok:true});
});
community.post("/stories/:id/reply", member, rateLimit(20,60_000), async(req,res)=>{
  const id=parseId(req.params.id),b=z.object({body:z.string().trim().min(1).max(250)}).safeParse(req.body); if(!id||!b.success) return bad(res);
  const s=await visibleStory(req.auth!.sub,id); if(!s) return res.status(404).json({error:"not_found"});
  await pool.query("INSERT INTO story_replies(story_id,user_id,body) VALUES($1,$2,$3)",[id,req.auth!.sub,b.data.body]);
  if(s.user_id!==req.auth!.sub) await pool.query("INSERT INTO notifications(user_id,kind,title,body) VALUES($1,'social','Story reply','Someone replied to your story')",[s.user_id]);
  res.status(201).json({ok:true});
});
community.get("/stories/:id/replies", member, async(req,res)=>{
  const id=parseId(req.params.id); if(!id) return bad(res);
  const own=await pool.query("SELECT id FROM stories WHERE id=$1 AND user_id=$2 AND NOT hidden AND expires_at>now()",[id,req.auth!.sub]);
  if(!own.rowCount) return res.status(404).json({error:"not_found"});
  const r=await pool.query(`SELECT COALESCE(u.display_name,u.public_id) name,sr.body,sr.created_at
    FROM story_replies sr JOIN users u ON u.id=sr.user_id WHERE sr.story_id=$1 AND NOT EXISTS(
      SELECT 1 FROM blocks b WHERE (b.blocker=$2 AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=$2))
    ORDER BY sr.created_at DESC LIMIT 200`,[id,req.auth!.sub]);
  res.json(r.rows);
});
community.post("/stories/:id/delete", member, async(req,res)=>{
  const id=parseId(req.params.id); if(!id) return bad(res); const r=await pool.query("UPDATE stories SET hidden=true WHERE id=$1 AND user_id=$2 AND NOT hidden RETURNING id",[id,req.auth!.sub]);
  r.rowCount?res.json({ok:true}):res.status(404).json({error:"not_found"});
});
community.get("/stories/:id/viewers", member, async(req,res)=>{
  const id=parseId(req.params.id); if(!id) return bad(res);
  const s=await pool.query("SELECT id FROM stories WHERE id=$1 AND user_id=$2 AND NOT hidden AND expires_at>now()",[id,req.auth!.sub]); if(!s.rowCount) return res.status(404).json({error:"not_found"});
  const r=await pool.query(`SELECT COALESCE(u.display_name,u.public_id) name,u.public_id,sv.viewed_at FROM story_views sv JOIN users u ON u.id=sv.viewer_id WHERE sv.story_id=$1 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE (b.blocker=$2 AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=$2)) ORDER BY sv.viewed_at DESC LIMIT 500`,[id,req.auth!.sub]); res.json(r.rows);
});
community.post("/stories/:id/report", member, rateLimit(12,60_000), async(req,res)=>{
  const id=parseId(req.params.id),b=z.object({reason:z.string().trim().min(1).max(200)}).safeParse(req.body); if(!id||!b.success) return bad(res);
  if(!(await visibleStory(req.auth!.sub,id))) return res.status(404).json({error:"not_found"});
  await pool.query("INSERT INTO story_reports(story_id,reporter,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[id,req.auth!.sub,b.data.reason]); res.json({ok:true});
});

// Achievement text is computed server-side from approved (verified) weight; clients cannot supply it.
community.post("/achievements/share", member, rateLimit(3, 60_000), async (req, res) => {
  const r = await pool.query("SELECT COALESCE(SUM(accepted_grams),0)::int g FROM collections WHERE household_id=$1 AND state='approved'", [req.auth!.sub]);
  if (!r.rows[0].g) return res.status(409).json({ error: "nothing_verified_yet" });
  await pool.query("INSERT INTO posts(user_id,kind,body) VALUES($1,'achievement',$2)", [req.auth!.sub, `Recycled ${(r.rows[0].g / 1000).toFixed(2)} kg of verified material on GREENLOOP`]);
  res.status(201).json({ ok: true });
});
community.post("/posts/:id/like", member, async (req, res) => {
  const p = await loadPost(req.auth!.sub, parseId(req.params.id)); if (!p) return res.status(404).json({ error: "not_found" });
  const d = await pool.query("DELETE FROM post_likes WHERE post_id=$1 AND user_id=$2", [p.id, req.auth!.sub]);
  if (!d.rowCount) {
    const i = await pool.query("INSERT INTO post_likes VALUES($1,$2) ON CONFLICT DO NOTHING", [p.id, req.auth!.sub]);
    if (i.rowCount && p.user_id !== req.auth!.sub) await pool.query("INSERT INTO notifications(user_id,kind,title,body) VALUES($1,'social','New like','Someone liked your post')", [p.user_id]);
  }
  res.json({ liked: !d.rowCount });
});
community.get("/posts/:id/comments", member, async (req, res) => {
  const p = await loadPost(req.auth!.sub, parseId(req.params.id)); if (!p) return res.status(404).json({ error: "not_found" });
  const r = await pool.query(`SELECT c.id::text, c.parent_id::text, c.body, c.created_at, ${name} author, u.public_id author_id, (c.user_id=$2) mine
    FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=$1 AND NOT c.hidden
    AND NOT ${blocked("$2", "c.user_id")} AND NOT ${muted("$2", "c.user_id")} ORDER BY c.id LIMIT 200`, [p.id, req.auth!.sub]);
  res.json(thread(r.rows));
});
// Replies go one level deep: parentId must be a visible TOP-LEVEL comment on the same post.
community.post("/posts/:id/comments", member, rateLimit(20, 60_000), async (req, res) => {
  const b = z.object({ body: z.string().trim().min(1).max(300), parentId: z.string().optional() }).safeParse(req.body);
  if (!b.success) return bad(res);
  const p = await loadPost(req.auth!.sub, parseId(req.params.id)); if (!p) return res.status(404).json({ error: "not_found" });
  let parent: string | null = null;
  if (b.data.parentId !== undefined) {
    parent = parseId(b.data.parentId); if (!parent) return bad(res);
    const pc = await pool.query(`SELECT c.id FROM comments c WHERE c.id=$1 AND c.post_id=$2 AND c.parent_id IS NULL AND NOT c.hidden AND NOT ${blocked("$3", "c.user_id")}`, [parent, p.id, req.auth!.sub]);
    if (!pc.rowCount) return res.status(400).json({ error: "bad_parent" });
  }
  await pool.query("INSERT INTO comments(post_id,parent_id,user_id,body) VALUES($1,$2,$3,$4)", [p.id, parent, req.auth!.sub, b.data.body]);
  if (p.user_id !== req.auth!.sub) await pool.query("INSERT INTO notifications(user_id,kind,title,body) VALUES($1,'social','New comment','Someone commented on your post')", [p.user_id]);
  res.status(201).json({ ok: true });
});
community.post("/posts/:id/report", member, async (req, res) => {
  const p = await loadPost(req.auth!.sub, parseId(req.params.id)); if (!p) return res.status(404).json({ error: "not_found" });
  await pool.query("INSERT INTO reports(post_id,reporter,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [p.id, req.auth!.sub, String(req.body?.reason ?? "").slice(0, 200)]);
  res.json({ ok: true });
});
// Reporting a comment: it must be visible to the reporter (exists, not hidden, no block either way with its author or the post's author). One report per person.
community.post("/comments/:id/report", member, rateLimit(20, 60_000), async (req, res) => {
  const id = parseId(req.params.id); if (!id) return bad(res);
  const c = await pool.query(`SELECT c.id FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=$1 AND NOT c.hidden AND NOT p.hidden
    AND NOT ${blocked("$2", "c.user_id")} AND NOT ${blocked("$2", "p.user_id")}`, [id, req.auth!.sub]);
  if (!c.rowCount) return res.status(404).json({ error: "not_found" });
  await pool.query("INSERT INTO comment_reports(comment_id,reporter,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id, req.auth!.sub, String(req.body?.reason ?? "").slice(0, 200)]);
  res.json({ ok: true });
});
// Users can remove their own content (it is hidden, the row is kept for moderation history).
community.post("/posts/:id/delete", member, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return bad(res);
  const r = await pool.query("UPDATE posts SET hidden=true WHERE id=$1 AND user_id=$2 AND NOT hidden", [id, req.auth!.sub]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "not_found" });
});
community.post("/comments/:id/delete", member, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return bad(res);
  const r = await pool.query("UPDATE comments SET hidden=true WHERE id=$1 AND user_id=$2 AND NOT hidden", [id, req.auth!.sub]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "not_found" });
});

// ---- people: profiles, follow, mute, block ----
community.get("/me/profile", member, async (req, res) => {
  const r = await pool.query("SELECT public_id, display_name FROM users WHERE id=$1", [req.auth!.sub]);
  res.json({ publicId: r.rows[0].public_id, displayName: r.rows[0].display_name });
});
community.post("/me/profile", member, rateLimit(10, 60_000), async (req, res) => {
  const n = cleanDisplayName(req.body?.displayName); if (!n) return res.status(400).json({ error: "invalid_name" });
  await pool.query("UPDATE users SET display_name=$1 WHERE id=$2", [n, req.auth!.sub]); res.json({ displayName: n });
});
// Public profile: name, public ID and verified weight only. Never phone, address or money. 404 when blocked either way.
community.get("/users/:pid", member, async (req, res) => {
  const me = req.auth!.sub, t = await loadPerson(me, req.params.pid); if (!t) return res.status(404).json({ error: "not_found" });
  const r = await pool.query(`SELECT
    (SELECT COUNT(*) FROM follows WHERE followee=$1)::int followers, (SELECT COUNT(*) FROM follows WHERE follower=$1)::int following,
    COALESCE((SELECT SUM(accepted_grams) FROM collections WHERE household_id=$1 AND state='approved'),0)::int verified_grams,
    EXISTS(SELECT 1 FROM follows WHERE follower=$2 AND followee=$1) i_follow, ${muted("$2", "$1")} muted`, [t.id, me]);
  const x = r.rows[0];
  res.json({ publicId: t.public_id, name: t.name, self: t.id === me, followers: x.followers, following: x.following, verifiedGrams: x.verified_grams, iFollow: x.i_follow, muted: x.muted });
});
community.get("/me/connections", member, async (req, res) => {
  const followers = req.query.kind === "followers", me = req.auth!.sub;
  const r = await pool.query(`SELECT u.public_id, ${name} name, EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower=$1 AND f2.followee=u.id) i_follow
    FROM follows f JOIN users u ON u.id=${followers ? "f.follower" : "f.followee"} WHERE ${followers ? "f.followee" : "f.follower"}=$1
    AND NOT ${blocked("$1", "u.id")} ORDER BY u.public_id LIMIT 200`, [me]);
  res.json(r.rows);
});
community.get("/me/hidden-users", member, async (req, res) => {
  const [b, m] = await Promise.all([
    pool.query(`SELECT u.public_id, ${name} name FROM blocks x JOIN users u ON u.id=x.blocked WHERE x.blocker=$1 ORDER BY u.public_id`, [req.auth!.sub]),
    pool.query(`SELECT u.public_id, ${name} name FROM mutes x JOIN users u ON u.id=x.muted WHERE x.muter=$1 ORDER BY u.public_id`, [req.auth!.sub])]);
  res.json({ blocked: b.rows, muted: m.rows });
});
community.get("/users/:pid/posts", member, async (req,res)=>{
  const person=await loadPerson(req.auth!.sub,req.params.pid); if(!person) return res.status(404).json({error:"not_found"});
  const before=req.query.before?parseId(String(req.query.before)):null; if(req.query.before&&!before) return bad(res);
  const r=await pool.query(`SELECT p.id::text,p.kind,p.body,p.created_at,${name} author,u.public_id author_id,(p.user_id=$2) mine,
      (SELECT COUNT(*) FROM post_likes l WHERE l.post_id=p.id)::int likes,
      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id AND NOT c.hidden)::int comments,
      EXISTS(SELECT 1 FROM post_likes l WHERE l.post_id=p.id AND l.user_id=$2) liked,
      EXISTS(SELECT 1 FROM saved_posts sp WHERE sp.post_id=p.id AND sp.user_id=$2) saved
    FROM posts p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND NOT p.hidden AND ($3::bigint IS NULL OR p.id<$3::bigint)
      AND NOT ${blocked("$2","p.user_id")} AND NOT ${muted("$2","p.user_id")} ORDER BY p.id DESC LIMIT 20`,[person.id,req.auth!.sub,before]);
  res.json(await enrichPosts(r.rows,req.auth!.sub));
});
community.post("/users/:pid/follow", member, async (req, res) => {
  const me = req.auth!.sub, t = await loadPerson(me, req.params.pid); if (!t) return res.status(404).json({ error: "not_found" });
  if (t.id === me) return res.status(400).json({ error: "cannot_follow_self" });
  const d = await pool.query("DELETE FROM follows WHERE follower=$1 AND followee=$2", [me, t.id]);
  if (!d.rowCount) await pool.query("INSERT INTO follows VALUES($1,$2) ON CONFLICT DO NOTHING", [me, t.id]);
  res.json({ following: !d.rowCount });
});
/** Looks up a user for block/mute management. Unlike loadPerson it still works for someone you already blocked (so you can undo it). */
const target = async (me: string, pid: string) => (await pool.query("SELECT id FROM users WHERE public_id=$1 AND id<>$2 AND role IN ('individual','collector')", [pid, me])).rows[0];
community.post("/users/:pid/block", member, async (req, res) => {
  const t = await target(req.auth!.sub, req.params.pid); if (!t) return res.status(404).json({ error: "not_found" });
  await pool.query("INSERT INTO blocks VALUES($1,$2) ON CONFLICT DO NOTHING", [req.auth!.sub, t.id]);
  await pool.query("DELETE FROM follows WHERE (follower=$1 AND followee=$2) OR (follower=$2 AND followee=$1)", [req.auth!.sub, t.id]); // a block ends follows both ways
  res.json({ ok: true });
});
community.post("/users/:pid/unblock", member, async (req, res) => {
  const t = await target(req.auth!.sub, req.params.pid); if (!t) return res.status(404).json({ error: "not_found" });
  await pool.query("DELETE FROM blocks WHERE blocker=$1 AND blocked=$2", [req.auth!.sub, t.id]); res.json({ ok: true });
});
community.post("/users/:pid/mute", member, async (req, res) => {
  const t = await target(req.auth!.sub, req.params.pid); if (!t) return res.status(404).json({ error: "not_found" });
  await pool.query("INSERT INTO mutes VALUES($1,$2) ON CONFLICT DO NOTHING", [req.auth!.sub, t.id]); res.json({ ok: true });
});
community.post("/users/:pid/unmute", member, async (req, res) => {
  const t = await target(req.auth!.sub, req.params.pid); if (!t) return res.status(404).json({ error: "not_found" });
  await pool.query("DELETE FROM mutes WHERE muter=$1 AND muted=$2", [req.auth!.sub, t.id]); res.json({ ok: true });
});
// Rankings come only from approved, independently verified weight. Likes/followers never count.
community.get("/leaderboard", member, async (req, res) => {
  const scope = req.query.scope === "collector" ? "collector_id" : "household_id";
  const days: Record<string, number> = { day: 1, week: 7, month: 30 };
  const since = days[String(req.query.period)] ? new Date(Date.now() - days[String(req.query.period)] * 864e5) : new Date(0);
  const r = await pool.query(`SELECT ${name} name, SUM(c.accepted_grams)::int grams FROM collections c JOIN users u ON u.id=c.${scope}
    WHERE c.state='approved' AND c.created_at>=$1 AND u.deleted_at IS NULL GROUP BY u.id ORDER BY grams DESC LIMIT 50`, [since]);
  res.json(r.rows);
});
community.get("/challenges", member, async (req, res) => {
  const r = await pool.query(`SELECT ch.id::text, ch.title, ch.material_id, ch.target_grams, ch.starts_at, ch.ends_at,
    EXISTS(SELECT 1 FROM challenge_members m WHERE m.challenge_id=ch.id AND m.user_id=$1) joined,
    (SELECT COUNT(*) FROM challenge_members m WHERE m.challenge_id=ch.id)::int members,
    COALESCE((SELECT SUM(c.accepted_grams) FROM collections c WHERE c.household_id=$1 AND c.state='approved' AND c.created_at BETWEEN ch.starts_at AND ch.ends_at
      AND (ch.material_id IS NULL OR c.material_id=ch.material_id)),0)::int mine
    FROM challenges ch WHERE ch.ends_at > now() - interval '7 days' ORDER BY ch.starts_at DESC LIMIT 20`, [req.auth!.sub]);
  res.json(r.rows);
});
community.post("/challenges/:id/join", member, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return bad(res);
  const r = await pool.query("INSERT INTO challenge_members SELECT id,$2::uuid FROM challenges WHERE id=$1 AND ends_at>now() ON CONFLICT DO NOTHING", [id, req.auth!.sub]);
  if (!r.rowCount && !(await pool.query("SELECT 1 FROM challenge_members WHERE challenge_id=$1 AND user_id=$2", [id, req.auth!.sub])).rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});
// Admin moderation + challenge creation
community.post("/admin/challenges", adminOnly("moderator"), async (req, res) => {
  const b = z.object({ title: z.string().min(3).max(100), materialId: z.string().nullable().optional(), targetGrams: z.number().int().positive(),
    startsAt: z.string().datetime(), endsAt: z.string().datetime() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid" });
  await pool.query("INSERT INTO challenges(title,material_id,target_grams,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6)",
    [b.data.title, b.data.materialId ?? null, b.data.targetGrams, b.data.startsAt, b.data.endsAt, req.auth!.sub]); res.status(201).json({ ok: true });
});
