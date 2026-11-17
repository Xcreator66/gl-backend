// Applies db/schema.sql then db/NNN_*.sql in order, each in its own transaction, recording what ran in schema_migrations.
//   node scripts/migrate.mjs              apply anything pending
//   node scripts/migrate.mjs --status     show applied / pending
//   node scripts/migrate.mjs --baseline 012   a database you already built by hand: mark schema.sql..012 as applied WITHOUT running them
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import pg from "pg";
import { orderMigrations } from "./migrationOrder.mjs";
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db");
const all = orderMigrations(fs.readdirSync(dir));
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const arg = process.argv[2], baseline = arg === "--baseline" ? process.argv[3] : null;
try {
  await db.query("SELECT pg_advisory_lock(727274)"); // two deploys cannot migrate at once
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query("SELECT name FROM schema_migrations")).rows.map(r => r.name));
  if (arg === "--status") { for (const f of all) console.log(`${done.has(f) ? "applied" : "PENDING"}  ${f}`); process.exit(0); }
  if (baseline) {
    const upto = all.filter(f => f === "schema.sql" || Number(f.slice(0, 3)) <= Number(baseline));
    if (!/^\d{3}$/.test(baseline) || upto.length < 2) throw new Error("usage: --baseline 012");
    for (const f of upto) await db.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING", [f]);
    console.log(`Marked ${upto.length} files as applied (not executed). Now run without arguments to apply the rest.`); process.exit(0);
  }
  if (!done.size && (await db.query("SELECT to_regclass('public.users') t")).rows[0].t)
    throw new Error("This database already has tables but no migration history. If it was built by hand with the SQL files, run: node scripts/migrate.mjs --baseline <last file number you applied>");
  for (const f of all.filter(f => !done.has(f))) {
    process.stdout.write(`applying ${f} ... `);
    try { await db.query("BEGIN"); await db.query(fs.readFileSync(path.join(dir, f), "utf8")); await db.query("INSERT INTO schema_migrations(name) VALUES($1)", [f]); await db.query("COMMIT"); console.log("ok"); }
    catch (e) { await db.query("ROLLBACK").catch(() => {}); console.log("FAILED"); throw e; }
  }
  console.log("Database is up to date.");
} catch (e) { console.error(e.message); process.exitCode = 1; } finally { await db.end(); }
