import { Router } from "express";
import { z } from "zod";
import { pool } from "./db.ts";
import { requireRole, rateLimit } from "./auth.ts";
import { newReferralCode, parseReferralCode, formatReferralCode } from "./referralCode.ts";
// Referrals only record WHO INVITED WHOM so the inviter can see a head-count. They never create GREEN, badges, rank or challenge progress.
// Deliberately no import of ledger.ts (a test enforces this).
const WINDOW_DAYS = 30; // a code can only be entered by an account that is at most this old

export const referrals = Router();
const member = requireRole("individual", "collector");
referrals.get("/me/referral", member, async (req, res) => {
  let code: string | null = (await pool.query("SELECT referral_code FROM users WHERE id=$1", [req.auth!.sub])).rows[0]?.referral_code ?? null;
  for (let i = 0; !code && i < 5; i++) {
    const c = newReferralCode();
    const r = await pool.query("UPDATE users SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL RETURNING referral_code", [c, req.auth!.sub]).catch(() => null); // unique clash: try another
    code = r?.rows[0]?.referral_code ?? (await pool.query("SELECT referral_code FROM users WHERE id=$1", [req.auth!.sub])).rows[0]?.referral_code ?? null;
  }
  if (!code) return res.status(503).json({ error: "try_again" });
  const n = (await pool.query("SELECT COUNT(*)::int n FROM referrals WHERE referrer=$1", [req.auth!.sub])).rows[0].n;
  const mine = (await pool.query("SELECT 1 FROM referrals WHERE referred=$1", [req.auth!.sub])).rowCount! > 0;
  res.json({ code, display: formatReferralCode(code), invited: n, enteredCode: mine, windowDays: WINDOW_DAYS, rewards: "none" }); // the inviter sees a count only, never who
});
referrals.post("/me/referral/redeem", member, rateLimit(5, 60_000), async (req, res) => {
  const b = z.object({ code: z.string().max(24) }).safeParse(req.body); const code = b.success ? parseReferralCode(b.data.code) : null;
  if (!code) return res.status(400).json({ error: "invalid_code" });
  const me = (await pool.query("SELECT id, created_at > now() - ($2 || ' days')::interval AS in_window FROM users WHERE id=$1", [req.auth!.sub, String(WINDOW_DAYS)])).rows[0];
  if (!me?.in_window) return res.status(409).json({ error: "window_closed" });
  const inviter = (await pool.query("SELECT id FROM users WHERE referral_code=$1", [code])).rows[0];
  if (!inviter) return res.status(404).json({ error: "code_not_found" });
  if (inviter.id === req.auth!.sub) return res.status(409).json({ error: "own_code" });
  const r = await pool.query("INSERT INTO referrals(referrer,referred) VALUES($1,$2) ON CONFLICT(referred) DO NOTHING RETURNING referred", [inviter.id, req.auth!.sub]);
  r.rowCount ? res.status(201).json({ ok: true }) : res.status(409).json({ error: "already_invited" });
});
