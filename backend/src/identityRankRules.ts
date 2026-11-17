/** PURE. Rankings, periods and Green Identity configuration validation. No database, no money code; nothing here can move GREEN. */

// ---------- periods (Asia/Kolkata has no daylight saving, so a fixed +05:30 offset is exact)
export const IST_OFFSET_MIN = 330; const MIN = 60_000, DAY = 86_400_000;
export type PeriodKind = "weekly" | "monthly";
export interface Period { kind: PeriodKind; start: Date; end: Date; label: string }
const toWall = (d: Date) => new Date(d.getTime() + IST_OFFSET_MIN * MIN);      // UTC fields of the result read as IST wall-clock
const fromWall = (ms: number) => new Date(ms - IST_OFFSET_MIN * MIN);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export function periodContaining(kind: PeriodKind, at: Date): Period {
  const w = toWall(at), y = w.getUTCFullYear(), m = w.getUTCMonth();
  if (kind === "monthly") { const s = Date.UTC(y, m, 1), e = Date.UTC(y, m + 1, 1); return { kind, start: fromWall(s), end: fromWall(e), label: ymd(s).slice(0, 7) }; }
  const dayStart = Date.UTC(y, m, w.getUTCDate()), s = dayStart - ((w.getUTCDay() + 6) % 7) * DAY;   // Monday start
  return { kind, start: fromWall(s), end: fromWall(s + 7 * DAY), label: ymd(s) };
}
/** The most recent period that has fully ended. */
export const lastCompletedPeriod = (kind: PeriodKind, now: Date): Period => periodContaining(kind, new Date(periodContaining(kind, now).start.getTime() - 1));
/** A period named by its start date (IST). Null if the date is invalid, not a period boundary (weekly: Monday, monthly: the 1st) or the period has not ended yet. */
export function periodFromStartDate(kind: PeriodKind, date: string, now: Date): Period | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null; const wall = Date.parse(`${date}T00:00:00Z`); if (Number.isNaN(wall) || ymd(wall) !== date) return null;
  const at = fromWall(wall), p = periodContaining(kind, at); if (p.start.getTime() !== at.getTime()) return null; return p.end.getTime() <= now.getTime() ? p : null;
}

// ---------- location
/** ISO 3166-2:IN suffixes: 28 states and 8 union territories. */
export const STATES: Record<string, string> = { AN: "Andaman and Nicobar Islands", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar", CH: "Chandigarh", CG: "Chhattisgarh",
  DH: "Dadra and Nagar Haveli and Daman and Diu", DL: "Delhi", GA: "Goa", GJ: "Gujarat", HR: "Haryana", HP: "Himachal Pradesh", JK: "Jammu and Kashmir", JH: "Jharkhand", KA: "Karnataka",
  KL: "Kerala", LA: "Ladakh", LD: "Lakshadweep", MP: "Madhya Pradesh", MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya", MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", PY: "Puducherry",
  PB: "Punjab", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TS: "Telangana", TR: "Tripura", UP: "Uttar Pradesh", UK: "Uttarakhand", WB: "West Bengal" };
export const isStateCode = (c: string) => Object.prototype.hasOwnProperty.call(STATES, c);
/** Geographic boards are shown only when at least this many people have XP in the scope. Stops a board from naming a handful of identifiable neighbours and stops one person "winning" an empty town. */
export const MIN_GEO_PARTICIPANTS = 5;
/** City is free text. The key folds case, accents-as-typed, punctuation and spacing so "Jandiala", "jandiala " and "JANDIALA" meet; it is always paired with the state. */
export function normalizeCity(raw: string): { city: string; key: string } | null {
  const city = raw.normalize("NFKC").trim().replace(/\s+/g, " "); if (city.length < 2 || city.length > 60) return null;
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’\-]*$/u.test(city)) return null;
  const key = city.toLowerCase().replace(/[.'’]/g, "").replace(/[\s\-]+/g, " ").trim(); return key.length >= 2 ? { city, key } : null;
}
export type ScopeKind = "india" | "state" | "city";
export interface Location { state: string | null; cityKey: string | null }
/** The scope value for a viewer. Null means the viewer has not set the location that scope needs. */
export function scopeValue(kind: ScopeKind, loc: Location): string | null {
  if (kind === "india") return ""; if (kind === "state") return loc.state; return loc.state && loc.cityKey ? `${loc.state}:${loc.cityKey}` : null;
}

// ---------- configuration validation (admin-editable levels, ranks, titles)
export const MAX_LEVELS = 100;
export function validateLevels(levels: { level: number; xpRequired: number }[]): string | null {
  if (levels.length < 2 || levels.length > MAX_LEVELS) return `between 2 and ${MAX_LEVELS} levels are required`;
  const s = [...levels].sort((a, b) => a.level - b.level);
  for (let i = 0; i < s.length; i++) {
    if (s[i].level !== i + 1) return "levels must be numbered 1..n with no gaps or duplicates";
    if (!Number.isInteger(s[i].xpRequired) || s[i].xpRequired < 0 || s[i].xpRequired > 100_000_000) return "xpRequired must be a whole number from 0 to 100,000,000";
    if (i === 0 && s[i].xpRequired !== 0) return "level 1 must require 0 XP";
    if (i > 0 && s[i].xpRequired <= s[i - 1].xpRequired) return "each level must need more XP than the one before";
  } return null;
}
export function validateRanks(next: { code: string; name: string; minScore: number }[], existing: { code: string; position: number }[]): string | null {
  const have = new Set(existing.map(r => r.code)); if (next.length !== existing.length || next.some(r => !have.has(r.code)) || new Set(next.map(r => r.code)).size !== next.length) return "the set of ranks cannot change; edit names and thresholds only";
  const byCode = new Map(next.map(r => [r.code, r])); const ordered = [...existing].sort((a, b) => a.position - b.position).map(r => byCode.get(r.code)!);
  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]; if (r.name.trim().length < 2 || r.name.trim().length > 30) return "rank names must be 2-30 characters";
    if (!Number.isInteger(r.minScore) || r.minScore < 0 || r.minScore > 100) return "rank thresholds must be whole numbers from 0 to 100";
    if (i === 0 && r.minScore !== 0) return "the first rank must start at 0"; if (i > 0 && r.minScore <= ordered[i - 1].minScore) return "each rank must need a higher score than the one before";
  } return null;
}
export const TITLE_ROLES = ["individual", "collector", "recycler"] as const; const XP_ROLES = ["individual", "collector"];
export interface TitleDraft { awardMode: "automatic" | "admin_verified"; eligibleRoles: string[]; criteria: { materials?: string[]; min_grams?: number } }
/** Automatic titles must be earned from recycler-verified weight on a XP-earning account type; admin-verified titles carry no automatic criteria. */
export function validateTitle(t: TitleDraft): string | null {
  if (!t.eligibleRoles.length || new Set(t.eligibleRoles).size !== t.eligibleRoles.length || t.eligibleRoles.some(r => !(TITLE_ROLES as readonly string[]).includes(r))) return "choose one or more valid account types";
  if (t.awardMode === "admin_verified") return Object.keys(t.criteria).length ? "admin-verified titles cannot have automatic criteria" : null;
  if (t.eligibleRoles.some(r => !XP_ROLES.includes(r))) return "automatic titles are only for citizens and collectors, who earn verified weight";
  const g = t.criteria.min_grams; if (!Number.isInteger(g) || (g as number) < 1000 || (g as number) > 100_000_000) return "automatic titles need min_grams between 1,000 and 100,000,000";
  const m = t.criteria.materials; if (m !== undefined && (!Array.isArray(m) || m.length < 1 || m.length > 10 || new Set(m).size !== m.length || m.some(x => !/^[A-Za-z0-9_]{2,12}$/.test(x)))) return "materials must be 1-10 distinct material codes";
  return Object.keys(t.criteria).some(k => k !== "min_grams" && k !== "materials") ? "unknown criteria" : null;
}
