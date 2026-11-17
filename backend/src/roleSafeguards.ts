import type pg from "pg";
import { blocker, type Blocker } from "./roleRules.ts";
const ids = (r: pg.QueryResult, k = "pid") => r.rows.map(x => String(x[k]));
const bal = async (c: pg.PoolClient, uid: string, state: string) => Number((await c.query("SELECT COALESCE(SUM(amount_green),0)::bigint b FROM ledger_entries WHERE account=$1", [`user:${uid}:${state}`])).rows[0].b);
/** Every outstanding obligation that a role change would strand. Run INSIDE the transaction that holds FOR UPDATE on the user row, so the answer is consistent with the change.
 *  Balances belong to the account, so they block for every role. Returns [] when the role may change. */
export async function findRoleBlockers(c: pg.PoolClient, userId: string, currentRole: string): Promise<Blocker[]> {
  const out: (Blocker | null)[] = [];
  for (const [state, cat] of [["pending", "pending_reward_balance"], ["approved", "approved_reward_balance"], ["locked", "locked_balance"]] as const) { const b = await bal(c, userId, state); out.push(blocker(cat, b > 0 ? 1 : 0, [`${b} GREEN`])); }
  const q = (sql: string) => c.query(sql, [userId]);
  const red = await q("SELECT public_id pid FROM redemptions WHERE user_id=$1 AND state='requested'"); out.push(blocker("pending_redemptions", red.rowCount ?? 0, ids(red)));
  const pay = await q("SELECT public_id pid FROM payouts WHERE user_id=$1 AND status IN ('draft','pending_approval','approved','processing')"); out.push(blocker("active_payouts", pay.rowCount ?? 0, ids(pay)));
  const dis = await q("SELECT d.public_id pid FROM disputes d JOIN collections c ON c.id=d.collection_id WHERE d.state='open' AND (d.raised_by=$1 OR c.household_id=$1 OR c.collector_id=$1)"); out.push(blocker("unresolved_disputes", dis.rowCount ?? 0, ids(dis)));
  const rec = await q("SELECT id::text pid FROM commission_recoverables WHERE collector_id=$1 AND state='open'"); out.push(blocker("recoverable_commission", rec.rowCount ?? 0, ids(rec)));
  if (currentRole === "collector") {
    const ob = await q("SELECT public_id pid FROM batches WHERE collector_id=$1 AND status='open'"); out.push(blocker("open_batches", ob.rowCount ?? 0, ids(ob)));
    const ho = await q("SELECT public_id pid FROM batches WHERE collector_id=$1 AND status='handed_over'"); out.push(blocker("pending_handovers", ho.rowCount ?? 0, ids(ho)));
    const uc = await q("SELECT public_id pid FROM collections WHERE collector_id=$1 AND state='pending'"); out.push(blocker("unverified_collections", uc.rowCount ?? 0, ids(uc)));
    const cm = await q("SELECT id::text pid FROM commissions WHERE collector_id=$1 AND state='pending'"); out.push(blocker("outstanding_commissions", cm.rowCount ?? 0, ids(cm)));
    const pk = await q("SELECT id::text pid FROM pickup_requests WHERE assigned_to=$1 AND state='assigned'"); out.push(blocker("assigned_pickups", pk.rowCount ?? 0, ids(pk)));
  }
  if (currentRole === "recycler") {
    const bw = await q("SELECT public_id pid FROM batches WHERE handover_to=$1 AND status='handed_over'"); out.push(blocker("batches_awaiting_verification", bw.rowCount ?? 0, ids(bw)));
  }
  if (currentRole === "individual") {
    const uc = await q("SELECT public_id pid FROM collections WHERE household_id=$1 AND state='pending'"); out.push(blocker("unverified_collections", uc.rowCount ?? 0, ids(uc)));
  }
  return out.filter((b): b is Blocker => b !== null);
}
