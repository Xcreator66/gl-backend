import { randomBytes } from "node:crypto";
import { ALPHABET } from "./roleIds.ts";
// Pure helpers for referral codes (no database or server imports, so they are unit-tested with plain Node).
export const newReferralCode = () => { let s = ""; for (const x of randomBytes(8)) s += ALPHABET[x % 32]; return s; };
/** Canonical code or null. Tolerates lower case, spaces, dashes and look-alikes (O->0, I/L->1). */
export function parseReferralCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 24) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return s.length === 8 && [...s].every(c => ALPHABET.includes(c)) ? s : null;
}
export const formatReferralCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
