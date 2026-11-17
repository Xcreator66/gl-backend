import { runInTx } from "./txRunner.ts";
import pg from "pg";
// statement_timeout stops one slow query from holding a connection for ever; idle_in_transaction cleans up after a crashed request.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_MAX ?? 10),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 15000), idle_in_transaction_session_timeout: 30000, connectionTimeoutMillis: 5000 });
// An error on an IDLE connection (database restart, network drop) is emitted here; unhandled, it would crash the whole process.
pool.on("error", e => console.error("pg pool idle client error:", e.message));
export const tx = <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => runInTx(() => pool.connect(), fn);
