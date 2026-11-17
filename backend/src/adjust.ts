import type pg from "pg";
import { post } from "./ledger.ts";
import { reverseCommissionForCollection, type Override } from "./commissionReversal.ts";
import { reverseXpForCollection } from "./identity.ts";
export interface AdjustOpts { amountGreen?: number; idempotencyKey?: string; commissionOverride?: Override }
/** Reverses a collection's reward (full, or partial with `amountGreen`) back to the platform pool, and automatically reverses the proportional collector commission in the same transaction.
 *  Refused if the household's GREEN was already spent. Idempotent per key (default key = the full reversal of this collection). One implementation for admin adjustments and dispute outcomes. */
export async function reverseCollectionReward(c: pg.PoolClient, collectionId: string, actor: string, reason: string, via: string, opts: AdjustOpts = {}) {
  const x = (await c.query("SELECT id,public_id,household_id,accepted_grams,COALESCE(green_awarded,0)::bigint green_awarded,reward_reversed_green,state FROM collections WHERE id=$1 FOR UPDATE", [collectionId])).rows[0];
  if (!x) throw new Error("not_adjustable");
  const key = opts.idempotencyKey ?? `rev:${x.id}:full`;
  const prior = (await c.query("SELECT id,collection_id,amount_green FROM reward_reversals WHERE idempotency_key=$1", [key])).rows[0];
  if (prior) { if (prior.collection_id !== x.id) throw new Error("idempotency_key_reused"); return { pid: x.public_id as string, household: x.household_id as string, green: Number(prior.amount_green), replay: true }; }
  if (x.accepted_grams == null || !["pending", "approved"].includes(x.state)) throw new Error("not_adjustable");
  const awarded = Number(x.green_awarded), remaining = awarded - Number(x.reward_reversed_green);
  const g = opts.amountGreen ?? remaining;
  if (!Number.isInteger(g) || g < 0 || g > remaining || (g === 0 && awarded > 0)) throw new Error("invalid_reversal_amount");
  const acct = `user:${x.household_id}:${x.state}`; let txn: string | null = null;
  if (g > 0) {
    const bal = Number((await c.query("SELECT COALESCE(SUM(amount_green),0)::bigint b FROM ledger_entries WHERE account=$1", [acct])).rows[0].b);
    if (bal < g) throw new Error("insufficient_balance_to_reverse");
    txn = await post(c, [{ account: acct, amount: -g }, { account: "platform:rewards_pool", amount: g }], x.id, g === remaining ? "reward adjusted (reversed)" : "reward adjusted (partial reversal)");
  }
  const after = Number(x.reward_reversed_green) + g, full = after >= awarded;
  await c.query("UPDATE collections SET reward_reversed_green=$2, state=CASE WHEN $3 THEN 'adjusted'::reward_state ELSE state END WHERE id=$1", [x.id, after, full]);
  const rr = (await c.query("INSERT INTO reward_reversals(idempotency_key,collection_id,amount_green,reward_txn,via,reason,actor) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", [key, x.id, g, txn, via, reason, actor])).rows[0];
  const comm = await reverseCommissionForCollection(c, { collectionId: x.id, rewardReversalId: Number(rr.id), rewardReversedAfter: after, actor, reason, override: opts.commissionOverride });
  await reverseXpForCollection(c, x.id, g, awarded, `${key}:xp`);
  await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'collection.adjust',$2)", [actor, { pid: x.public_id, reason, green: g, via, partial: !full, rewardTxn: txn, commission: comm, override: opts.commissionOverride ? { reason: opts.commissionOverride.reason } : undefined }]);
  return { pid: x.public_id as string, household: x.household_id as string, green: g, commission: comm };
}
