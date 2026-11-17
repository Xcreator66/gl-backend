import test from "node:test"; import assert from "node:assert/strict";
import { allowed, isTier, TIERS } from "./tiers.ts"; import { toCsv } from "./csv.ts";
test("super passes everything; others only their listed tiers", () => {
  for (const needed of [[], ["finance"], ["ops", "moderator"]] as const) assert.ok(allowed("super", needed));
  assert.ok(allowed("finance", ["finance"])); assert.ok(!allowed("finance", ["ops", "moderator"])); assert.ok(!allowed("moderator", ["finance", "ops"]));
  assert.ok(!allowed("ops", []), "empty list = super only");
});
test("missing or unknown tiers are denied", () => { for (const t of [null, undefined, "", "admin", "SUPER", 1]) assert.ok(!allowed(t, ["finance", "ops", "moderator"])); assert.equal(TIERS.length, 4); assert.ok(isTier("ops")); });
test("csv: quoting, newlines, null, dates", () => {
  const out = toCsv([{ a: 'He said "hi", ok', b: "line1\nline2", c: null, d: new Date("2026-01-02T03:04:05Z") }], ["a", "b", "c", "d"]);
  assert.equal(out, 'a,b,c,d\r\n"He said ""hi"", ok","line1\nline2",,2026-01-02T03:04:05.000Z\r\n');
});
test("csv: formula injection is neutralised for strings but numbers stay numeric", () => {
  const out = toCsv([{ n: "=HYPERLINK(\"x\")", m: "+1", k: "-2", z: "@sum", ok: "plain", amt: -5, big: 10n }], ["n", "m", "k", "z", "ok", "amt", "big"]).split("\r\n")[1];
  assert.equal(out, `"'=HYPERLINK(""x"")",'+1,'-2,'@sum,plain,-5,10`);
});
