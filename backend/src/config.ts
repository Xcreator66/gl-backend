/** Startup configuration checks. A mistyped money setting (COMMISSION_BPS="5%") used to become NaN and silently stop commissions or
 *  break weight tolerance; now the server refuses to start with a clear message instead. Pure functions: no I/O, easy to test. */
export type Env = Record<string, string | undefined>;

export function numEnv(env: Env, name: string, def: number, min: number, max: number, integer = true): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return def;
  const ok = integer ? /^\d+$/.test(raw) : /^\d+(\.\d+)?$/.test(raw);
  const n = Number(raw);
  if (!ok || !Number.isFinite(n)) throw new Error(`${name} must be a ${integer ? "whole" : "plain"} number (got "${raw}")`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

export function loadConfig(env: Env) {
  return {
    commissionBps: numEnv(env, "COMMISSION_BPS", 500, 0, 10_000),
    tolerancePct: numEnv(env, "TOLERANCE_PCT", 2, 0, 100, false),
    greenPerInr: numEnv(env, "GREEN_PER_INR", 10, 1, 100_000),
    minRedeemGreen: numEnv(env, "MIN_REDEEM_GREEN", 1000, 0, 1_000_000_000),
  };
}

/** Things that must be true before a production server is allowed to start. Empty array = fine. */
export function productionProblems(env: Env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const p: string[] = [];
  if ((env.JWT_SECRET ?? "").length < 32) p.push("JWT_SECRET must be at least 32 characters in production");
  if (env.OTP_MODE === "webhook") {
    if (!/^https:\/\//.test(env.SMS_WEBHOOK_URL ?? "")) p.push("SMS_WEBHOOK_URL must be an https:// URL when OTP_MODE=webhook");
    if (!env.SMS_WEBHOOK_TOKEN) p.push("SMS_WEBHOOK_TOKEN is required when OTP_MODE=webhook");
  }
  if (!env.DATABASE_URL) p.push("DATABASE_URL is required");
  return p;
}
