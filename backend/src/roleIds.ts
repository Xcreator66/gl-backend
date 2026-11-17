import { randomBytes } from "node:crypto";
/** Role-based public IDs: GL-C-xxxxxxxxk (collector) and GL-R-xxxxxxxxk (recycler). Must match db/014_role_ids.sql.
 *  8 random characters (40 bits) + 1 Luhn mod-32 check character. Random, so IDs cannot be guessed or counted; no personal data inside. */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; const N = ALPHABET.length;
export const PREFIX = { collector: "GL-C-", recycler: "GL-R-" } as const;
export type IdRole = keyof typeof PREFIX;

export function checkChar(body: string): string {
  let factor = 2, total = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const cp = ALPHABET.indexOf(body[i]); if (cp < 0) throw new Error("bad role id character");
    const addend = factor * cp; factor = factor === 2 ? 1 : 2; total += Math.floor(addend / N) + (addend % N);
  }
  return ALPHABET[(N - (total % N)) % N];
}
/** Never throws on user input: returns the canonical ID or null. Accepts lower case, spaces/dashes, and the usual look-alikes (O->0, I/L->1). */
export function parseRoleId(input: unknown, role?: IdRole): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const s = input.toUpperCase().replace(/[\s_]/g, "");
  const m = /^GL-?([CR])-?([0-9A-Z-]{9,12})$/.exec(s); if (!m) return null;
  const body9 = m[2].replace(/-/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (body9.length !== 9 || [...body9].some(ch => !ALPHABET.includes(ch))) return null;
  if (checkChar(body9.slice(0, 8)) !== body9[8]) return null;
  const r: IdRole = m[1] === "C" ? "collector" : "recycler"; if (role && role !== r) return null;
  return PREFIX[r] + body9;
}
/** Generation normally happens in SQL (gl_new_role_id); this exists for tests and for tooling that must mint IDs outside the database. */
export function newRoleId(role: IdRole): string {
  const b = randomBytes(8); let body = ""; for (const x of b) body += ALPHABET[x % 32]; // 256 % 32 = 0: no modulo bias
  return PREFIX[role] + body + checkChar(body);
}
/** Public display: grouped for reading aloud, e.g. GL-C-7K2M-9QX4-T. */
export const formatRoleId = (id: string) => /^GL-[CR]-.{9}$/.test(id) ? `${id.slice(0, 5)}${id.slice(5, 9)}-${id.slice(9, 13)}-${id.slice(13)}` : id;
