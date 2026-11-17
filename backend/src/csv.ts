/** CSV for admin exports. Strings starting with = + - @ tab or CR get a leading apostrophe so spreadsheets cannot run them as formulas
 *  (user-controlled text such as display names flows into exports). Real numbers are left alone, so -5 stays numeric. */
const cell = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") return String(v);
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Record<string, unknown>[], cols: string[]) =>
  [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\r\n") + "\r\n";
