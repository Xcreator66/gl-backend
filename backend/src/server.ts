import express from "express";
import { safeCode } from "./httpErrors.ts";
import { account } from "./account.ts";
import { revenue } from "./revenueApi.ts";
import { disputes } from "./disputes.ts";
import { handover } from "./handover.ts";
import { checkMaterial } from "./quality.ts";
import "express-async-errors"; // async handler errors reach the error middleware instead of hanging/crashing
import { z } from "zod";
import { pool, tx } from "./db.ts";
import { post } from "./ledger.ts";
import { issueOtp, checkOtp, sign, requireRole, rateLimit, hit, startCleanup } from "./auth.ts";
import { reconcile } from "./reconcile.ts";
import { greenFor, commission } from "./rewards.ts";
import { community } from "./community.ts";
import { redemption } from "./redemption.ts";
import { me } from "./me.ts";
import { adminApi } from "./admin.ts";
import { notify, notifications, startPushWorker } from "./notify.ts";
import { commissions } from "./commissions.ts";
import { payouts } from "./payouts.ts";
import { identity, identityAdmin, awardXpForCollection } from "./identity.ts";
import { identityRankings, identityRankingsAdmin, startSnapshotWorker } from "./identityRankings.ts";
import { pickups } from "./pickups.ts";
import { adminOnly } from "./adminAuth.ts";
import { exportsApi } from "./exports.ts";
import { groups } from "./groups.ts";
import { moderation } from "./moderation.ts";
import { media, startMediaCleanup } from "./media.ts";
import { organisations } from "./organisations.ts";
import { badgesApi, awardBadges } from "./badgesApi.ts";
import { referrals } from "./referrals.ts";
import { errorResponse } from "./httpErrors.ts";
import { loadConfig, productionProblems } from "./config.ts";

const app = express(); app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY)); // needed behind a load balancer, else rate limits see one IP
app.use((_q, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("Strict-Transport-Security", "max-age=15552000"); next(); });
// One log line per request: method, path (no query string, no body, so no OTPs or personal data), status, duration.
app.use((req, res, next) => { const t = Date.now(); res.on("finish", () => { if (req.path !== "/healthz") console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t })); }); next(); });
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => { // CORS only for the configured admin dashboard origin
  const o = process.env.ADMIN_ORIGIN;
  if (o && req.headers.origin === o) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization"); res.setHeader("Vary", "Origin"); }
  if (req.method === "OPTIONS") return res.sendStatus(204); next();
});
const prodProblems = productionProblems(process.env); if (prodProblems.length) throw new Error("Refusing to start: " + prodProblems.join("; "));
const cfg = loadConfig(process.env); // throws on a mistyped money setting instead of letting it become NaN
const BPS = cfg.commissionBps, TOL = cfg.tolerancePct;
const v1 = express.Router(); app.use("/v1", v1); v1.use(media); v1.use(community); v1.use(redemption); v1.use(me); v1.use(adminApi); v1.use(notifications); v1.use(commissions); v1.use(pickups); v1.use(exportsApi); v1.use(groups); v1.use(organisations); v1.use(moderation); v1.use(badgesApi); v1.use(referrals); v1.use(payouts); v1.use(identity); v1.use(identityAdmin); v1.use(identityRankings); v1.use(identityRankingsAdmin);
const phone = z.string().regex(/^\+91\d{10}$/);

v1.post("/auth/otp", rateLimit(5, 60_000), async (req, res) => {
  const p = phone.safeParse(req.body?.phone); if (!p.success) return res.status(400).json({ error: "bad_phone" });
  // Per-number cap stops SMS flooding of a victim from many IPs (and caps SMS cost).
  if (!(await hit(`otp-phone:${p.data}`, 5, 3_600_000))) return res.status(429).json({ error: "rate_limited" });
  const code = await issueOtp(p.data); res.json(process.env.OTP_MODE === "test" && process.env.NODE_ENV !== "production" ? { ok: true, code } : { ok: true });
});
v1.post("/auth/verify", rateLimit(10, 60_000), async (req, res) => {
  const b = z.object({ phone, code: z.string().length(6) }).safeParse(req.body);
  if (!b.success || !(await checkOtp(b.data.phone, b.data.code))) return res.status(401).json({ error: "invalid_otp" });
  // New users are always 'individual'; collector/recycler/admin roles are granted by an admin only.
  const u = await pool.query(
    `INSERT INTO users(public_id,role,phone) VALUES('GL-U-'||nextval('gl_u_seq'),'individual',$1)
     ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id,role,public_id,role_id`, [b.data.phone]);
  res.json({ token: sign({ sub: u.rows[0].id, role: u.rows[0].role }), role: u.rows[0].role, publicId: u.rows[0].public_id, roleId: u.rows[0].role_id });
});

// Collector records a household collection. Idempotent on idempotencyKey (offline retries are safe).
v1.post("/collections", requireRole("collector"), async (req, res) => {
  const b = z.object({ idempotencyKey: z.string().min(8), householdPublicId: z.string(), materialId: z.string(),
    grams: z.number().int().positive().max(200_000), offline: z.boolean().optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid", detail: b.error.flatten() });
  if (!(await pool.query("SELECT 1 FROM materials WHERE id=$1 AND active", [b.data.materialId])).rowCount) return res.status(409).json({ error: "material_not_available" });
  const result = await tx(async c => {
    // Serialize with the admin role-change transaction. FOR SHARE allows concurrent collections but blocks a role UPDATE until this insert commits.
    const locked = await c.query("SELECT id,public_id,role,deleted_at FROM users WHERE id=$1 OR public_id=$2 ORDER BY id FOR SHARE", [req.auth!.sub, b.data.householdPublicId]);
    const collector = locked.rows.find((u: any) => String(u.id) === req.auth!.sub);
    const household = locked.rows.find((u: any) => u.public_id === b.data.householdPublicId);
    if (!collector || collector.role !== "collector" || collector.deleted_at) return { status: 409, body: { error: "collector_role_changed" } };
    if (!household || household.role !== "individual" || household.deleted_at) return { status: 404, body: { error: "household_not_found" } };
    const inserted = await c.query(
      `INSERT INTO collections(public_id,idempotency_key,household_id,collector_id,material_id,declared_grams,synced_offline)
       VALUES('GL-T-'||nextval('gl_t_seq'),$1,$2,$3,$4,$5,$6)
       ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
         WHERE collections.collector_id=EXCLUDED.collector_id AND collections.household_id=EXCLUDED.household_id
           AND collections.material_id=EXCLUDED.material_id AND collections.declared_grams=EXCLUDED.declared_grams
       RETURNING public_id,state`,
      [b.data.idempotencyKey, household.id, collector.id, b.data.materialId, b.data.grams, !!b.data.offline]);
    if (inserted.rowCount) return { status: 201, body: inserted.rows[0] };
    const existing = await c.query("SELECT 1 FROM collections WHERE idempotency_key=$1", [b.data.idempotencyKey]);
    return existing.rowCount ? { status: 409, body: { error: "idempotency_key_conflict" } } : { status: 404, body: { error: "household_not_found" } };
  });
  return res.status(result.status).json(result.body);
});

v1.post("/batches", requireRole("collector"), async (req, res) => {
  const ids = z.array(z.string()).min(1).safeParse(req.body?.collectionPublicIds);
  if (!ids.success) return res.status(400).json({ error: "invalid" });
  const out = await tx(async c => {
    const b = await c.query("INSERT INTO batches(public_id,collector_id) VALUES('GL-B-'||nextval('gl_b_seq'),$1) RETURNING id,public_id", [req.auth!.sub]);
    const u = await c.query("UPDATE collections SET batch_id=$1 WHERE public_id=ANY($2) AND collector_id=$3 AND batch_id IS NULL",
      [b.rows[0].id, ids.data, req.auth!.sub]);
    if (u.rowCount !== ids.data.length) throw new Error("collections_not_eligible");
    return b.rows[0];
  }).catch(e => ({ error: safeCode(e) })); // business codes pass through; anything else is rethrown to the error middleware (generic 500)
  "error" in out ? res.status(409).json(out) : res.status(201).json({ batchPublicId: out.public_id });
});

// Recycler independently weighs each material in the batch. Server computes everything; rewards stay PENDING.
v1.post("/batches/:pid/verify", requireRole("recycler"), async (req, res) => {
  const b = z.object({ weights: z.record(z.number().int().min(0)), rejected: z.record(z.object({ grams: z.number().int().min(1), reason: z.enum(["contaminated", "wrong_material", "wet", "other"]), note: z.string().max(200).optional() })).optional() }).safeParse(req.body);
  if (!b.success) return res.status(400).json({ error: "invalid" });
  try {
    const result = await tx(async c => {
      const bt = await c.query("SELECT id,collector_id,status,handover_to FROM batches WHERE public_id=$1 FOR UPDATE", [req.params.pid]);
      if (!bt.rowCount) throw new Error("batch_not_found");
      if (bt.rows[0].status === "verified" || bt.rows[0].status === "flagged") throw new Error("already_verified");
      if (bt.rows[0].status !== "handed_over" || bt.rows[0].handover_to !== req.auth!.sub) throw new Error("not_handed_over_to_you");
      const cs = (await c.query(`SELECT c.id,c.public_id,c.household_id,c.material_id,c.declared_grams,m.green_per_kg
        FROM collections c JOIN materials m ON m.id=c.material_id WHERE c.batch_id=$1`, [bt.rows[0].id])).rows;
      let flagged = false, verifiedTotal = 0, pool_ = 0;
      for (const mat of new Set(cs.map(x => x.material_id))) {
        const rows = cs.filter(x => x.material_id === mat);
        if (!(mat in b.data.weights)) throw new Error(`missing_weight_${mat}`);
        const gross = b.data.weights[mat], rej = b.data.rejected?.[mat];
        const lim = (await c.query("SELECT max_contamination_pct m FROM materials WHERE id=$1", [mat])).rows[0]?.m;
        const q = checkMaterial(rows.map(x => ({ txId: x.id, grams: x.declared_grams })), gross, rej?.grams ?? 0, TOL, lim == null ? null : Number(lim)), r = q.rewards;
        await c.query("INSERT INTO batch_checks(batch_id,material_id,received_grams,rejected_grams,reject_reason,note) VALUES($1,$2,$3,$4,$5,$6)", [bt.rows[0].id, mat, gross, rej?.grams ?? 0, rej?.reason ?? null, rej?.note ?? null]);
        flagged ||= q.flagged; verifiedTotal += r.verifiedGrams;
        for (const a of r.allocations) {
          const row = rows.find(x => x.id === a.txId)!, g = greenFor(a.acceptedGrams, row.green_per_kg);
          await c.query("UPDATE collections SET accepted_grams=$1, green_awarded=$3 WHERE id=$2", [a.acceptedGrams, a.txId, g]);
          if (g > 0) await post(c, [{ account: "platform:rewards_pool", amount: -g }, { account: `user:${row.household_id}:pending`, amount: g }], a.txId, "household reward (pending)");
          pool_ += g; await notify(c, row.household_id, "verify", "Collection verified", `${row.public_id}: ${(a.acceptedGrams / 1000).toFixed(2)} kg accepted. ${g} GREEN pending approval.`);
        }
      }
      const comm = commission(pool_, BPS); // separate from household credit; never the whole batch
      if (comm > 0) { await c.query("INSERT INTO commissions(batch_id,collector_id,green) VALUES($1,$2,$3)", [bt.rows[0].id, bt.rows[0].collector_id, comm]); await post(c, [{ account: "platform:commission_pool", amount: -comm }, { account: `user:${bt.rows[0].collector_id}:pending`, amount: comm }], null, "collector commission (pending)"); }
      await c.query("UPDATE batches SET status=$1,verified_grams=$2,recycler_id=$3 WHERE id=$4", [flagged ? "flagged" : "verified", verifiedTotal, req.auth!.sub, bt.rows[0].id]);
      await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'batch.verify',$2)", [req.auth!.sub, { batch: req.params.pid, flagged, verifiedTotal }]);
      return { status: flagged ? "flagged" : "verified", verifiedTotal };
    });
    res.json(result);
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});

// Manual approval (pilot): admin moves a verified collection's reward pending -> approved.
v1.post("/collections/:pid/approve", adminOnly("finance"), async (req, res) => {
  try {
    await tx(async c => {
      const r = await c.query(`SELECT c.id,c.household_id,c.collector_id,c.accepted_grams,c.green_awarded,c.reward_reversed_green,c.state,m.green_per_kg,b.status bs
        FROM collections c JOIN materials m ON m.id=c.material_id LEFT JOIN batches b ON b.id=c.batch_id
        WHERE c.public_id=$1 FOR UPDATE OF c`, [req.params.pid]);
      const x = r.rows[0];
      if (!x || x.state !== "pending" || x.accepted_grams == null) throw new Error("not_approvable");
      if (x.bs === "flagged" && req.body?.override !== true) throw new Error("batch_flagged_needs_override");
      const g = Number(x.green_awarded) - Number(x.reward_reversed_green); // a partly reversed reward approves only what remains
      if (g > 0) await post(c, [{ account: `user:${x.household_id}:pending`, amount: -g }, { account: `user:${x.household_id}:approved`, amount: g }], x.id, "reward approved");
      await c.query("UPDATE collections SET state='approved',approved_at=COALESCE(approved_at,now()) WHERE id=$1", [x.id]);
      await awardBadges(c, x.household_id, "individual"); await awardBadges(c, x.collector_id, "collector"); await awardXpForCollection(c, x.id); // XP: verified weight only, reputation only, never GREEN
      // badges come only from approved (verified) weight; no GREEN is involved
      await notify(c, x.household_id, "reward", "Reward approved", `${req.params.pid}: ${g} GREEN approved.`);
      await c.query("INSERT INTO audit_log(actor,action,detail) VALUES($1,'reward.approve',$2)", [req.auth!.sub, { collection: req.params.pid }]);
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(409).json({ error: safeCode(e) }); }
});

v1.get("/me/balance", requireRole("individual", "collector"), async (req, res) => {
  const r = await pool.query(`SELECT split_part(account,':',3) state, COALESCE(SUM(amount_green),0)::int green
    FROM ledger_entries WHERE account LIKE $1 GROUP BY 1`, [`user:${req.auth!.sub}:%`]);
  res.json(Object.fromEntries(r.rows.map(x => [x.state, x.green])));
});

// Recycler sees only WHICH materials to weigh (not declared weights) so weighing stays independent.
v1.get("/batches/:pid", requireRole("recycler", "admin"), async (req, res) => {
  const r = await pool.query(`SELECT b.status, c.material_id, COUNT(*)::int n FROM batches b JOIN collections c ON c.batch_id=b.id
    WHERE b.public_id=$1 GROUP BY b.status, c.material_id ORDER BY c.material_id`, [req.params.pid]);
  if (!r.rowCount) return res.status(404).json({ error: "batch_not_found" });
  res.json({ status: r.rows[0].status, materials: r.rows.map(x => ({ materialId: x.material_id, items: x.n })) });
});
v1.get("/admin/review", adminOnly("finance"), async (_req, res) => {
  const r = await pool.query(`SELECT c.public_id, c.material_id, c.declared_grams, c.accepted_grams, b.public_id batch, b.status batch_status,
    c.green_awarded::int green FROM collections c JOIN materials m ON m.id=c.material_id
    LEFT JOIN batches b ON b.id=c.batch_id WHERE c.state='pending' AND c.accepted_grams IS NOT NULL ORDER BY c.created_at LIMIT 200`);
  res.json(r.rows);
});

v1.use(handover);
v1.use(disputes);
v1.use(revenue);
v1.use(account);
app.get("/healthz", async (_req, res) => { try { await pool.query("SELECT 1"); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); } });
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { const r = errorResponse(err); if (r.status >= 500) console.error(err); res.status(r.status).json(r.body); });
startPushWorker(); startCleanup(); startMediaCleanup(); startSnapshotWorker();
const server = app.listen(Number(process.env.PORT ?? 3000), () => console.log("GREENLOOP API up"));
// Graceful shutdown: stop accepting requests, let in-flight ones (and their DB transactions) finish, then close the pool. Forced exit after 10 s.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { console.log(`${sig}: shutting down`); setTimeout(() => process.exit(1), 10_000).unref(); server.close(() => pool.end().finally(() => process.exit(0))); });
