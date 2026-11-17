import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path";
import { orderMigrations } from "../scripts/migrationOrder.mjs";
test("real db/ folder orders cleanly: schema first, then 002.. with no gaps", () => {
  const files = orderMigrations(fs.readdirSync(path.join(import.meta.dirname, "..", "db")));
  assert.equal(files[0], "schema.sql"); assert.ok(files.length >= 12); files.slice(1).forEach((f, i) => assert.equal(Number(f.slice(0, 3)), i + 2));
});
test("shuffled input is sorted; gaps, duplicates, strays and a missing schema are rejected", () => {
  assert.deepEqual(orderMigrations(["003_b.sql", "schema.sql", "002_a.sql", "README.md"]), ["schema.sql", "002_a.sql", "003_b.sql"]);
  assert.throws(() => orderMigrations(["schema.sql", "002_a.sql", "004_c.sql"]), /gap/);
  assert.throws(() => orderMigrations(["schema.sql", "002_a.sql", "002_b.sql"]), /duplicate/);
  assert.throws(() => orderMigrations(["schema.sql", "extra.sql"]), /unexpected/);
  assert.throws(() => orderMigrations(["002_a.sql"]), /schema\.sql/);
});
