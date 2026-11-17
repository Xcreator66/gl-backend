import { loadConfig } from "./config.ts";
import { Router } from "express";
import { safeCode } from "./httpErrors.ts";
import { z } from "zod";
import { pool, tx } from "./db.ts";
import { adminOnly } from "./adminAuth.ts";
import { amountPaise, margin } from "./revenue.ts";
import { parseId } from "./pickupRules.ts";

export const revenue = Router();
const fin = adminOnly("finance"), GPI = loadConfig(process.env).greenPerInr;
revenue.get("/admin/revenue/unpriced", fin, async (_req, res) => {
  res.json((await pool.query(`SELECT b.public_id batch, k.material_id, (k.received_grams-k.rejected_grams)::int accepted_grams FROM batch_checks k JOIN batches b ON b.id=k.batch_id
    LEFT JOIN material_revenue r ON r.batch_id=k.batch_id AND r.material_id=k.material_id WHERE r.id IS NULL AND b.status IN ('verified','flagged') AND k.received_grams>k.rejected_grams
    ORDER BY b.created_at LIMIT 200`)).rows);
});
revenue.get("/admin/revenue/unsettled", fin, async (_req, res) => {
  res.json((await pool.query(`SELECT r.id::text id, b.public_id batch, r.material_id, r.accepted_grams, r.amount_paise::int amount_paise FROM material_revenue r JOIN batches b ON b.id=r.batch_id
    WHERE r.settled_at IS NULL ORDER BY r.created_at LIMIT 200`)).rows);
});
// The accepted weight is READ from the recycler's own verification record; the admin only supplies the agreed price.
revenue.post("/admin/revenue", fin, async (req, res) => {
  const b = z.object({ batchPublicId: z.string(), materialId: z.string(), ratePaisePerKg: z.number().int().min(1).max(1_000_000) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid" });
  try {
    const out = await tx(async c => {
      const k = (await c.query(`SELECT b.id batch_id, (k.received_grams-k.rejected_grams) accepted FROM batch_checks k JOIN batches b ON b.id=k.batch_id
        WHERE b.public_id=$1 AND k.material_id=$2 AND b.status IN ('verified','flagged') FOR UPDATE OF b`, [b.data.batchPublicId, b.data.materialId])).rows[0];
      if (!k || k.accepted <= 0) throw new Error("no_verified_weight");
      const amt = amountPaise(k.accepted, b.data.ratePaisePerKg);
      const r = await c.query(`INSERT INTO material_revenue(batch_id,material_id,accepted_grams,rate_paise_per_kg,amount_paise,recorded_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (batch_id,material_id) DO UPDATE SET rate_paise_per_kg=EXCLUDED.rate_paise_per_kg, amount_paise=EXCLUDED.amount_paise, accepted_grams=EXCLUDED.accepted_grams, recorded_by=EXCLUDED.recorded_by
        WHERE material_revenue.settled_at IS NULL RETURNING amount_paise::int`, [k.batch_id, b.data.materialId, k.accepted, b.data.ratePaisePerKg, amt, req.auth!.sub]);
      if (!r.rowCount) throw new Error("already_settled");
      await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'revenue.price',$2)", [req.auth!.sub, { ...b.data, amount_paise: amt }]);
      return r.rows[0];
    });
    res.status(201).json(out);
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});
revenue.post("/admin/revenue/:id/settle", fin, async (req, res) => {
  const b = z.object({ reference: z.string().trim().min(3).max(60) }).safeParse(req.body); if (!b.success) return res.status(400).json({ error: "invalid" });
  const rid = parseId(req.params.id); if (!rid) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("UPDATE material_revenue SET settled_at=now(), settlement_ref=$1 WHERE id=$2 AND settled_at IS NULL", [b.data.reference, rid]);
  if (!r.rowCount) return res.status(409).json({ error: "not_open" });
  await pool.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'revenue.settle',$2)", [req.auth!.sub, { id: req.params.id, reference: b.data.reference }]); res.json({ ok: true });
});
// Monthly view: revenue vs the rupee value of GREEN issued for the same batches. Commission is counted once per batch.
revenue.get("/admin/revenue/summary", fin, async (_req, res) => {
  const a = (await pool.query(`SELECT to_char(date_trunc('month', rv.created_at),'YYYY-MM') AS month, SUM(rv.accepted_grams)::int grams, SUM(rv.amount_paise)::bigint revenue_paise,
    COALESCE(SUM(g.green),0)::bigint reward_green FROM material_revenue rv LEFT JOIN LATERAL (SELECT SUM(c.green_awarded-c.reward_reversed_green) green FROM collections c
    WHERE c.batch_id=rv.batch_id AND c.material_id=rv.material_id AND c.state IN ('pending','approved')) g ON true GROUP BY 1 ORDER BY 1 DESC LIMIT 12`)).rows;
  const k = new Map((await pool.query(`SELECT to_char(date_trunc('month', p.first),'YYYY-MM') AS month, COALESCE(SUM(m.green-m.reversed_green),0)::bigint green
    FROM (SELECT batch_id, MIN(created_at) AS first FROM material_revenue GROUP BY 1) p JOIN commissions m ON m.batch_id=p.batch_id AND m.state<>'reversed' GROUP BY 1`)).rows.map(r => [r.month, Number(r.green)]));
  res.json(a.map(r => ({ month: r.month, grams: r.grams, revenue_paise: Number(r.revenue_paise), ...margin(Number(r.revenue_paise), Number(r.reward_green), k.get(r.month) ?? 0, GPI) })));
});
