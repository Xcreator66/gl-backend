/** Join codes avoid look-alike characters (0/O, 1/I/L). 31 symbols x 8 positions is far too large to guess; joins are also rate limited. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const MAX_GROUPS_PER_USER = 10;
/** A group only appears in cross-group rankings with at least this many members, so a ranking row can never describe one person. */
export const MIN_RANKED_MEMBERS = 3;
export const makeJoinCode = (randInt: (maxExclusive: number) => number) =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randInt(CODE_ALPHABET.length)]).join("");
/** Accepts what people type ("ab-cd 2345", lowercase) and returns the canonical code, or null if it cannot be valid. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  return s.length === CODE_LENGTH && [...s].every(ch => CODE_ALPHABET.includes(ch)) ? s : null;
}
export interface GroupRow { id: string; name: string; kind: string; members: number; grams: number; [k: string]: unknown }
export const rankGroups = <T extends GroupRow>(rows: T[]) =>
  rows.filter(r => r.members >= MIN_RANKED_MEMBERS).sort((a, b) => b.grams - a.grams || a.name.localeCompare(b.name));
