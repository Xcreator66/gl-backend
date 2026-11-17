import test from "node:test"; import assert from "node:assert/strict";
// Needs a THROWAWAY database with schema.sql and 009 applied. Uses the real auth.ts SQL.
const url = process.env.TEST_DATABASE_URL;
test("OTP: single use, 5-try lockout, expiry-safe; rate limit window", { skip: !url && "set TEST_DATABASE_URL" }, async () => {
  process.env.DATABASE_URL = url; process.env.JWT_SECRET = "test-secret-test-secret-123456"; process.env.OTP_MODE = "test"; process.env.NODE_ENV = "development"; delete process.env.RATE_LIMIT_MULTIPLIER;
  const { issueOtp, checkOtp, hit } = await import("./auth.ts"); const { pool } = await import("./db.ts");
  try {
    const ph = `+91${Date.now().toString().slice(-10)}`;
    let code = await issueOtp(ph);
    assert.equal(await checkOtp(ph, "000000" === code ? "111111" : "000000"), false);
    assert.equal(await checkOtp(ph, code), true); assert.equal(await checkOtp(ph, code), false, "single use");
    code = await issueOtp(ph); const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) assert.equal(await checkOtp(ph, wrong), false);
    assert.equal(await checkOtp(ph, code), false, "locked after 5 tries even with the right code");
    code = await issueOtp(ph); assert.equal(await checkOtp(ph, code), true, "a new OTP resets the counter");
    const k = `test:${Date.now()}`; const r: boolean[] = []; for (let i = 0; i < 4; i++) r.push(await hit(k, 3, 60_000));
    assert.deepEqual(r, [true, true, true, false]);
    await pool.query("UPDATE rate_limits SET window_start=now()-interval '2 minutes' WHERE key=$1", [k]);
    assert.equal(await hit(k, 3, 60_000), true, "window resets");
  } finally { const { pool } = await import("./db.ts"); await pool.end(); }
});
