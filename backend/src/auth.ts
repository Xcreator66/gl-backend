import jwt from "jsonwebtoken";
import { randomInt } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
const SECRET = process.env.JWT_SECRET!;
if (!SECRET || SECRET.length < 16) throw new Error("JWT_SECRET missing/too short");
if (process.env.NODE_ENV === "production" && ["dev", "test"].includes(process.env.OTP_MODE ?? "dev")) throw new Error("Refusing to start: set OTP_MODE=webhook in production");
export interface Auth { sub: string; role: "individual" | "collector" | "recycler" | "admin" }
declare module "express-serve-static-core" { interface Request { auth?: Auth } }

import { pool } from "./db.ts";
import { hashOtp, sameHash, effectiveMax } from "./otpCrypto.ts";
import { sessionVerdict } from "./sessionRules.ts";
const OTP_TTL_MS = 5 * 60_000, MAX_TRIES = 5;
/** Stores a fresh OTP (replacing any previous one for this phone). Returns the plain code for sending. */
export async function issueOtp(phone: string) {
  const code = String(randomInt(100000, 999999));
  await pool.query(`INSERT INTO otp_codes(phone,code_hash,expires_at,tries) VALUES($1,$2,now()+$3::interval,0)
    ON CONFLICT(phone) DO UPDATE SET code_hash=EXCLUDED.code_hash, expires_at=EXCLUDED.expires_at, tries=0`, [phone, hashOtp(SECRET, phone, code), `${OTP_TTL_MS} milliseconds`]);
  if (process.env.OTP_MODE === "dev") console.log(`[DEV OTP] ${phone}: ${code}`);
  if (process.env.OTP_MODE === "webhook") // your SMS provider adapter (India needs DLT-registered templates); see docs/PILOT_RUNBOOK.md
    fetch(process.env.SMS_WEBHOOK_URL!, { method: "POST", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` },
      body: JSON.stringify({ phone, message: `Your GREENLOOP OTP is ${code}. Valid for 5 minutes.` }) }).catch(e => console.error("sms webhook:", e));
  return code;
}
/** Every attempt (right or wrong) is counted atomically before comparing, so parallel guesses cannot exceed MAX_TRIES. */
export async function checkOtp(phone: string, code: string) {
  const r = await pool.query("UPDATE otp_codes SET tries=tries+1 WHERE phone=$1 AND expires_at>now() AND tries<$2 RETURNING code_hash", [phone, MAX_TRIES]);
  if (!r.rowCount || !sameHash(r.rows[0].code_hash, hashOtp(SECRET, phone, code))) return false;
  const d = await pool.query("DELETE FROM otp_codes WHERE phone=$1 AND code_hash=$2", [phone, r.rows[0].code_hash]); // single use
  return d.rowCount === 1;
}
export const sign = (a: Auth) => jwt.sign(a, SECRET, { algorithm: "HS256", expiresIn: "12h" });
// The account's CURRENT role from the database (null = missing or deleted), cached 30 s per instance so the check stays cheap.
// Role changes and deletions call forgetSession so this instance reacts at once; other instances catch up within 30 s.
const live = new Map<string, { role: Auth["role"]; t: number }>();
export const forgetSession = (id: string) => { live.delete(id); };
async function liveRole(id: string): Promise<Auth["role"] | null> {
  const c = live.get(id); if (c && Date.now() - c.t < 30_000) return c.role;
  const r = await pool.query("SELECT role FROM users WHERE id=$1 AND deleted_at IS NULL", [id]); if (!r.rowCount) { live.delete(id); return null; }
  live.set(id, { role: r.rows[0].role, t: Date.now() }); return r.rows[0].role;
}
export const requireRole = (...roles: Auth["role"][]) => async (req: Request, res: Response, next: NextFunction) => {
  let a: Auth;
  try { a = jwt.verify((req.headers.authorization ?? "").replace(/^Bearer /, ""), SECRET, { algorithms: ["HS256"] }) as Auth; } catch { return res.status(401).json({ error: "unauthenticated" }); }
  const v = sessionVerdict(a.role, await liveRole(a.sub), roles); // a database error here is a 500 (fails closed), not a pass
  if (v === "forbidden") return res.status(403).json({ error: "forbidden" });
  if (v !== "ok") return res.status(401).json({ error: v === "stale" ? "role_changed" : "unauthenticated" });
  req.auth = a; next();
};
/** Fixed-window limiter shared through Postgres (works across instances and restarts). Fails closed: a DB error is a 500, not a bypass. */
export async function hit(key: string, max: number, windowMs: number) {
  const r = await pool.query(`INSERT INTO rate_limits(key,window_start,hits) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET
      hits = CASE WHEN rate_limits.window_start < now()-$2::interval THEN 1 ELSE rate_limits.hits+1 END,
      window_start = CASE WHEN rate_limits.window_start < now()-$2::interval THEN now() ELSE rate_limits.window_start END
    RETURNING hits`, [key, `${windowMs} milliseconds`]);
  return r.rows[0].hits <= effectiveMax(max, process.env);
}
export const rateLimit = (max: number, windowMs: number) => async (req: Request, res: Response, next: NextFunction) => {
  // Key on the authenticated user when known (shared NAT / mobile carriers), else on IP.
  (await hit(`${req.auth?.sub ?? req.ip}:${req.baseUrl}${req.path}`, max, windowMs)) ? next() : res.status(429).json({ error: "rate_limited" });
};
export function startCleanup() {
  setInterval(() => { pool.query("DELETE FROM otp_codes WHERE expires_at<now()-interval '1 hour'").catch(() => {});
    pool.query("DELETE FROM rate_limits WHERE window_start<now()-interval '1 day'").catch(() => {}); }, 10 * 60_000).unref();
}
