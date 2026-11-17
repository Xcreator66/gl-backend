import { Router } from "express";
import { safeCode } from "./httpErrors.ts";
import { pool, tx } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { notify } from "./notify.ts";
import { MAX_ASSIGNED_PER_COLLECTOR, parseId } from "./pickupRules.ts";

/** Collector-facing view of household collection requests (v0.12).
 *  Collectors see only the household's public ID, material, mode, estimate and time window - never phone or address.
 *  A request is a REQUEST only: it earns nothing. Rewards still come solely from independently verified weight. */
export const pickups = Router();
const collector = requireRole("collector");
const audit = (c: { query: Function }, actor: string, action: string, detail: object) => c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,$2,$3)", [actor, action, detail]);

const cols = `p.id::text, u.public_id household, p.material_id, p.mode, p.est_grams, p.window_text, p.created_at`;
pickups.get("/collector/requests", collector, async (req, res) => {
  const [open, mine] = await Promise.all([
    pool.query(`SELECT ${cols} FROM pickup_requests p JOIN users u ON u.id=p.user_id WHERE p.state='open' ORDER BY p.id LIMIT 50`),
    pool.query(`SELECT ${cols}, p.assigned_at FROM pickup_requests p JOIN users u ON u.id=p.user_id WHERE p.state='assigned' AND p.assigned_to=$1 ORDER BY p.id LIMIT 50`, [req.auth!.sub])]);
  res.json({ open: open.rows, mine: mine.rows, maxAssigned: MAX_ASSIGNED_PER_COLLECTOR });
});

pickups.post("/collector/requests/:id/claim", collector, rateLimit(30, 60_000), async (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
  try {
    await tx(async c => {
      await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [req.auth!.sub]); // serialises this collector's claims so the cap cannot be raced
      const n = (await c.query("SELECT COUNT(*)::int n FROM pickup_requests WHERE assigned_to=$1 AND state='assigned'", [req.auth!.sub])).rows[0].n;
      if (n >= MAX_ASSIGNED_PER_COLLECTOR) throw new Error("too_many_assigned");
      const r = await c.query("UPDATE pickup_requests SET state='assigned',assigned_to=$2,assigned_at=now() WHERE id=$1 AND state='open' RETURNING user_id,material_id", [id, req.auth!.sub]);
      if (!r.rowCount) throw new Error("not_open"); // already claimed by someone else, cancelled, or does not exist
      await notify(c, r.rows[0].user_id, "pickup", "Collector assigned", "A collector accepted your collection request. Weights are verified later by the recycler before any reward.");
      await audit(c, req.auth!.sub, "pickup.claim", { id });
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});

pickups.post("/collector/requests/:id/release", collector, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
  const r = await pool.query("UPDATE pickup_requests SET state='open',assigned_to=NULL,assigned_at=NULL WHERE id=$1 AND state='assigned' AND assigned_to=$2 RETURNING id", [id, req.auth!.sub]);
  r.rowCount ? res.json({ ok: true }) : res.status(409).json({ error: "not_yours_or_not_assigned" });
});

pickups.post("/collector/requests/:id/done", collector, async (req, res) => {
  const id = parseId(req.params.id); if (!id) return res.status(400).json({ error: "invalid" });
  try {
    await tx(async c => {
      const r = await c.query("UPDATE pickup_requests SET state='done',done_at=now() WHERE id=$1 AND state='assigned' AND assigned_to=$2 RETURNING user_id", [id, req.auth!.sub]);
      if (!r.rowCount) throw new Error("not_yours_or_not_assigned");
      await notify(c, r.rows[0].user_id, "pickup", "Collection marked done", "Your collector marked this request done. GREEN is credited only after the recycler verifies the weight and an admin approves it.");
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});
