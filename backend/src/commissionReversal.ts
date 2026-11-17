import type pg from "pg";
import { post } from "./ledger.ts";
import { commissionDelta, splitRecoverable } from "./commissionMath.ts";
const bal = async (c: pg.PoolClient, account: string) => Number((await c.query("SELECT COALESCE(SUM(amount_green),0)::bigint b FROM ledger_entries WHERE account=$1", [account])).rows[0].b);
export interface Override { reason: string }
/** Called INSIDE the reward-reversal transaction, so the reward and commission reversals commit or roll back together.
 *  Reverses the collection's proportional share of the batch commission. What the collector can no longer give back (already spent/paid) is recorded
 *  as a recoverable balance; nothing is withdrawn externally and no earlier row is changed. With `override`, the commission is deliberately left in place
 *  (recorded as waived, with reason and actor); the caller has already verified the super-admin permission. */
export async function reverseCommissionForCollection(c: pg.PoolClient, p: { collectionId: string; rewardReversalId: number; rewardReversedAfter: number; actor: string; reason: string; override?: Override }) {
  const col = (await c.query("SELECT batch_id, COALESCE(green_awarded,0)::bigint g FROM collections WHERE id=$1", [p.collectionId])).rows[0];
  if (!col?.batch_id) return null;
  const k = (await c.query("SELECT id,collector_id,green,state FROM commissions WHERE batch_id=$1 ORDER BY id LIMIT 1 FOR UPDATE", [col.batch_id])).rows[0];
  if (!k) return null;
  const batchGreen = Number((await c.query("SELECT COALESCE(SUM(green_awarded),0)::bigint s FROM collections WHERE batch_id=$1", [col.batch_id])).rows[0].s);
  const sums = (await c.query(`SELECT COALESCE(SUM(reverse_green+recoverable_green+waived_green),0)::bigint t,
      COALESCE(SUM(reverse_green+recoverable_green+waived_green) FILTER (WHERE collection_id=$2),0)::bigint tc FROM commission_reversals WHERE commission_id=$1`, [k.id, p.collectionId])).rows[0];
  const delta = commissionDelta({ commissionGreen: Number(k.green), batchGreen, collectionGreen: Number(col.g), rewardReversedAfter: p.rewardReversedAfter,
    alreadyProcessedForCollection: Number(sums.tc), alreadyProcessedForCommission: Number(sums.t) });
  if (delta <= 0) return { commissionId: Number(k.id), reversed: 0, recoverable: 0, waived: 0, txn: null as string | null };
  if (p.override) {
    await c.query(`INSERT INTO commission_reversals(commission_id,collection_id,reward_reversal_id,kind,waived_green,reason,actor) VALUES($1,$2,$3,'override_waived',$4,$5,$6)`,
      [k.id, p.collectionId, p.rewardReversalId, delta, p.override.reason, p.actor]);
    return { commissionId: Number(k.id), reversed: 0, recoverable: 0, waived: delta, txn: null };
  }
  const acct = `user:${k.collector_id}:${k.state === "approved" ? "approved" : "pending"}`;
  const { take, recoverable } = splitRecoverable(delta, await bal(c, acct));
  const txn = take > 0 ? await post(c, [{ account: acct, amount: -take }, { account: "platform:commission_pool", amount: take }], null, "commission reversed (proportional)") : null;
  const rv = (await c.query(`INSERT INTO commission_reversals(commission_id,collection_id,reward_reversal_id,kind,reverse_green,recoverable_green,commission_txn,reason,actor)
    VALUES($1,$2,$3,'automatic',$4,$5,$6,$7,$8) RETURNING id`, [k.id, p.collectionId, p.rewardReversalId, take, recoverable, txn, p.reason, p.actor])).rows[0];
  if (recoverable > 0) await c.query("INSERT INTO commission_recoverables(commission_id,collector_id,reversal_id,green) VALUES($1,$2,$3,$4)", [k.id, k.collector_id, rv.id, recoverable]);
  await c.query("UPDATE commissions SET reversed_green=reversed_green+$1, state=CASE WHEN reversed_green+$1>=green THEN 'reversed' ELSE state END WHERE id=$2", [take + recoverable, k.id]);
  return { commissionId: Number(k.id), reversed: take, recoverable, waived: 0, txn };
}
