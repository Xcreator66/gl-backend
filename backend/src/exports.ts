import { Router } from "express";
import { pool } from "./db.ts";
import { adminOnly } from "./adminAuth.ts";
import { allowed, type Tier } from "./tiers.ts";
import { toCsv } from "./csv.ts";
import { COLLECTOR_ACCURACY_SQL } from "./collectorAccuracy.ts";

/** CSV exports for pilot reporting. Public IDs only: no phone numbers, UPI handles or internal UUIDs.
 *  Numeric columns are cast to int/float8 in SQL so they stay numbers (pg returns bigint/numeric as strings). */
export const exportsApi = Router();
const LIMIT = 100000;
const E: Record<string, { tiers: Tier[]; cols: string[]; sql: string }> = {
  collections: { tiers: ["ops", "finance"],
    cols: ["public_id", "created_at", "household", "collector", "material_id", "declared_g", "accepted_g", "green_awarded", "state", "batch", "synced_offline"],
    sql: `SELECT c.public_id, c.created_at, h.public_id household, k.public_id collector, c.material_id, c.declared_grams declared_g, c.accepted_grams accepted_g,
      c.green_awarded::int green_awarded, c.state, b.public_id batch, c.synced_offline
      FROM collections c JOIN users h ON h.id=c.household_id JOIN users k ON k.id=c.collector_id LEFT JOIN batches b ON b.id=c.batch_id ORDER BY c.created_at, c.id LIMIT ${LIMIT}` },
  batches: { tiers: ["ops", "finance"],
    cols: ["public_id", "status", "collector", "recycler", "created_at", "items", "declared_g", "verified_g", "discrepancy_pct"],
    sql: `SELECT b.public_id, b.status, k.public_id collector, r.public_id recycler, b.created_at, COUNT(c.id)::int items,
      COALESCE(SUM(c.declared_grams),0)::int declared_g, b.verified_grams verified_g,
      CASE WHEN b.verified_grams IS NULL OR COALESCE(SUM(c.declared_grams),0)=0 THEN NULL
        ELSE round(((SUM(c.declared_grams)-b.verified_grams)::numeric/SUM(c.declared_grams))*100,1)::float8 END discrepancy_pct
      FROM batches b JOIN users k ON k.id=b.collector_id LEFT JOIN users r ON r.id=b.recycler_id LEFT JOIN collections c ON c.batch_id=b.id
      GROUP BY b.id, k.public_id, r.public_id ORDER BY b.created_at, b.id LIMIT ${LIMIT}` },
  // Adoption, frequency and weight accuracy per week (weeks start Monday, database time zone). Accuracy = accepted_verified_g / declared_verified_g.
  weekly: { tiers: ["ops", "finance"],
    cols: ["week_start", "new_households", "active_households", "collections", "declared_g", "verified_collections", "declared_verified_g", "accepted_g"],
    sql: `SELECT to_char(d.wk,'YYYY-MM-DD') week_start,
      (SELECT COUNT(*) FROM users u WHERE u.role='individual' AND date_trunc('week',u.created_at)=d.wk)::int new_households,
      COUNT(DISTINCT c.household_id)::int active_households, COUNT(c.id)::int collections,
      COALESCE(SUM(c.declared_grams),0)::int declared_g,
      (COUNT(c.id) FILTER (WHERE c.accepted_grams IS NOT NULL))::int verified_collections,
      COALESCE(SUM(c.declared_grams) FILTER (WHERE c.accepted_grams IS NOT NULL),0)::int declared_verified_g,
      COALESCE(SUM(c.accepted_grams),0)::int accepted_g
      FROM generate_series(date_trunc('week',(SELECT MIN(created_at) FROM users)), date_trunc('week',now()), interval '1 week') d(wk)
      LEFT JOIN collections c ON date_trunc('week',c.created_at)=d.wk GROUP BY d.wk ORDER BY d.wk` },
  collector_accuracy: { tiers: ["ops", "finance"], cols: ["collector", "batches", "flagged", "declared_g", "verified_g", "discrepancy_pct"], sql: COLLECTOR_ACCURACY_SQL },
  redemptions: { tiers: ["finance"],
    cols: ["public_id", "user", "green", "amount_inr", "state", "utr", "reject_reason", "created_at", "decided_at"],
    sql: `SELECT r.public_id, u.public_id "user", r.green::int green, (r.amount_paise/100.0)::float8 amount_inr, r.state, r.utr, r.reject_reason, r.created_at, r.decided_at
      FROM redemptions r JOIN users u ON u.id=r.user_id ORDER BY r.id LIMIT ${LIMIT}` },
  // Account names embed internal user UUIDs; they are swapped for public IDs here.
  ledger: { tiers: ["finance"],
    cols: ["id", "txn_id", "created_at", "account", "amount_green", "collection", "memo"],
    sql: `SELECT e.id::text id, e.txn_id, e.created_at,
      CASE WHEN e.account LIKE 'user:%' THEN 'user:'||COALESCE(u.public_id,'unknown')||':'||split_part(e.account,':',3) ELSE e.account END account,
      e.amount_green::int amount_green, c.public_id collection, e.memo
      FROM ledger_entries e LEFT JOIN users u ON e.account LIKE 'user:%' AND u.id::text=split_part(e.account,':',2)
      LEFT JOIN collections c ON c.id=e.ref_collection ORDER BY e.id LIMIT ${LIMIT}` },
};
export const EXPORT_NAMES = Object.keys(E);

exportsApi.get("/admin/export", adminOnly("ops", "finance"), (req, res) => {
  res.json(EXPORT_NAMES.filter(n => allowed(req.adminTier, E[n].tiers)));
});
exportsApi.get("/admin/export/:name", adminOnly("ops", "finance"), async (req, res) => {
  const spec = Object.hasOwn(E, req.params.name) ? E[req.params.name] : null;
  if (!spec) return res.status(404).json({ error: "unknown_export" });
  if (!allowed(req.adminTier, spec.tiers)) return res.status(403).json({ error: "forbidden" });
  const r = await pool.query(spec.sql);
  await pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'export.csv',$2)", [req.auth!.sub, { name: req.params.name, rows: r.rowCount }]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `attachment; filename="greenloop-${req.params.name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(r.rows, spec.cols));
});
