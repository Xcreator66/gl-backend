import test from "node:test"; import assert from "node:assert/strict"; import { randomInt } from "node:crypto";
import { makeJoinCode, normalizeCode, rankGroups, CODE_ALPHABET, CODE_LENGTH } from "./groupRules.ts";
test("codes: right length, only unambiguous characters", () => {
  for (let i = 0; i < 500; i++) { const c = makeJoinCode(randomInt); assert.equal(c.length, CODE_LENGTH); assert.ok([...c].every(ch => CODE_ALPHABET.includes(ch))); }
  assert.ok(!/[01OIL]/.test(CODE_ALPHABET));
});
test("codes: typed input is normalised; junk is rejected", () => {
  assert.equal(normalizeCode("abcd-2345"), "ABCD2345"); assert.equal(normalizeCode(" abcd 2345 "), "ABCD2345");
  for (const bad of ["ABCD234", "ABCD23456", "ABCD234O", "ABCD2341", "", "'; DROP", null, 12345678, "ABCD 23 45 6"]) assert.equal(normalizeCode(bad as any), null, String(bad));
});
test("ranking: small groups never appear; order is by weight then name", () => {
  const g = (id: string, name: string, members: number, grams: number) => ({ id, name, kind: "society", members, grams });
  const r = rankGroups([g("1", "Solo", 1, 99999), g("2", "Pair", 2, 5000), g("3", "Beta", 3, 1000), g("4", "Alpha", 3, 1000), g("5", "Big", 40, 20000)]);
  assert.deepEqual(r.map(x => x.name), ["Big", "Alpha", "Beta"]);
});
