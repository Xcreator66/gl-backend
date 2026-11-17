import type { Request, Response, NextFunction } from "express";
import { pool } from "./db.ts";
import { requireRole } from "./auth.ts";
import { allowed, type Tier } from "./tiers.ts";
import type { Permission } from "./payoutRules.ts";
declare module "express-serve-static-core" { interface Request { adminTier?: Tier } }

/** Admin route guard. The token proves who you are; role and tier are read from the DATABASE on every call,
 *  so demoting an admin or changing their tier takes effect immediately (not after the 12h token expiry).
 *  `adminOnly()` with no tiers = super only. Super always passes. */
export const adminOnly = (...tiers: Tier[]) => [
  requireRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    const r = await pool.query("SELECT admin_tier FROM users WHERE id=$1 AND role='admin'", [req.auth!.sub]);
    const t = r.rows[0]?.admin_tier;
    if (!allowed(t, tiers)) return res.status(403).json({ error: "forbidden" });
    req.adminTier = t; next();
  },
];

/** Explicit finance permission (payout.prepare / payout.approve / payout.execute / finance.audit). The finance tier is required AND the permission must be granted;
 *  super does not imply these, so a super admin cannot approve a payout they prepared or approve without being granted the permission. */
export const adminPermission = (perm: Permission) => [
  requireRole("admin"),
  async (req: Request, res: Response, next: NextFunction) => {
    const r = await pool.query(`SELECT u.admin_tier, EXISTS(SELECT 1 FROM admin_permissions p WHERE p.user_id=u.id AND p.permission=$2) has FROM users u WHERE u.id=$1 AND u.role='admin'`, [req.auth!.sub, perm]);
    const row = r.rows[0]; if (!row || !row.has || !allowed(row.admin_tier, ["finance"])) return res.status(403).json({ error: "forbidden" });
    req.adminTier = row.admin_tier; next();
  },
];
