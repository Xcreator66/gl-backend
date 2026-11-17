/** schema.sql first, then NNN_name.sql in numeric order. Numbers must run 002, 003, ... with no gaps or duplicates, and nothing unexpected may sit in db/,
 *  so a forgotten or misnamed file fails loudly instead of being silently skipped. */
export function orderMigrations(files) {
  const sql = files.filter(f => f.endsWith(".sql"));
  if (!sql.includes("schema.sql")) throw new Error("schema.sql is missing");
  const numbered = [];
  for (const f of sql) {
    if (f === "schema.sql") continue;
    const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f);
    if (!m) throw new Error(`unexpected file in db/: ${f} (expected NNN_name.sql)`);
    numbered.push({ n: Number(m[1]), f });
  }
  numbered.sort((a, b) => a.n - b.n);
  numbered.forEach((x, i) => {
    if (i > 0 && x.n === numbered[i - 1].n) throw new Error(`duplicate migration number ${String(x.n).padStart(3, "0")}`);
    if (x.n !== i + 2) throw new Error(`migration numbering gap: expected ${String(i + 2).padStart(3, "0")}, found ${String(x.n).padStart(3, "0")}`);
  });
  return ["schema.sql", ...numbered.map(x => x.f)];
}
