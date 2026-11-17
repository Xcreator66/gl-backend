/** Display names are shown publicly, so they must not carry phone numbers or look like IDs/staff. Returns the cleaned name or null. */
export function cleanDisplayName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.normalize("NFC").replace(/\s+/g, " ").trim();
  const len = [...s].length;
  if (len < 2 || len > 30) return null;
  if (!/^[\p{L}\p{M}0-9 ._'-]+$/u.test(s)) return null;
  if ((s.match(/\d/g) ?? []).length >= 6) return null;                 // phone-number-like
  if (/\bGL-[A-Z]-\d+/i.test(s)) return null;                            // impersonating a public ID
  if (/greenloop/i.test(s) || /^(admin|support|moderator|staff)\b/i.test(s)) return null; // impersonating the platform
  return s;
}
