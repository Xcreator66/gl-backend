import { Router } from "express";
import { safeCode } from "./httpErrors.ts";
import { z } from "zod";
import { pool, tx } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { adminOnly } from "./adminAuth.ts";
import { notify } from "./notify.ts";
import { reverseCollectionReward } from "./adjust.ts";
import { canRaise, outcomeState, REASONS, OUTCOMES } from "./disputeRules.ts";

export const disputes = Router();
const member = requireRole("individual", "collector"), WINDOW = Number(process.env.DISPUTE_DAYS ?? 14);

disputes.post("/disputes", member, rateLimit(5, 60_000), async (req, res) => {
  const b = z.object({ collectionPublicId: z.string(), reason: z.enum(REASONS), detail: z.string().trim().max(300).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid" });
  try {
    const out = await tx(async c => {
      const x = (await c.query("SELECT id,public_id,household_id,collector_id,accepted_grams,state,created_at FROM collections WHERE public_id=$1 FOR UPDATE", [b.data.collectionPublicId])).rows[0];
      if (!x) throw new Error("not_your_collection");
      const v = canRaise(x, req.auth!.sub, new Date(), WINDOW); if (!v.ok) throw new Error(v.error);
      if ((await c.query("SELECT 1 FROM disputes WHERE collection_id=$1 AND state='open'", [x.id])).rowCount) throw new Error("already_open");
      const r = await c.query("INSERT INTO disputes(public_id,collection_id,raised_by,raiser_role,reason,detail) VALUES('GL-D-'||nextval('gl_d_seq'),$1,$2,$3,$4,$5) RETURNING public_id",
        [x.id, req.auth!.sub, v.who, b.data.reason, b.data.detail ?? null]);
      await notify(c, v.who === "household" ? x.collector_id : x.household_id, "dispute", "A problem was reported", `${x.public_id}: a report was raised and an admin will review it.`);
      return r.rows[0];
    });
    res.status(201).json(out);
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});
// Reports I raised AND reports about my collections. The person being reported sees the reason, progress and outcome, but never the other
// person's free-text detail or the reviewer's note (those are addressed to whoever raised the report).
disputes.get("/me/disputes", member, async (req, res) => {
  res.json((await pool.query(`SELECT d.public_id, d.reason, d.state, d.raiser_role, d.created_at, d.resolved_at, c.public_id collection, c.material_id, (d.raised_by=$1) mine,
      CASE WHEN d.raised_by=$1 THEN d.detail END detail, CASE WHEN d.raised_by=$1 THEN d.resolution_note END resolution_note
    FROM disputes d JOIN collections c ON c.id=d.collection_id WHERE d.raised_by=$1 OR c.household_id=$1 OR c.collector_id=$1 ORDER BY d.id DESC LIMIT 30`, [req.auth!.sub])).rows);
});
// A collector's verified collections that can still be reported (same rules as canRaise: verified, pending/approved, inside the window, none open).
disputes.get("/collector/reportable", requireRole("collector"), async (req, res) => {
  res.json((await pool.query(`SELECT c.public_id, c.material_id, c.declared_grams, c.accepted_grams, c.created_at FROM collections c
    WHERE c.collector_id=$1 AND c.accepted_grams IS NOT NULL AND c.state IN ('pending','approved') AND c.created_at > now() - ($2 || ' days')::interval
    AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.collection_id=c.id AND d.state='open') ORDER BY c.created_at DESC LIMIT 30`, [req.auth!.sub, String(WINDOW)])).rows);
});
disputes.post("/disputes/:pid/withdraw", member, async (req, res) => {
  const r = await pool.query("UPDATE disputes SET state='withdrawn', resolved_at=now() WHERE public_id=$1 AND raised_by=$2 AND state='open'", [req.params.pid, req.auth!.sub]);
  r.rowCount ? res.json({ ok: true }) : res.status(409).json({ error: "not_open" });
});
disputes.get("/admin/disputes", adminOnly("finance", "ops"), async (_req, res) => {
  res.json((await pool.query(`SELECT d.public_id, d.reason, d.detail, d.raiser_role, d.created_at, u.public_id raised_by, c.public_id collection, c.material_id,
    c.declared_grams, c.accepted_grams, c.state collection_state, b.status batch_status FROM disputes d JOIN collections c ON c.id=d.collection_id JOIN users u ON u.id=d.raised_by
    LEFT JOIN batches b ON b.id=c.batch_id WHERE d.state='open' ORDER BY d.created_at LIMIT 100`)).rows);
});
// Money-affecting, so finance (or super) only. 'adjust' reverses the reward; nothing here can add GREEN.
disputes.post("/admin/disputes/:pid/resolve", adminOnly("finance"), async (req, res) => {
  const b = z.object({ outcome: z.enum(OUTCOMES), note: z.string().trim().min(3).max(300) }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid" });
  try {
    await tx(async c => {
      const d = (await c.query("SELECT id,collection_id,raised_by,state FROM disputes WHERE public_id=$1 FOR UPDATE", [req.params.pid])).rows[0];
      if (!d || d.state !== "open") throw new Error("not_open");
      let adj: { pid: string; household: string; green: number } | null = null;
      if (b.data.outcome === "adjust") adj = await reverseCollectionReward(c, d.collection_id, req.auth!.sub, `dispute ${req.params.pid}: ${b.data.note}`, "dispute");
      await c.query("UPDATE disputes SET state=$1, resolution_note=$2, resolved_by=$3, resolved_at=now() WHERE id=$4", [outcomeState(b.data.outcome), b.data.note, req.auth!.sub, d.id]);
      await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'dispute.resolve',$2)", [req.auth!.sub, { dispute: req.params.pid, outcome: b.data.outcome }]);
      await notify(c, d.raised_by, "dispute", "Your report was reviewed", `${req.params.pid}: ${b.data.outcome === "reject" ? "no change was made" : "your report was upheld"}. Open it to read the note.`);
      if (adj) await notify(c, adj.household, "reward", "A reward was adjusted", `${adj.pid}: ${adj.green} GREEN was reversed after a review.`);
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});
