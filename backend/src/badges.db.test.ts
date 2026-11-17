import test from "node:test"; import assert from "node:assert/strict";
// Needs a THROWAWAY database with schema.sql and 002..015 applied.
const url = process.env.TEST_DATABASE_URL;
test("badges follow approved weight only; adjusting removes them; referrals touch no GREEN", { skip: !url && "set TEST_DATABASE_URL" }, async () => {
  process.env.DATABASE_URL = url; process.env.JWT_SECRET = "test-secret-test-secret-123456"; process.env.OTP_MODE = "test"; process.env.NODE_ENV = "development";
  const { pool } = await import("./db.ts"); const { awardBadges, loadStats } = await import("./badgesApi.ts"); const { evaluate } = await import("./badges.ts");
  const mk = async (role: string, n: number) => (await pool.query("INSERT INTO users(public_id,role,phone,role_id) VALUES('GL-U-'||nextval('gl_u_seq'),$1::user_role,$2,CASE $1 WHEN 'collector' THEN gl_new_role_id('GL-C-') END) RETURNING id", [role, `+91${Date.now().toString().slice(-8)}${n}0`.slice(0, 13)])).rows[0].id;
  const h = await mk("individual", 1), k = await mk("collector", 2);
  try {
    const ins = (state: string, accepted: number | null, key: string) => pool.query("INSERT INTO collections(public_id,idempotency_key,household_id,collector_id,material_id,declared_grams,accepted_grams,state) VALUES('GL-T-'||nextval('gl_t_seq'),$1,$2,$3,'PET',2000,$4,$5::reward_state) RETURNING id", [key + Date.now(), h, k, accepted, state]);
    const gl0 = (await pool.query("SELECT COUNT(*)::int n FROM ledger_entries")).rows[0].n;
    await ins("pending", 1500, "p"); assert.deepEqual(await awardBadges(pool, h, "individual", { notify: false }), [], "pending (not approved) weight earns nothing");
    await ins("approved", null, "n"); assert.deepEqual(await awardBadges(pool, h, "individual", { notify: false }), [], "no accepted weight earns nothing");
    const a = (await ins("approved", 1500, "a")).rows[0].id; const fresh = await awardBadges(pool, h, "individual");
    assert.deepEqual(fresh.map(b => b.id).sort(), ["first_collection", "verified_1kg"]); assert.deepEqual(await awardBadges(pool, h, "individual"), [], "idempotent: no duplicate awards");
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND kind='badge'", [h])).rows[0].n, 2);
    await pool.query("UPDATE collections SET state='adjusted' WHERE id=$1", [a]);
    assert.equal(evaluate(await loadStats(pool, h), "individual").filter(b => b.earned).length, 0, "an adjusted collection no longer supports a badge");
    await pool.query("INSERT INTO referrals(referrer,referred) VALUES($1,$2)", [h, k]);
    await assert.rejects(pool.query("INSERT INTO referrals(referrer,referred) VALUES($1,$1)", [h]), /referral_not_self/);
    assert.equal(evaluate(await loadStats(pool, h), "individual").filter(b => b.earned).length, 0, "a referral earns no badge");
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM ledger_entries")).rows[0].n, gl0, "badges and referrals wrote nothing to the ledger");
  } finally {
    await pool.query("DELETE FROM referrals WHERE referrer=$1 OR referred=$1", [h]); await pool.query("DELETE FROM notifications WHERE user_id=ANY($1)", [[h, k]]);
    await pool.query("DELETE FROM user_badges WHERE user_id=ANY($1)", [[h, k]]); await pool.query("DELETE FROM collections WHERE household_id=$1", [h]);
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[h, k]]); await pool.end(); }
});
