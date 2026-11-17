import test from "node:test"; import assert from "node:assert/strict";
import { runInTx } from "./txRunner.ts";
const fake = (failOn?: string) => { const log: string[] = []; let released = 0;
  const c = { query: async (s: string) => { log.push(s); if (s === failOn) throw new Error(`${s} failed`); }, release: () => { released++; } };
  return { c, log, released: () => released }; };
test("commits and releases the connection on success", async () => {
  const f = fake(); const r = await runInTx(async () => f.c, async () => 42);
  assert.equal(r, 42); assert.deepEqual(f.log, ["BEGIN", "COMMIT"]); assert.equal(f.released(), 1);
});
test("rolls back, rethrows the ORIGINAL error and still releases", async () => {
  const f = fake(); await assert.rejects(runInTx(async () => f.c, async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(f.log, ["BEGIN", "ROLLBACK"]); assert.equal(f.released(), 1);
});
test("a failing ROLLBACK does not hide the original error, and the connection is still released", async () => {
  const f = fake("ROLLBACK"); await assert.rejects(runInTx(async () => f.c, async () => { throw new Error("original"); }), /original/);
  assert.equal(f.released(), 1);
});
test("a failing COMMIT rolls back and releases", async () => {
  const f = fake("COMMIT"); await assert.rejects(runInTx(async () => f.c, async () => 1), /COMMIT failed/);
  assert.deepEqual(f.log, ["BEGIN", "COMMIT", "ROLLBACK"]); assert.equal(f.released(), 1);
});
test("100 sequential transactions leave nothing held (the v0.26 leak would exhaust a pool of 10)", async () => {
  let open = 0, peak = 0; const connect = async () => { open++; peak = Math.max(peak, open); return { query: async () => {}, release: () => { open--; } }; };
  for (let i = 0; i < 100; i++) await runInTx(connect, async () => i);
  assert.equal(open, 0); assert.equal(peak, 1);
});
