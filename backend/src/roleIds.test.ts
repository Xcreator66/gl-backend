import test from "node:test"; import assert from "node:assert/strict";
import { checkChar, parseRoleId, newRoleId, formatRoleId, ALPHABET } from "./roleIds.ts";
test("alphabet has 32 unique symbols and none of I L O U", () => { assert.equal(new Set(ALPHABET).size, 32); assert.ok(!/[ILOU]/.test(ALPHABET)); });
test("generated IDs parse back to themselves, with the right prefix", () => {
  for (let i = 0; i < 500; i++) { const c = newRoleId("collector"), r = newRoleId("recycler");
    assert.match(c, /^GL-C-[0-9A-HJKMNP-TV-Z]{9}$/); assert.match(r, /^GL-R-[0-9A-HJKMNP-TV-Z]{9}$/);
    assert.equal(parseRoleId(c), c); assert.equal(parseRoleId(r, "recycler"), r); }
});
test("a role-restricted parse rejects the other role's ID", () => { const c = newRoleId("collector"); assert.equal(parseRoleId(c, "recycler"), null); });
test("every single-character typo and every adjacent swap is caught", () => {
  const id = "GL-C-" + "7K2M9QX4"; const full = id + checkChar("7K2M9QX4"); assert.equal(parseRoleId(full), full);
  for (let i = 5; i < full.length; i++) for (const ch of ALPHABET) { if (ch === full[i]) continue; assert.equal(parseRoleId(full.slice(0, i) + ch + full.slice(i + 1)), null, `typo at ${i}`); }
  for (let i = 5; i < full.length - 1; i++) { if (full[i] === full[i + 1]) continue; const sw = full.slice(0, i) + full[i + 1] + full[i] + full.slice(i + 2); if (sw !== full) assert.equal(parseRoleId(sw), null, `swap at ${i}`); }
});
test("lower case, spaces, grouping dashes and look-alikes are tolerated", () => {
  const id = newRoleId("recycler"); assert.equal(parseRoleId(id.toLowerCase()), id); assert.equal(parseRoleId(formatRoleId(id)), id); assert.equal(parseRoleId(` ${id} `), id);
  assert.equal(parseRoleId("GL-C-OOOOOOOO" + checkChar("00000000")), "GL-C-00000000" + checkChar("00000000"));
});
test("garbage, SQL, households and wrong lengths are rejected without throwing", () => {
  for (const bad of [null, undefined, 5, {}, "", "GL-U-100001", "GL-C-", "GL-C-12345", "GL-X-12345678A", "'; DROP TABLE users;--", "GL-C-" + "9".repeat(40), "GL-C-UUUUUUUUU"]) assert.equal(parseRoleId(bad as any), null);
});
test("known vector (locks the algorithm so SQL and TypeScript cannot drift apart)", () => {
  assert.equal(checkChar("00000000"), "0"); assert.equal(checkChar("00000001"), "Y");
});
test("IDs are random enough: 2000 mint with no repeats", () => { assert.equal(new Set(Array.from({ length: 2000 }, () => newRoleId("collector"))).size, 2000); });
