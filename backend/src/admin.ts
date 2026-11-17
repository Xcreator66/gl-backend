import { Router } from "express";
import { z } from "zod";
import { batchRatios } from "./batchStats.ts";
import { pool, tx } from "./db.ts";
import { findRoleBlockers } from "./roleSafeguards.ts";
import { overrideValid } from "./roleRules.ts";
import { isPermission, type Permission } from "./payoutRules.ts";
import { TIERS } from "./tiers.ts";
import { COLLECTOR_ACCURACY_SQL } from "./collectorAccuracy.ts";
import { adminOnly } from "./adminAuth.ts";
import { forgetSession } from "./auth.ts";

export const adminApi = Router();
const audit = (actor: string, action: string, detail: object) => pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [actor, action, detail]);

adminApi.get("/admin/analytics", adminOnly("finance", "ops", "moderator"), async (_req, res) => {
  const [mat, users, batches, cols, pick] = await Promise.all([
    pool.query("SELECT material_id, SUM(accepted_grams)::int grams, COUNT(*)::int collections FROM collections WHERE accepted_grams IS NOT NULL AND state<>'adjusted' GROUP BY 1 ORDER BY 2 DESC"),
    pool.query("SELECT role, COUNT(*)::int n FROM users GROUP BY 1"),
    pool.query("SELECT status, COUNT(*)::int n FROM batches GROUP BY 1"),
    pool.query("SELECT state, COUNT(*)::int n FROM collections GROUP BY 1"),
    pool.query("SELECT COUNT(*)::int n FROM pickup_requests WHERE state='open'")]);
  res.json({ byMaterial: mat.rows, users: users.rows, batches: batches.rows, collections: cols.rows, openPickups: pick.rows[0].n });
});
adminApi.get("/admin/batches", adminOnly("ops", "finance"), async (_req, res) => {
  const r = await pool.query(`SELECT b.public_id, b.status, b.verified_grams::int accepted, COALESCE(SUM(c.declared_grams),0)::int declared, COUNT(c.id)::int items, b.created_at, rc.public_id recycler,
    (SELECT COALESCE(SUM(k.received_grams),0)::int FROM batch_checks k WHERE k.batch_id=b.id) received,
    (SELECT COALESCE(SUM(k.rejected_grams),0)::int FROM batch_checks k WHERE k.batch_id=b.id) rejected
    FROM batches b LEFT JOIN collections c ON c.batch_id=b.id LEFT JOIN users rc ON rc.id=COALESCE(b.recycler_id,b.handover_to) GROUP BY b.id, rc.public_id ORDER BY b.created_at DESC LIMIT 100`);
  res.json(r.rows.map(x => ({ ...x, ...batchRatios(x.declared, x.received, x.rejected) })));
});
// Phone numbers are masked even for admins; identify people by public ID.
adminApi.get("/admin/users", adminOnly("ops"), async (_req, res) => {
  const r = await pool.query("SELECT public_id, role_id, role, admin_tier, display_name, '+91******'||right(phone,4) phone, created_at FROM users ORDER BY created_at DESC LIMIT 300"); res.json(r.rows);
});
// v0.30.0: a role change is refused while the account has outstanding obligations (see roleSafeguards.ts). The check runs in the same transaction as the change,
// with the user row locked. Only a super admin holding role.override may override, with a reason and the exact confirmation phrase; the blockers are written to the audit log.
adminApi.post("/admin/users/:pid/role", adminOnly(), async (req, res) => {
  const b = z.object({ role: z.enum(["individual", "collector", "recycler", "admin"]), override: z.object({ reason: z.string(), confirm: z.string() }).optional() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const out = await tx(async c => {
    const u = (await c.query("SELECT id, role, role_id FROM users WHERE public_id=$1 AND id<>$2 FOR UPDATE", [req.params.pid, req.auth!.sub])).rows[0];
    if (!u) return { status: 409, body: { error: "not_found_or_self" } };
    if (u.role === b.data.role) return { status: 200, body: { ok: true, roleId: u.role_id } };
    const blockers = await findRoleBlockers(c, u.id, u.role);
    let overridden = false;
    if (blockers.length) {
      if (!b.data.override) return { status: 409, body: { error: "role_change_blocked", blockers } };
      const ok = overrideValid(b.data.override, req.params.pid) && req.adminTier === "super" && (await c.query("SELECT 1 FROM admin_permissions WHERE user_id=$1 AND permission='role.override'", [req.auth!.sub])).rowCount;
      if (!ok) return { status: 403, body: { error: "override_not_permitted", blockers } };
      overridden = true;
    }
    // Role IDs follow the role: a collector gets GL-C-, a recycler GL-R-. Same role again keeps the ID; any other change retires it (never reused).
    const r = await c.query(`UPDATE users SET role=$1::text::user_role, admin_tier=CASE WHEN $1::text='admin' THEN COALESCE(admin_tier,'ops') ELSE NULL END,
        role_id=CASE WHEN $1::text='collector' THEN CASE WHEN role='collector' THEN role_id ELSE gl_new_role_id('GL-C-') END
                     WHEN $1::text='recycler'  THEN CASE WHEN role='recycler'  THEN role_id ELSE gl_new_role_id('GL-R-') END ELSE NULL END
      WHERE id=$2 RETURNING id, role_id`, [b.data.role, u.id]);
    if (b.data.role !== "admin") await c.query("DELETE FROM admin_permissions WHERE user_id=$1", [u.id]);
    await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [req.auth!.sub, overridden ? "user.role.override" : "user.role",
      { pid: req.params.pid, from: u.role, role: b.data.role, roleId: r.rows[0].role_id, ...(overridden ? { reason: b.data.override!.reason, blockers } : {}) }]);
    return { status: 200, body: { ok: true, roleId: r.rows[0].role_id, overridden }, forget: u.id as string };
  });
  if ((out as any).forget) forgetSession((out as any).forget); // takes effect on this instance now; other instances within 30 s
  res.status(out.status).json(out.body);
});
// Explicit finance permissions (super only). Payout permissions go to finance-tier admins only and never to yourself; every change is audited.
adminApi.get("/admin/permissions", adminOnly(), async (_req, res) => {
  res.json((await pool.query("SELECT u.public_id, u.admin_tier, p.permission, p.granted_at FROM admin_permissions p JOIN users u ON u.id=p.user_id ORDER BY u.public_id, p.permission")).rows);
});
adminApi.post("/admin/users/:pid/permissions", adminOnly(), async (req, res) => {
  const b = z.object({ permission: z.string().refine(isPermission), grant: z.boolean() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const perm = b.data.permission as Permission, tgt = (await pool.query("SELECT id, admin_tier FROM users WHERE public_id=$1 AND role='admin'", [req.params.pid])).rows[0];
  if (!tgt) return res.status(409).json({ error: "not_an_admin" });
  const superOnly = perm === "commission.override_reversal" || perm === "role.override";
  if (b.data.grant && (superOnly ? tgt.admin_tier !== "super" : tgt.admin_tier !== "finance")) return res.status(409).json({ error: superOnly ? "super_tier_required" : "finance_tier_required" });
  if (b.data.grant && tgt.id === req.auth!.sub && perm.startsWith("payout.")) return res.status(409).json({ error: "cannot_grant_payout_permission_to_self" });
  if (b.data.grant) await pool.query("INSERT INTO admin_permissions(user_id,permission,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [tgt.id, perm, req.auth!.sub]);
  else await pool.query("DELETE FROM admin_permissions WHERE user_id=$1 AND permission=$2", [tgt.id, perm]);
  await audit(req.auth!.sub, b.data.grant ? "permission.grant" : "permission.revoke", { pid: req.params.pid, permission: perm }); res.json({ ok: true });
});
adminApi.get("/admin/materials", adminOnly("ops", "finance"), async (_req, res) => { res.json((await pool.query("SELECT id,name,green_per_kg,active,max_contamination_pct::float max_contamination_pct FROM materials ORDER BY name")).rows); });
// Rate changes affect FUTURE verifications only (GREEN is frozen per collection at verification).
adminApi.post("/admin/materials/:id", adminOnly("finance"), async (req, res) => {
  const b = z.object({ greenPerKg: z.number().int().min(0).max(100000), active: z.boolean(), maxContaminationPct: z.number().min(0).max(100).nullable().optional() }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const setLimit = Object.prototype.hasOwnProperty.call(req.body, "maxContaminationPct"); // omitted = leave the limit unchanged; null = no limit
  const r = await pool.query("UPDATE materials SET green_per_kg=$1,active=$2, max_contamination_pct=CASE WHEN $3::boolean THEN $4::numeric ELSE max_contamination_pct END WHERE id=$5", [b.data.greenPerKg, b.data.active, setLimit, b.data.maxContaminationPct ?? null, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  await audit(req.auth!.sub, "material.update", { id: req.params.id, ...b.data }); res.json({ ok: true });
});
adminApi.get("/admin/audit", adminOnly(), async (_req, res) => {
  res.json((await pool.query("SELECT id::text, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 200")).rows);
});
adminApi.get("/admin/ledger-summary", adminOnly("finance"), async (_req, res) => {
  const r = await pool.query(`SELECT regexp_replace(account,'^user:[^:]+:','user:*:') account, SUM(amount_green)::int total, COUNT(*)::int entries FROM ledger_entries GROUP BY 1 ORDER BY 1`);
  res.json({ rows: r.rows, net: r.rows.reduce((s, x) => s + x.total, 0) }); // net must always be 0
});
adminApi.get("/admin/collector-accuracy", adminOnly("ops", "finance"), async (_req, res) => { res.json((await pool.query(COLLECTOR_ACCURACY_SQL)).rows); });
adminApi.get("/admin/me", adminOnly("finance", "ops", "moderator"), (req, res) => { res.json({ tier: req.adminTier }); });
// Only a super admin can change tiers; never your own (so the last super cannot lock everyone out by accident).
adminApi.post("/admin/users/:pid/tier", adminOnly(), async (req, res) => {
  const b = z.object({ tier: z.enum(TIERS) }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("UPDATE users SET admin_tier=$1 WHERE public_id=$2 AND role='admin' AND id<>$3 RETURNING id", [b.data.tier, req.params.pid, req.auth!.sub]);
  if (!r.rowCount) return res.status(409).json({ error: "not_an_admin_or_self" });
  await audit(req.auth!.sub, "user.tier", { pid: req.params.pid, tier: b.data.tier }); res.json({ ok: true });
});

// Recycling partners: workload and quality at a glance. To add a partner, set a user's role to recycler (Users tab).
adminApi.get("/admin/partners", adminOnly("ops", "finance"), async (_req, res) => {
  const r = await pool.query(`SELECT u.public_id, COALESCE(u.display_name,u.public_id) name, u.created_at,
    COUNT(DISTINCT b.id) FILTER (WHERE b.status IN ('verified','flagged'))::int verified_batches, COUNT(DISTINCT b.id) FILTER (WHERE b.status='handed_over')::int waiting,
    COUNT(DISTINCT b.id) FILTER (WHERE b.status='flagged')::int flagged, COALESCE(SUM(k.received_grams),0)::int received, COALESCE(SUM(k.rejected_grams),0)::int rejected
    FROM users u LEFT JOIN batches b ON b.recycler_id=u.id OR (b.handover_to=u.id AND b.status='handed_over') LEFT JOIN batch_checks k ON k.batch_id=b.id AND b.recycler_id=u.id
    WHERE u.role='recycler' AND u.deleted_at IS NULL GROUP BY u.id ORDER BY u.created_at`);
  res.json(r.rows.map(x => ({ ...x, rejection_pct: batchRatios(0, x.received, x.rejected).rejection_pct })));
});
