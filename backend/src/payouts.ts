import { Router } from "express";
import { z } from "zod";
import type pg from "pg";
import { pool, tx } from "./db.ts";
import { post } from "./ledger.ts";
import { adminOnly, adminPermission } from "./adminAuth.ts";
import { safeCode } from "./httpErrors.ts";
import { notify } from "./notify.ts";
import { canMove, approverAllowed, canStartNewAttempt, reservationFits, ACTIVE, type PayoutStatus } from "./payoutRules.ts";

/** Two-person payout approval. One finance admin PREPARES and SUBMITS; a DIFFERENT one APPROVES; a holder of payout.execute starts and confirms the payment.
 *  Approval never marks anything paid. Starting and confirming payment are refused unless PAYOUT_EXECUTION_ENABLED=true, which stays OFF until the
 *  dual-control workflow has been validated and legal, tax, banking and payment reviews are complete. This module records and controls payouts; it never moves real money. */
export const payouts = Router();
const execEnabled = () => process.env.PAYOUT_EXECUTION_ENABLED === "true";
const prepare = adminPermission("payout.prepare"), approve = adminPermission("payout.approve"), execute = adminPermission("payout.execute"), read = adminOnly("finance");
const ev = (c: pg.PoolClient, id: unknown, from: string | null, to: string, actor: string, note?: string) =>
  c.query("INSERT INTO payout_events(payout_id,from_status,to_status,actor,note) VALUES($1,$2,$3,$4,$5)", [id, from, to, actor, note ?? null]);
const lockedBalance = async (c: pg.PoolClient, uid: string) => Number((await c.query("SELECT COALESCE(SUM(amount_green),0)::bigint b FROM ledger_entries WHERE account=$1", [`user:${uid}:locked`])).rows[0].b);
const audit = (c: pg.PoolClient, actor: string, action: string, detail: object) => c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [actor, action, detail]);
const load = async (c: pg.PoolClient, pid: string, expect: PayoutStatus, to: PayoutStatus) => {
  const p = (await c.query("SELECT * FROM payouts WHERE public_id=$1 FOR UPDATE", [pid])).rows[0];
  if (!p) throw new Error("payout_not_found"); if (p.status !== expect || !canMove(expect, to)) throw new Error("wrong_state"); return p;
};
const run = async (res: any, f: () => Promise<unknown>) => { try { res.json({ ok: true, ...(await f() as object) }); } catch (e: any) { res.status(409).json({ error: safeCode(e) }); } };
const cols = "p.public_id, p.status, p.attempt, p.reserved_green::int green, p.amount_paise::int amount_paise, p.submitted_at, p.approved_at, p.paid_at, p.payment_ref, p.failure_reason, p.reject_reason, r.public_id redemption, pu.public_id prepared_by, au.public_id approved_by, p.created_at";
const from = "FROM payouts p JOIN redemptions r ON r.id=p.redemption_id JOIN users pu ON pu.id=p.prepared_by LEFT JOIN users au ON au.id=p.approved_by";

payouts.get("/admin/payouts", read, async (req, res) => {
  const st = typeof req.query.status === "string" ? req.query.status : null;
  res.json((await pool.query(`SELECT ${cols} ${from} WHERE ($1::text IS NULL OR p.status=$1) ORDER BY p.id DESC LIMIT 200`, [st])).rows);
});
payouts.get("/admin/payouts/:pid/history", read, async (req, res) => {
  res.json((await pool.query(`SELECT e.from_status, e.to_status, u.public_id actor, e.note, e.at FROM payout_events e JOIN payouts p ON p.id=e.payout_id JOIN users u ON u.id=e.actor WHERE p.public_id=$1 ORDER BY e.id`, [req.params.pid])).rows);
});
payouts.get("/admin/payouts-eligible", prepare, async (_req, res) => {
  res.json((await pool.query(`SELECT r.public_id, r.green::int, r.amount_paise::int, r.created_at FROM redemptions r WHERE r.state='requested'
    AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.redemption_id=r.id AND p.status IN ('draft','pending_approval','approved','processing')) ORDER BY r.id LIMIT 100`)).rows);
});
// 1. Prepare: a draft for a requested redemption. Retry after a failed/cancelled/rejected attempt is a new attempt.
payouts.post("/admin/redemptions/:pid/payouts", prepare, (req, res) => run(res, () => tx(async c => {
  const r = (await c.query("SELECT id,user_id,green,amount_paise,state FROM redemptions WHERE public_id=$1 FOR UPDATE", [req.params.pid])).rows[0];
  if (!r || r.state !== "requested") throw new Error("redemption_not_requested");
  const prev = (await c.query("SELECT status FROM payouts WHERE redemption_id=$1", [r.id])).rows.map(x => x.status as PayoutStatus);
  if (!canStartNewAttempt(prev)) throw new Error("payout_already_exists");
  const p = (await c.query(`INSERT INTO payouts(public_id,redemption_id,user_id,attempt,reserved_green,amount_paise,prepared_by) VALUES('GL-PO-'||nextval('gl_po_seq'),$1,$2,$3,$4,$5,$6) RETURNING id,public_id`,
    [r.id, r.user_id, prev.length + 1, r.green, r.amount_paise, req.auth!.sub])).rows[0];
  await ev(c, p.id, null, "draft", req.auth!.sub); await audit(c, req.auth!.sub, "payout.prepare", { payout: p.public_id, redemption: req.params.pid });
  return { payout: p.public_id };
})));
// 2. Submit: validates and reserves against the user's locked balance. The preparer only.
payouts.post("/admin/payouts/:pid/submit", prepare, (req, res) => run(res, () => tx(async c => {
  const p = await load(c, req.params.pid, "draft", "pending_approval");
  if (p.prepared_by !== req.auth!.sub) throw new Error("only_preparer_may_submit");
  await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [p.user_id]); // serialises reservations per user
  const reserved = Number((await c.query("SELECT COALESCE(SUM(reserved_green),0)::bigint s FROM payouts WHERE user_id=$1 AND id<>$2 AND status IN ('pending_approval','approved','processing')", [p.user_id, p.id])).rows[0].s);
  if (!reservationFits(await lockedBalance(c, p.user_id), reserved, Number(p.reserved_green))) throw new Error("insufficient_locked_balance");
  await c.query("UPDATE payouts SET status='pending_approval', submitted_at=now(), updated_at=now() WHERE id=$1", [p.id]);
  await ev(c, p.id, "draft", "submitted", req.auth!.sub); await ev(c, p.id, "submitted", "pending_approval", req.auth!.sub); await audit(c, req.auth!.sub, "payout.submit", { payout: req.params.pid });
})));
// 3. Approve / reject: a different person from the preparer, whatever their tier.
payouts.post("/admin/payouts/:pid/approve", approve, (req, res) => run(res, () => tx(async c => {
  const p = await load(c, req.params.pid, "pending_approval", "approved");
  if (!approverAllowed(p.prepared_by, req.auth!.sub)) throw new Error("self_approval_not_allowed");
  await c.query("UPDATE payouts SET status='approved', approved_by=$1, approved_at=now(), updated_at=now() WHERE id=$2", [req.auth!.sub, p.id]);
  await ev(c, p.id, "pending_approval", "approved", req.auth!.sub); await audit(c, req.auth!.sub, "payout.approve", { payout: req.params.pid, preparedBy: p.prepared_by });
})));
payouts.post("/admin/payouts/:pid/reject", approve, (req, res) => run(res, () => tx(async c => {
  const reason = z.string().min(3).max(200).parse(req.body?.reason);
  const p = await load(c, req.params.pid, "pending_approval", "rejected");
  if (!approverAllowed(p.prepared_by, req.auth!.sub)) throw new Error("self_approval_not_allowed");
  await c.query("UPDATE payouts SET status='rejected', rejected_by=$1, reject_reason=$2, updated_at=now() WHERE id=$3", [req.auth!.sub, reason, p.id]); // reservation released: no longer an active status
  await ev(c, p.id, "pending_approval", "rejected", req.auth!.sub, reason); await audit(c, req.auth!.sub, "payout.reject", { payout: req.params.pid, reason });
})));
payouts.post("/admin/payouts/:pid/cancel", prepare, (req, res) => run(res, () => tx(async c => {
  const p = (await c.query("SELECT * FROM payouts WHERE public_id=$1 FOR UPDATE", [req.params.pid])).rows[0];
  if (!p) throw new Error("payout_not_found"); if (p.prepared_by !== req.auth!.sub) throw new Error("only_preparer_may_cancel");
  if (!ACTIVE.includes(p.status) || !canMove(p.status, "cancelled")) throw new Error("wrong_state");
  await c.query("UPDATE payouts SET status='cancelled', cancelled_by=$1, updated_at=now() WHERE id=$2", [req.auth!.sub, p.id]);
  await ev(c, p.id, p.status, "cancelled", req.auth!.sub, String(req.body?.reason ?? "").slice(0, 200) || undefined); await audit(c, req.auth!.sub, "payout.cancel", { payout: req.params.pid });
})));
// 4. Execution (disabled by default). Approval alone never marks a payout paid.
payouts.post("/admin/payouts/:pid/start", execute, (req, res) => run(res, () => tx(async c => {
  if (!execEnabled()) throw new Error("payout_execution_disabled");
  const p = await load(c, req.params.pid, "approved", "processing");
  await c.query("UPDATE payouts SET status='processing', executed_by=$1, processing_at=now(), updated_at=now() WHERE id=$2", [req.auth!.sub, p.id]);
  await ev(c, p.id, "approved", "processing", req.auth!.sub); await audit(c, req.auth!.sub, "payout.start", { payout: req.params.pid });
})));
payouts.post("/admin/payouts/:pid/paid", execute, (req, res) => run(res, () => tx(async c => {
  if (!execEnabled()) throw new Error("payout_execution_disabled");
  const ref = z.string().min(6).max(40).parse(req.body?.paymentRef);
  const p = await load(c, req.params.pid, "processing", "paid");
  const r = (await c.query("SELECT id,state FROM redemptions WHERE id=$1 FOR UPDATE", [p.redemption_id])).rows[0]; if (!r || r.state !== "requested") throw new Error("redemption_not_requested");
  const g = Number(p.reserved_green), u = `user:${p.user_id}`;
  await post(c, [{ account: `${u}:locked`, amount: -g }, { account: "platform:redeemed", amount: g }], null, "payout recorded (two-person approved)");
  await c.query("UPDATE payouts SET status='paid', payment_ref=$1, paid_at=now(), updated_at=now() WHERE id=$2", [ref, p.id]);
  await c.query("UPDATE redemptions SET state='paid', utr=$1, decided_by=$2, decided_at=now() WHERE id=$3", [ref, req.auth!.sub, r.id]);
  await ev(c, p.id, "processing", "paid", req.auth!.sub, ref); await audit(c, req.auth!.sub, "payout.paid", { payout: req.params.pid, ref, approvedBy: p.approved_by, preparedBy: p.prepared_by });
  await notify(c, p.user_id, "redemption", "Payout sent", `${req.params.pid}: payout recorded (ref ${ref}).`);
})));
payouts.post("/admin/payouts/:pid/failed", execute, (req, res) => run(res, () => tx(async c => {
  const reason = z.string().min(3).max(200).parse(req.body?.reason);
  const p = await load(c, req.params.pid, "processing", "failed");
  await c.query("UPDATE payouts SET status='failed', failure_reason=$1, updated_at=now() WHERE id=$2", [reason, p.id]); // GREEN stays locked on the redemption; a new attempt may be prepared
  await ev(c, p.id, "processing", "failed", req.auth!.sub, reason); await audit(c, req.auth!.sub, "payout.failed", { payout: req.params.pid, reason });
})));
