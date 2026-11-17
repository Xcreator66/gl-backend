/** Runs fn inside BEGIN/COMMIT on one connection. Always releases the connection (even when fn or COMMIT throws) and
 *  never lets a failed ROLLBACK hide the real error. Kept free of the pg import so it can be tested with a fake client. */
export interface TxClient { query(sql: string): Promise<unknown>; release(err?: unknown): void }
export async function runInTx<C extends TxClient, T>(connect: () => Promise<C>, fn: (c: C) => Promise<T>): Promise<T> {
  const c = await connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
