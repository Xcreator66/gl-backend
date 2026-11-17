import test from "node:test"; import assert from "node:assert/strict";
import { loadConfig, numEnv, productionProblems } from "./config.ts";
test("defaults when unset or blank", () => {
  assert.deepEqual(loadConfig({}), { commissionBps: 500, tolerancePct: 2, greenPerInr: 10, minRedeemGreen: 1000 });
  assert.equal(loadConfig({ COMMISSION_BPS: " " }).commissionBps, 500);
});
test("valid values are read; tolerance may be fractional", () => {
  const c = loadConfig({ COMMISSION_BPS: "750", TOLERANCE_PCT: "2.5", GREEN_PER_INR: "20", MIN_REDEEM_GREEN: "0" });
  assert.deepEqual(c, { commissionBps: 750, tolerancePct: 2.5, greenPerInr: 20, minRedeemGreen: 0 });
});
test("mistyped or out-of-range money settings fail loudly instead of becoming NaN", () => {
  for (const [k, v] of [["COMMISSION_BPS", "5%"], ["COMMISSION_BPS", "abc"], ["COMMISSION_BPS", "-1"], ["COMMISSION_BPS", "10001"],
    ["TOLERANCE_PCT", "2,5"], ["TOLERANCE_PCT", "101"], ["GREEN_PER_INR", "0"], ["GREEN_PER_INR", "1.5"], ["MIN_REDEEM_GREEN", "1e3"]])
    assert.throws(() => loadConfig({ [k]: v }), new RegExp(k), `${k}=${v}`);
  assert.throws(() => numEnv({ X: "Infinity" }, "X", 1, 0, 9), /X/);
});
test("production refuses weak or incomplete settings; non-production is not checked", () => {
  assert.deepEqual(productionProblems({ NODE_ENV: "development" }), []);
  const good = { NODE_ENV: "production", JWT_SECRET: "x".repeat(32), DATABASE_URL: "postgres://h/d", OTP_MODE: "webhook", SMS_WEBHOOK_URL: "https://sms.example/send", SMS_WEBHOOK_TOKEN: "t" };
  assert.deepEqual(productionProblems(good), []);
  assert.equal(productionProblems({ ...good, JWT_SECRET: "short" }).length, 1);
  assert.equal(productionProblems({ ...good, SMS_WEBHOOK_URL: "http://sms.example" }).length, 1);
  assert.equal(productionProblems({ ...good, SMS_WEBHOOK_TOKEN: "" }).length, 1);
  assert.equal(productionProblems({ ...good, DATABASE_URL: "" }).length, 1);
});
