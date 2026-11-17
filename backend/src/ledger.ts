import type pg from "pg";
import { randomUUID } from "node:crypto";
export interface Line { account: string; amount: number }
/** Posts one balanced transaction. Throws if lines do not net to zero (DB trigger also enforces). */
export async function post(c: pg.PoolClient, lines: Line[], ref: string | null, memo: string): Promise<string> {
  if (lines.reduce((s, l) => s + l.amount, 0) !== 0) throw new Error("unbalanced ledger lines");
  const txn = randomUUID();
  for (const l of lines)
    await c.query("INSERT INTO ledger_entries(txn_id,account,amount_green,ref_collection,memo) VALUES($1,$2,$3,$4,$5)",
      [txn, l.account, l.amount, ref, memo]);
  return txn;
}
