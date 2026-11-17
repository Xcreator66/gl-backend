import { Router } from "express";
import { z } from "zod";
import { pool } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { parseId } from "./pickupRules.ts";
import { adminOnly } from "./adminAuth.ts";

export const me = Router();
const member = requireRole("individual", "collector");

// ESTIMATE factors (kg CO2e avoided per kg recycled). PLACEHOLDERS - validate against a published source before showing publicly.
export const CO2E_PER_KG: Record<string, number> = { PET: 1.5, ALU: 9, GLS: 0.3, PLS: 1.0, PAP: 0.9 };

me.get("/materials", member, async (_req, res) => {
  const r = await pool.query("SELECT id,name,green_per_kg FROM materials WHERE active ORDER BY name"); res.json(r.rows);
});
// Receipts: declared vs accepted weight and the GREEN calculation (accepted kg x rate). Declared never earns rewards.
me.get("/me/collections", member, async (req, res) => {
  const r = await pool.query(`SELECT c.public_id, c.material_id, c.declared_grams, c.accepted_grams, c.state, c.created_at, m.green_per_kg,
    c.green_awarded::int green, EXISTS(SELECT 1 FROM disputes d WHERE d.collection_id=c.id AND d.state='open') open_dispute
    FROM collections c JOIN materials m ON m.id=c.material_id WHERE c.household_id=$1 ORDER BY c.created_at DESC LIMIT 50`, [req.auth!.sub]);
  res.json(r.rows);
});
me.get("/me/impact", member, async (req, res) => {
  const r = await pool.query(`SELECT material_id, SUM(accepted_grams)::int grams, COUNT(*)::int n FROM collections
    WHERE household_id=$1 AND state='approved' GROUP BY material_id ORDER BY grams DESC`, [req.auth!.sub]);
  const co2 = r.rows.reduce((s, x) => s + (x.grams / 1000) * (CO2E_PER_KG[x.material_id] ?? 0), 0);
  res.json({ byMaterial: r.rows, verifiedGrams: r.rows.reduce((s, x) => s + x.grams, 0), collections: r.rows.reduce((s, x) => s + x.n, 0),
    co2eKgEstimate: Math.round(co2 * 10) / 10, co2eIsEstimate: true });
});
me.post("/pickup-requests", member, rateLimit(5, 60_000), async (req, res) => {
  const b = z.object({ materialId: z.string(), mode: z.enum(["pickup", "deposit"]), estGrams: z.number().int().positive().max(200_000).optional(),
    windowText: z.string().trim().max(80).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid" });
  const open = await pool.query("SELECT COUNT(*)::int n FROM pickup_requests WHERE user_id=$1 AND state='open'", [req.auth!.sub]);
  if (open.rows[0].n >= 5) return res.status(409).json({ error: "too_many_open_requests" });
  try { const r = await pool.query("INSERT INTO pickup_requests(user_id,material_id,mode,est_grams,window_text) VALUES($1,$2,$3,$4,$5) RETURNING id::text",
    [req.auth!.sub, b.data.materialId, b.data.mode, b.data.estGrams ?? null, b.data.windowText ?? null]); res.status(201).json(r.rows[0]); }
  catch { res.status(400).json({ error: "unknown_material" }); }
});
me.get("/me/pickup-requests", member, async (req, res) => {
  const r = await pool.query("SELECT id::text,material_id,mode,est_grams,window_text,state,created_at FROM pickup_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 20", [req.auth!.sub]);
  res.json(r.rows);
});
me.post("/pickup-requests/:id/cancel", member, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
  // v0.12: also cancellable once a collector has claimed it; the collector is told.
  const r = await pool.query("UPDATE pickup_requests SET state='cancelled' WHERE id=$1 AND user_id=$2 AND state IN ('open','assigned') RETURNING assigned_to", [id, req.auth!.sub]);
  if (!r.rowCount) return res.status(409).json({ error: "not_open" });
  if (r.rows[0].assigned_to) await pool.query("INSERT INTO notifications(user_id,kind,title,body) VALUES($1,'pickup','Request cancelled','A household cancelled a collection request you had accepted.')", [r.rows[0].assigned_to]);
  res.json({ ok: true });
});
me.get("/admin/pickup-requests", adminOnly("ops"), async (_req, res) => {
  const r = await pool.query(`SELECT p.id::text, u.public_id user_id, p.material_id, p.mode, p.est_grams, p.window_text, p.state, c.public_id collector, p.created_at
    FROM pickup_requests p JOIN users u ON u.id=p.user_id LEFT JOIN users c ON c.id=p.assigned_to WHERE p.state IN ('open','assigned') ORDER BY p.id LIMIT 200`); res.json(r.rows);
});
