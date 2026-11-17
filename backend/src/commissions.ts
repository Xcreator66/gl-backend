import { Router } from "express";
import { safeCode } from "./httpErrors.ts";
import { reverseCollectionReward } from "./adjust.ts";
import { z } from "zod";
import type pg from "pg";
import { pool, tx } from "./db.ts";
import { post } from "./ledger.ts";
import { requireRole } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { greenFor } from "./rewards.ts";
import { notify } from "./notify.ts";
import { parseId } from "./pickupRules.ts";

export const commissions = Router();
const admin = adminOnly("finance");
const balance = async (c: pg.PoolClient, account: string) =>
  Number((await c.query("SELECT COALESCE(SUM(amount_green),0)::bigint b FROM ledger_entries WHERE account=$1", [account])).rows[0].b);
const audit = (c: pg.PoolClient, actor: string, action: string, detail: object) =>
  c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [actor, action, detail]);
const run = async (res: any, f: () => Promise<unknown>) => { try { await f(); res.json({ ok: true }); } catch (e: any) { res.status(409).json({ error: safeCode(e) }); } };

commissions.get("/me/commissions", requireRole("collector"), async (req, res) => {
  const r = await pool.query(`SELECT k.id::text, k.green::int, k.reversed_green::int, k.state, k.created_at, b.public_id batch FROM commissions k JOIN batches b ON b.id=k.batch_id
    WHERE k.collector_id=$1 ORDER BY k.id DESC LIMIT 30`, [req.auth!.sub]);
  res.json(r.rows);
});
// What the collector owes back after a reversal of commission they had already spent. Shown to them and to finance; never withdrawn automatically.
commissions.get("/me/commissions/recoverable", requireRole("collector"), async (req, res) => {
  const r = await pool.query(`SELECT r.id::text, r.green::int, r.settled_green::int, r.state, r.created_at FROM commission_recoverables r WHERE r.collector_id=$1 ORDER BY r.id DESC LIMIT 50`, [req.auth!.sub]);
  res.json({ openGreen: r.rows.filter(x => x.state === "open").reduce((a, x) => a + x.green - x.settled_green, 0), items: r.rows });
});
commissions.get("/admin/commissions/recoverable", adminOnly("finance"), async (_req, res) => {
  res.json((await pool.query(`SELECT r.id::text, u.public_id collector, r.green::int, r.settled_green::int, r.state, r.created_at, r.commission_id::text FROM commission_recoverables r JOIN users u ON u.id=r.collector_id WHERE r.state='open' ORDER BY r.id LIMIT 200`)).rows);
});
commissions.get("/admin/commissions/reversals", adminOnly("finance"), async (_req, res) => {
  res.json((await pool.query(`SELECT v.id::text, v.kind, v.reverse_green::int, v.recoverable_green::int, v.waived_green::int, v.commission_txn, v.reason, v.created_at, c.public_id collection, u.public_id actor, v.commission_id::text
    FROM commission_reversals v JOIN collections c ON c.id=v.collection_id JOIN users u ON u.id=v.actor ORDER BY v.id DESC LIMIT 200`)).rows);
});
commissions.get("/admin/commissions", admin, async (_req, res) => {
  const r = await pool.query(`SELECT k.id::text, k.green::int, b.public_id batch, b.status batch_status, u.public_id collector
    FROM commissions k JOIN batches b ON b.id=k.batch_id JOIN users u ON u.id=k.collector_id WHERE k.state='pending' ORDER BY k.id LIMIT 200`);
  res.json(r.rows);
});
commissions.post("/admin/commissions/:id/approve", admin, (req, res) => run(res, () => tx(async c => {
  const kid = parseId(req.params.id); if (!kid) throw new Error("invalid_id");
  const r = await c.query("SELECT k.id,k.collector_id,k.green,k.reversed_green,k.state,b.status bs FROM commissions k JOIN batches b ON b.id=k.batch_id WHERE k.id=$1 FOR UPDATE OF k", [kid]);
  const k = r.rows[0]; if (!k || k.state !== "pending") throw new Error("not_pending");
  if (k.bs === "flagged" && req.body?.override !== true) throw new Error("batch_flagged_needs_override");
  const g = Number(k.green) - Number(k.reversed_green), u = `user:${k.collector_id}`; if (g <= 0) throw new Error("fully_reversed");
  await post(c, [{ account: `${u}:pending`, amount: -g }, { account: `${u}:approved`, amount: g }], null, "commission approved");
  await c.query("UPDATE commissions SET state='approved',decided_by=$1,decided_at=now() WHERE id=$2", [req.auth!.sub, k.id]);
  await notify(c, k.collector_id, "commission", "Commission approved", `${g} GREEN commission approved.`);
  await audit(c, req.auth!.sub, "commission.approve", { id: req.params.id });
})));
// v0.30.0: commissions are no longer reversed by hand. They are reversed proportionally and atomically when the collection reward is reversed (adjust / upheld dispute).
commissions.post("/admin/commissions/:id/reverse", admin, (_req, res) => res.status(409).json({ error: "use_collection_adjustment" }));
commissions.post("/admin/collections/:pid/adjust", admin, async (req, res) => {
  try {
    const b = z.object({ reason: z.string().min(3).max(200), amountGreen: z.number().int().min(1).optional(), idempotencyKey: z.string().min(8).max(100).optional(),
      commissionOverride: z.object({ reason: z.string().min(10).max(300), confirm: z.literal(true) }).optional() }).safeParse(req.body);
    if (!b.success) return res.status(400).json({ error: "invalid" });
    if (b.data.amountGreen && !b.data.idempotencyKey) return res.status(400).json({ error: "idempotency_key_required_for_partial" });
    const out = await tx(async c => {
      const id = (await c.query("SELECT id FROM collections WHERE public_id=$1", [req.params.pid])).rows[0]?.id; if (!id) throw new Error("not_adjustable");
      if (b.data.commissionOverride) { // only a super admin holding the explicit permission may leave the commission in place
        const ok = req.adminTier === "super" && (await c.query("SELECT 1 FROM admin_permissions WHERE user_id=$1 AND permission='commission.override_reversal'", [req.auth!.sub])).rowCount;
        if (!ok) throw new Error("override_not_permitted");
      }
      return reverseCollectionReward(c, id, req.auth!.sub, b.data.reason, "admin", { amountGreen: b.data.amountGreen, idempotencyKey: b.data.idempotencyKey, commissionOverride: b.data.commissionOverride });
    });
    res.json({ ok: true, ...out });
  } catch (e: any) { res.status(e?.message === "override_not_permitted" ? 403 : 409).json({ error: safeCode(e) }); }
});
