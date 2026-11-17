import test from "node:test"; import assert from "node:assert/strict";
// Needs a THROWAWAY database with schema.sql and 002..014 applied.
const url = process.env.TEST_DATABASE_URL;
test("role IDs: SQL generator and TypeScript validator agree; constraint ties ID to role; backfill left none missing", { skip: !url && "set TEST_DATABASE_URL" }, async () => {
  process.env.DATABASE_URL = url; const { pool } = await import("./db.ts"); const { parseRoleId, checkChar, newRoleId } = await import("./roleIds.ts");
  try {
    for (const p of ["GL-C-", "GL-R-"]) for (let i = 0; i < 200; i++) { const id = (await pool.query("SELECT gl_new_role_id($1) id", [p])).rows[0].id; assert.equal(parseRoleId(id), id, `TS rejected SQL-made ${id}`); }
    for (let i = 0; i < 200; i++) { const id = newRoleId("collector"); assert.equal((await pool.query("SELECT gl_role_check($1) c", [id.slice(5, 13)])).rows[0].c, checkChar(id.slice(5, 13))); }
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM users WHERE role IN ('collector','recycler') AND role_id IS NULL")).rows[0].n, 0);
    const ph = `+91${Date.now().toString().slice(-10)}`; const u = (await pool.query("INSERT INTO users(public_id,role,phone) VALUES('GL-U-'||nextval('gl_u_seq'),'individual',$1) RETURNING id", [ph])).rows[0];
    await assert.rejects(pool.query("UPDATE users SET role='collector' WHERE id=$1", [u.id]), /role_id_matches_role/, "collector without ID refused");
    await assert.rejects(pool.query("UPDATE users SET role='collector', role_id=gl_new_role_id('GL-R-') WHERE id=$1", [u.id]), /role_id_matches_role/, "wrong prefix refused");
    await pool.query("UPDATE users SET role='collector', role_id=gl_new_role_id('GL-C-') WHERE id=$1", [u.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [u.id]);
  } finally { await pool.end(); }
});
