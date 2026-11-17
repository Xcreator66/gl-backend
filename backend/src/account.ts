import { Router } from "express";
import { z } from "zod";
import { safeCode } from "./httpErrors.ts";
import type pg from "pg";
import { pool, tx } from "./db.ts";
import { requireRole, rateLimit, forgetSession } from "./auth.ts";
import { post } from "./ledger.ts";
import { deletionBlockers, type Facts } from "./accountRules.ts";

export const account = Router();
const member = requireRole("individual", "collector", "recycler", "admin");
const one = async (q: pg.Pool | pg.PoolClient, sql: string, p: unknown[]) => (await q.query(sql, p)).rows;

async function facts(q: pg.Pool | pg.PoolClient, id: string, role: string): Promise<Facts & { approvedGreen: number }> {
  const bal = Object.fromEntries((await one(q, "SELECT split_part(account,':',3) s, COALESCE(SUM(amount_green),0)::bigint v FROM ledger_entries WHERE account LIKE $1 GROUP BY 1", [`user:${id}:%`])).map(r => [r.s, Number(r.v)]));
  const n = async (sql: string) => Number((await one(q, sql, [id]))[0].n);
  return { role, pending: bal.pending ?? 0, approved: bal.approved ?? 0, locked: bal.locked ?? 0, approvedGreen: bal.approved ?? 0,
    openRedemptions: await n("SELECT COUNT(*)::int n FROM redemptions WHERE user_id=$1 AND state='requested'"),
    openDisputes: await n("SELECT COUNT(*)::int n FROM disputes d JOIN collections c ON c.id=d.collection_id WHERE d.state='open' AND (d.raised_by=$1 OR c.household_id=$1 OR c.collector_id=$1)"),
    openBatches: await n("SELECT COUNT(*)::int n FROM batches WHERE collector_id=$1 AND status IN ('open','handed_over')"),
    unverifiedCollections: await n("SELECT COUNT(*)::int n FROM collections WHERE (household_id=$1 OR collector_id=$1) AND accepted_grams IS NULL AND state='pending'"),
    ownsGroupWithMembers: (await n("SELECT COUNT(*)::int n FROM communities c WHERE c.created_by=$1 AND EXISTS (SELECT 1 FROM community_members m WHERE m.community_id=c.id AND m.user_id<>$1)")) > 0 };
}
account.get("/me/deletion-check", member, async (req, res) => {
  const u = (await one(pool, "SELECT role FROM users WHERE id=$1", [req.auth!.sub]))[0]; const f = await facts(pool, req.auth!.sub, u.role);
  res.json({ blockers: deletionBlockers(f, false), approvedGreen: f.approvedGreen });
});
account.post("/me/delete", member, rateLimit(3, 3_600_000), async (req, res) => {
  const b = z.object({ confirm: z.literal("DELETE"), forfeit: z.boolean().optional() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const id = req.auth!.sub;
  try {
    await tx(async c => {
      const u = (await one(c, "SELECT role,phone,public_id,deleted_at FROM users WHERE id=$1 FOR UPDATE", [id]))[0]; if (!u || u.deleted_at) throw new Error("gone");
      const f = await facts(c, id, u.role), blockers = deletionBlockers(f, !!b.data.forfeit); if (blockers.length) throw Object.assign(new Error("blocked"), { blockers });
      if (f.approved > 0) await post(c, [{ account: `user:${id}:approved`, amount: -f.approved }, { account: "platform:rewards_pool", amount: f.approved }], null, "given up on account deletion");
      for (const sql of ["DELETE FROM push_tokens WHERE user_id=$1", "DELETE FROM notifications WHERE user_id=$1", "DELETE FROM post_likes WHERE user_id=$1",
        "DELETE FROM follows WHERE follower=$1 OR followee=$1", "DELETE FROM blocks WHERE blocker=$1 OR blocked=$1", "DELETE FROM mutes WHERE muter=$1 OR muted=$1",
        "DELETE FROM challenge_members WHERE user_id=$1", "DELETE FROM community_members WHERE user_id=$1", "DELETE FROM event_rsvps WHERE user_id=$1",
        "DELETE FROM user_badges WHERE user_id=$1", "DELETE FROM referrals WHERE referrer=$1 OR referred=$1", "DELETE FROM reports WHERE reporter=$1", "DELETE FROM comment_reports WHERE reporter=$1",
        "UPDATE posts SET body='[deleted]', hidden=true WHERE user_id=$1", "UPDATE comments SET body='[deleted]', hidden=true WHERE user_id=$1",
        "UPDATE pickup_requests SET state='cancelled' WHERE user_id=$1 AND state IN ('open','assigned')", "UPDATE disputes SET detail=NULL WHERE raised_by=$1"]) await c.query(sql, [id]);
      await c.query("DELETE FROM otp_codes WHERE phone=$1", [u.phone]);
      await c.query("UPDATE users SET phone='deleted:'||id, display_name=NULL, referral_code=NULL, deleted_at=now() WHERE id=$1", [id]);
      await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'account.delete',$2)", [id, { public_id: u.public_id, gave_up_green: f.approved }]);
    });
    forgetSession(id); res.json({ ok: true });
  } catch (e: any) { res.status(409).json(e.message === "blocked" ? { error: "blocked", blockers: e.blockers } : { error: safeCode(e) }); }
});
// A copy of the person's OWN data as JSON. Other people's data is never included (follows are counted, not listed).
account.get("/me/export", member, rateLimit(3, 3_600_000), async (req, res) => {
  const id = req.auth!.sub, q = (sql: string) => one(pool, sql, [id]);
  const [profile, collections, ledger, redemptions, commissions, posts, comments, badges, notifications, disputes, pickups, counts] = await Promise.all([
    q("SELECT public_id, role, display_name, phone, created_at FROM users WHERE id=$1"),
    q("SELECT public_id, material_id, declared_grams, accepted_grams, green_awarded::int green, state, created_at, CASE WHEN household_id=$1 THEN 'household' ELSE 'collector' END AS my_role FROM collections WHERE household_id=$1 OR collector_id=$1 ORDER BY created_at DESC LIMIT 5000"),
    pool.query("SELECT split_part(account,':',3) state, amount_green::int green, memo, created_at FROM ledger_entries WHERE account LIKE $1 ORDER BY id LIMIT 10000", [`user:${id}:%`]).then(r => r.rows),
    q("SELECT public_id, green::int, amount_paise::int, payout_handle, state, created_at FROM redemptions WHERE user_id=$1 ORDER BY id"),
    q("SELECT id::text, green::int, state, created_at FROM commissions WHERE collector_id=$1 ORDER BY id"),
    q("SELECT id::text, kind, body, created_at FROM posts WHERE user_id=$1 ORDER BY id DESC LIMIT 2000"),
    q("SELECT id::text, post_id::text, body, created_at FROM comments WHERE user_id=$1 ORDER BY id DESC LIMIT 2000"),
    q("SELECT * FROM user_badges WHERE user_id=$1").then(r => r.map(({ user_id, ...x }) => x)),
    q("SELECT kind, title, body, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 500"),
    q("SELECT public_id, reason, detail, state, resolution_note, created_at FROM disputes WHERE raised_by=$1 ORDER BY id"),
    q("SELECT material_id, mode, est_grams, window_text, state, created_at FROM pickup_requests WHERE user_id=$1 ORDER BY id"),
    q("SELECT (SELECT COUNT(*)::int FROM follows WHERE follower=$1) following, (SELECT COUNT(*)::int FROM follows WHERE followee=$1) followers")]);
  res.setHeader("Content-Disposition", 'attachment; filename="greenloop-my-data.json"');
  res.json({ exportedAt: new Date().toISOString(), profile: profile[0], collections, ledger, redemptions, commissions, posts, comments, badges, notifications, disputes, pickupRequests: pickups, connections: counts[0],
    note: "Financial records are kept after account deletion, without your name or number, because accounting and tax rules require it." });
});
