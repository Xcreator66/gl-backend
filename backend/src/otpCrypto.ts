import { createHmac, timingSafeEqual } from "node:crypto";
/** OTPs are stored as HMAC(secret, phone:code) so a database leak does not reveal live codes. */
export const hashOtp = (secret: string, phone: string, code: string) => createHmac("sha256", secret).update(`${phone}:${code}`).digest("hex");
export function sameHash(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
/** Effective limit: non-production may relax limits (RATE_LIMIT_MULTIPLIER) for smoke tests; production is always 1x. */
export const effectiveMax = (max: number, env: { NODE_ENV?: string; RATE_LIMIT_MULTIPLIER?: string }) => {
  const m = Number(env.RATE_LIMIT_MULTIPLIER); return env.NODE_ENV === "production" || !Number.isFinite(m) || m < 1 ? max : Math.floor(max * m);
};
