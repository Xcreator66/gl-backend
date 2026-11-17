import { loadConfig } from "./config.ts";
import { Router } from "express";
import { safeCode } from "./httpErrors.ts";
import { z } from "zod";
import { pool, tx } from "./db.ts";
import { post } from "./ledger.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { greenToPaise } from "./rewards.ts";
import { notify } from "./notify.ts";
import { adminOnly } from "./adminAuth.ts";

export const redemption = Router();
const { greenPerInr: GREEN_PER_INR, minRedeemGreen: MIN_GREEN } = loadConfig(process.env);
const enabled = () => process.env.REDEMPTION_ENABLED === "true"; // OFF until legal/tax review is complete

/** Only APPROVED (independently verified) GREEN can be redeemed. It is moved to a 'locked' hold first. */
redemption.post("/redemptions", requireRole("individual", "collector"), rateLimit(5, 60_000), async (req, res) => {
  if (!enabled()) return res.status(503).json({ error: "redemption_disabled" });
  const b = z.object({ idempotencyKey: z.string().min(8), green: z.number().int().min(MIN_GREEN), upiId: z.string().regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid", min: MIN_GREEN });
  try {
    const out = await tx(async c => {
      const uid = req.auth!.sub;
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [uid]); // serialises concurrent requests per user
      const ex = await c.query("SELECT public_id,state FROM redemptions WHERE idempotency_key=$1 AND user_id=$2", [b.data.idempotencyKey, uid]);
      if (ex.rowCount) return ex.rows[0];
      const bal = Number((await c.query("SELECT COALESCE(SUM(amount_green),0)::bigint b FROM ledger_entries WHERE account=$1", [`user:${uid}:approved`])).rows[0].b);
      if (bal < b.data.green) throw new Error("insufficient_approved_balance");
      await post(c, [{ account: `user:${uid}:approved`, amount: -b.data.green }, { account: `user:${uid}:locked`, amount: b.data.green }], null, "redemption hold");
      const r = await c.query(`INSERT INTO redemptions(public_id,idempotency_key,user_id,green,amount_paise,payout_handle)
        VALUES('GL-P-'||nextval('gl_p_seq'),$1,$2,$3,$4,$5) RETURNING public_id,state`,
        [b.data.idempotencyKey, uid, b.data.green, greenToPaise(b.data.green, GREEN_PER_INR), b.data.upiId]);
      return r.rows[0];
    });
    res.status(201).json(out);
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});
redemption.get("/me/redemptions", requireRole("individual", "collector"), async (req, res) => {
  const r = await pool.query("SELECT public_id,green::int,amount_paise::int,state,created_at FROM redemptions WHERE user_id=$1 ORDER BY id DESC LIMIT 20", [req.auth!.sub]);
  res.json(r.rows);
});
redemption.get("/admin/redemptions", adminOnly("finance"), async (_req, res) => {
  const r = await pool.query("SELECT public_id,green::int,amount_paise::int,payout_handle,created_at FROM redemptions WHERE state='requested' ORDER BY id LIMIT 100");
  res.json(r.rows);
});
// Payout itself is made manually by the admin outside this system; they then record the bank reference (UTR) here.
async function decide(pid: string, admin: string, paid: boolean, note: string) {
  await tx(async c => {
    const r = await c.query("SELECT id,user_id,green,state FROM redemptions WHERE public_id=$1 FOR UPDATE", [pid]);
    const x = r.rows[0]; if (!x || x.state !== "requested") throw new Error("not_pending");
    if (paid) throw new Error("use_payout_workflow"); // v0.30.0: payment is only recorded through two-person approval (payouts.ts)
    if ((await c.query("SELECT 1 FROM payouts WHERE redemption_id=$1 AND status IN ('draft','pending_approval','approved','processing')", [x.id])).rowCount) throw new Error("payout_in_progress");
    const g = Number(x.green), u = `user:${x.user_id}`;
    await post(c, paid ? [{ account: `${u}:locked`, amount: -g }, { account: "platform:redeemed", amount: g }]
                       : [{ account: `${u}:locked`, amount: -g }, { account: `${u}:approved`, amount: g }], null, paid ? "payout recorded" : "redemption rejected");
    await c.query("UPDATE redemptions SET state=$1,utr=$2,reject_reason=$3,decided_by=$4,decided_at=now() WHERE id=$5",
      [paid ? "paid" : "rejected", paid ? note : null, paid ? null : note, admin, x.id]);
    await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [admin, paid ? "redemption.paid" : "redemption.rejected", { pid, note }]);
    await notify(c, x.user_id, "redemption", paid ? "Payout sent" : "Redemption rejected", paid ? `${pid}: payout recorded (ref ${note}).` : `${pid}: ${note}. Your GREEN is back in your approved balance.`);
  });
}
// Retired in v0.30.0: one admin could previously record a payout alone. Use /admin/redemptions/:pid/payouts and the approval workflow.
redemption.post("/admin/redemptions/:pid/paid", adminOnly("finance"), (_req, res) => res.status(409).json({ error: "use_payout_workflow" }));
redemption.post("/admin/redemptions/:pid/reject", adminOnly("finance"), async (req, res) => {
  try { await decide(req.params.pid, req.auth!.sub, false, String(req.body?.reason ?? "rejected").slice(0, 200)); res.json({ ok: true }); } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});
