import test from "node:test"; import assert from "node:assert/strict";
import { hashOtp, sameHash, effectiveMax } from "./otpCrypto.ts";
test("hash is stable, secret- and phone-bound, and never contains the code", () => {
  const h = hashOtp("s1", "+919000000001", "123456");
  assert.equal(h, hashOtp("s1", "+919000000001", "123456")); assert.notEqual(h, hashOtp("s2", "+919000000001", "123456"));
  assert.notEqual(h, hashOtp("s1", "+919000000002", "123456")); assert.ok(!h.includes("123456"));
});
test("sameHash compares safely, including different lengths", () => { assert.ok(sameHash("abc", "abc")); assert.ok(!sameHash("abc", "abd")); assert.ok(!sameHash("abc", "abcd")); });
test("rate-limit multiplier is ignored in production and for bad values", () => {
  assert.equal(effectiveMax(5, { NODE_ENV: "production", RATE_LIMIT_MULTIPLIER: "100" }), 5);
  assert.equal(effectiveMax(5, { NODE_ENV: "development", RATE_LIMIT_MULTIPLIER: "100" }), 500);
  for (const bad of [undefined, "", "abc", "0", "-3", "0.5"]) assert.equal(effectiveMax(5, { NODE_ENV: "development", RATE_LIMIT_MULTIPLIER: bad }), 5);
});
