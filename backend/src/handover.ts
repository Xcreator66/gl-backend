import { Router } from "express";
import { safeCode } from "./httpErrors.ts";
import { z } from "zod";
import { pool, tx } from "./db.ts";
import { requireRole } from "./auth.ts";
import { notify } from "./notify.ts";
import { parseRoleId } from "./roleIds.ts";

export const handover = Router();
handover.get("/recyclers", requireRole("collector"), async (_req, res) => {
  res.json((await pool.query("SELECT role_id, COALESCE(display_name,role_id) name FROM users WHERE role='recycler' ORDER BY 2")).rows);
});
handover.get("/collector/batches", requireRole("collector"), async (req, res) => {
  res.json((await pool.query(`SELECT b.public_id, b.status, b.created_at, (SELECT COUNT(*)::int FROM collections c WHERE c.batch_id=b.id) items
    FROM batches b WHERE b.collector_id=$1 ORDER BY b.created_at DESC LIMIT 20`, [req.auth!.sub])).rows);
});
// Only the recycler a batch was handed to may verify it.
handover.post("/batches/:pid/handover", requireRole("collector"), async (req, res) => {
  const b = z.object({ recyclerId: z.string().max(40) }).safeParse(req.body); const rid = b.success ? parseRoleId(b.data.recyclerId, "recycler") : null;
  if (!rid) return res.status(400).json({ error: "invalid_recycler_id" }); // malformed or mistyped: rejected before any lookup
  try {
    await tx(async c => {
      const bt = (await c.query("SELECT id,status FROM batches WHERE public_id=$1 AND collector_id=$2 FOR UPDATE", [req.params.pid, req.auth!.sub])).rows[0];
      if (!bt) throw new Error("batch_not_found"); if (bt.status !== "open") throw new Error("already_handed_over");
      const rc = (await c.query("SELECT id FROM users WHERE role_id=$1 AND role='recycler'", [rid])).rows[0]; if (!rc) throw new Error("recycler_not_found");
      await c.query("UPDATE batches SET status='handed_over', handover_to=$1, handed_over_at=now() WHERE id=$2", [rc.id, bt.id]);
      await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'batch.handover',$2)", [req.auth!.sub, { batch: req.params.pid, to: rid }]);
      await notify(c, rc.id, "handover", "Batch ready to verify", `${req.params.pid} was handed over to you.`);
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});
handover.get("/recycler/incoming", requireRole("recycler"), async (req, res) => {
  res.json((await pool.query(`SELECT b.public_id, b.handed_over_at, (SELECT COUNT(*)::int FROM collections c WHERE c.batch_id=b.id) items
    FROM batches b WHERE b.handover_to=$1 AND b.status='handed_over' ORDER BY b.handed_over_at`, [req.auth!.sub])).rows);
});
