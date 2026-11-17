import test from "node:test"; import assert from "node:assert/strict"; import pg from "pg"; import { randomUUID } from "node:crypto";
// Needs a THROWAWAY database with schema.sql applied (the ledger is append-only, so test rows cannot be cleaned up).
const url = process.env.TEST_DATABASE_URL;
test("ledger is append-only and must balance", { skip: !url && "set TEST_DATABASE_URL" }, async () => {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try {
    const t = randomUUID();
    await c.query("BEGIN"); await c.query("INSERT INTO ledger_entries(txn_id,account,amount_green) VALUES($1,'t:a',-5),($1,'t:b',5)", [t]); await c.query("COMMIT");
    await assert.rejects(c.query("UPDATE ledger_entries SET amount_green=1 WHERE txn_id=$1", [t]), /append-only/);
    await assert.rejects(c.query("DELETE FROM ledger_entries WHERE txn_id=$1", [t]), /append-only/);
    await c.query("BEGIN"); await c.query("INSERT INTO ledger_entries(txn_id,account,amount_green) VALUES($1,'t:a',7)", [randomUUID()]);
    await assert.rejects(c.query("COMMIT"), /unbalanced/);
  } finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
});
