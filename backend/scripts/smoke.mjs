// End-to-end money-flow check against a RUNNING server on a throwaway DB.
// Server env: OTP_MODE=test NODE_ENV=development RATE_LIMIT_MULTIPLIER=100 (the smoke logs in 9+ times a minute, above the normal 5/min OTP limit)
import pg from "pg"; import assert from "node:assert/strict";
const BASE = process.env.API_URL ?? "http://localhost:3000", db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const call = async (path, { token, body } = {}) => { const r = await fetch(BASE + "/v1" + path, { method: body === undefined ? "GET" : "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) }; };
const run = Number(Date.now().toString().slice(-6)), phone = n => `+91${9000000000 + run * 10 + n}`;
async function login(n, role = "individual") {
  const go = async () => { const o = await call("/auth/otp", { body: { phone: phone(n) } }); assert.ok(o.json.code, "server must run with OTP_MODE=test");
    const v = await call("/auth/verify", { body: { phone: phone(n), code: o.json.code } }); assert.equal(v.status, 200); return v.json; };
  let u = await go(); if (role !== "individual") { await db.query("UPDATE users SET role=$1::text::user_role, admin_tier=CASE WHEN $1::text='admin' THEN 'super' ELSE NULL END, role_id=CASE $1::text WHEN 'collector' THEN gl_new_role_id('GL-C-') WHEN 'recycler' THEN gl_new_role_id('GL-R-') END WHERE phone=$2", [role, phone(n)]); u = await go(); } return u;
}
const [A, B, C, col, rec, adm] = [await login(1), await login(2), await login(3), await login(4, "collector"), await login(5, "recycler"), await login(6, "admin")];
const mk = async (h, g, i) => (await call("/collections", { token: col.token, body: { idempotencyKey: `smoke-${run}-${i}`, householdPublicId: h.publicId, materialId: "PET", grams: g } })).json.public_id;
const ids = [await mk(A, 3000, 1), await mk(B, 2500, 2), await mk(C, 4500, 3)];
assert.equal(await mk(A, 3000, 1), ids[0], "retry with same key must not duplicate");
const b = await call("/batches", { token: col.token, body: { collectionPublicIds: ids } }); assert.equal(b.status, 201); const bid = b.json.batchPublicId;
const look = await call(`/batches/${bid}`, { token: rec.token }); assert.ok(!JSON.stringify(look.json).includes("declared"), "recycler must not see declared weights");
assert.equal((await call(`/batches/${bid}/verify`, { token: rec.token, body: { weights: { PET: 9800 } } })).status, 409, "must be handed over first");
assert.match(col.roleId, /^GL-C-[0-9A-HJKMNP-TV-Z]{9}$/); assert.match(rec.roleId, /^GL-R-[0-9A-HJKMNP-TV-Z]{9}$/); assert.equal(A.roleId, null, "households have no role ID");
const badId = rec.roleId.slice(0, -1) + (rec.roleId.endsWith("0") ? "1" : "0");
assert.equal((await call(`/batches/${bid}/handover`, { token: col.token, body: { recyclerId: badId } })).status, 400, "mistyped recycler ID rejected");
assert.equal((await call(`/batches/${bid}/handover`, { token: col.token, body: { recyclerId: col.roleId } })).status, 400, "collector ID is not a recycler ID");
assert.equal((await call(`/batches/${bid}/handover`, { token: col.token, body: { recyclerId: A.publicId } })).status, 400, "household ID is not a recycler ID");
assert.equal((await call(`/batches/${bid}/handover`, { token: col.token, body: { recyclerId: rec.roleId.toLowerCase() } })).status, 200, "lower case is accepted");
assert.equal((await call(`/batches/${bid}/verify`, { token: A.token, body: { weights: { PET: 9800 } } })).status, 403);
assert.equal((await call(`/batches/${bid}/verify`, { token: rec.token, body: { weights: { PET: 9800 } } })).json.status, "verified");
const bal = async (u) => (await call("/me/balance", { token: u.token })).json;
assert.deepEqual([(await bal(A)).pending, (await bal(B)).pending, (await bal(C)).pending], [117, 98, 176]);
const earnedIds = async (u) => (await call("/me/badges", { token: u.token })).json.badges.filter(b => b.earned).map(b => b.id);
assert.deepEqual(await earnedIds(A), [], "verified but not yet approved weight earns no badge");
for (const id of ids) assert.equal((await call(`/collections/${id}/approve`, { token: adm.token, body: {} })).status, 200);
assert.deepEqual([(await bal(A)).approved, (await bal(B)).approved, (await bal(C)).approved], [117, 98, 176]);
assert.deepEqual((await earnedIds(A)).sort(), ["first_collection", "verified_1kg"], "approved weight earns badges");
assert.equal((await call("/me/badges", { token: col.token })).status, 200);
{ // referrals: identification only, never GREEN
  const before = JSON.stringify([await bal(A), await bal(B)]), badgesB = JSON.stringify(await earnedIds(B));
  const ra = (await call("/me/referral", { token: A.token })).json; assert.match(ra.code, /^[0-9A-HJKMNP-TV-Z]{8}$/); assert.equal(ra.invited, 0);
  assert.equal((await call("/me/referral/redeem", { token: A.token, body: { code: ra.code } })).status, 409, "own code refused");
  assert.equal((await call("/me/referral/redeem", { token: B.token, body: { code: "nonsense" } })).status, 400);
  assert.equal((await call("/me/referral/redeem", { token: B.token, body: { code: ra.display.toLowerCase() } })).status, 201);
  assert.equal((await call("/me/referral/redeem", { token: B.token, body: { code: ra.code } })).status, 409, "only one invite per person");
  assert.equal((await call("/me/referral", { token: A.token })).json.invited, 1);
  assert.equal(JSON.stringify([await bal(A), await bal(B)]), before, "a referral moved no GREEN");
  assert.equal(JSON.stringify(await earnedIds(B)), badgesB, "a referral changed nobody's badges");
}
const k = (await call("/admin/commissions", { token: adm.token })).json.find(x => x.batch === bid); assert.equal(k.green, 19);
assert.equal((await call(`/admin/commissions/${k.id}/approve`, { token: adm.token, body: {} })).status, 200); assert.equal((await bal(col)).approved, 19);
assert.equal((await call("/admin/ledger-summary", { token: adm.token })).json.net, 0, "ledger must net to zero");
assert.equal((await call("/redemptions", { token: A.token, body: { idempotencyKey: "smoke-redeem-1", green: 1000, upiId: "a@bank" } })).status, 503);
// v0.12 collector request queue
const pr = await call("/pickup-requests", { token: A.token, body: { materialId: "PET", mode: "pickup", estGrams: 3000, windowText: "evenings" } }); assert.equal(pr.status, 201);
assert.equal((await call("/collector/requests", { token: A.token })).status, 403, "households cannot use the collector queue");
const q = (await call("/collector/requests", { token: col.token })).json; const mineReq = q.open.find(x => x.id === pr.json.id);
assert.ok(mineReq && mineReq.household === A.publicId, "collector sees the open request"); assert.ok(!JSON.stringify(q).includes("phone"), "no phone numbers exposed");
assert.equal((await call(`/collector/requests/${pr.json.id}/claim`, { token: col.token, body: {} })).status, 200);
assert.equal((await call(`/collector/requests/${pr.json.id}/claim`, { token: col.token, body: {} })).status, 409, "cannot claim twice");
assert.equal((await call(`/collector/requests/${pr.json.id}/done`, { token: col.token, body: {} })).status, 200);
assert.equal((await call(`/collector/requests/${pr.json.id}/done`, { token: col.token, body: {} })).status, 409);
assert.equal((await call("/collector/requests/abc/claim", { token: col.token, body: {} })).status, 400);
assert.ok((await call("/me/notifications", { token: A.token })).json.items.some(n => n.kind === "pickup"), "household was notified");
// v0.13 OTP lockout: 5 wrong guesses lock the code, even for the right one
{ const ph = phone(7), o = await call("/auth/otp", { body: { phone: ph } }); const wrong = o.json.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await call("/auth/verify", { body: { phone: ph, code: wrong } })).status, 401);
  assert.equal((await call("/auth/verify", { body: { phone: ph, code: o.json.code } })).status, 401, "locked after 5 wrong tries"); }
// v0.14 admin tiers (tier is read from the DB on every call, so changes apply to the SAME token immediately)
{ const t = await login(8, "admin"); const setTier = x => db.query("UPDATE users SET admin_tier=$1 WHERE phone=$2", [x, phone(8)]);
  await setTier("moderator");
  assert.equal((await call("/admin/commissions", { token: t.token })).status, 403, "moderator cannot see money");
  assert.equal((await call("/admin/reports", { token: t.token })).status, 200);
  assert.equal((await call("/admin/export/ledger", { token: t.token })).status, 403);
  await setTier("finance");
  assert.equal((await call("/admin/commissions", { token: t.token })).status, 200, "same token, new tier");
  assert.equal((await call("/admin/reports", { token: t.token })).status, 403, "finance cannot moderate");
  assert.equal((await call("/admin/audit", { token: t.token })).status, 403, "audit is super only");
  assert.equal((await call("/admin/users/" + A.publicId + "/role", { token: t.token, body: { role: "admin" } })).status, 403);
  await db.query("UPDATE users SET role='individual', admin_tier=NULL WHERE phone=$1", [phone(8)]);
  assert.equal((await call("/admin/commissions", { token: t.token })).status, 403, "demoted admin loses access at once, not after token expiry");
  // exports: CSV, public IDs only
  const ex = await fetch(BASE + "/v1/admin/export/collections", { headers: { Authorization: "Bearer " + adm.token } }); assert.equal(ex.status, 200);
  assert.match(ex.headers.get("content-type"), /text\/csv/); const csv = await ex.text();
  assert.ok(csv.startsWith("public_id,created_at,household,collector"), "header row"); assert.ok(csv.includes(A.publicId)); assert.ok(!/\+91\d{10}/.test(csv), "no phone numbers in exports");
  const led = await (await fetch(BASE + "/v1/admin/export/ledger", { headers: { Authorization: "Bearer " + adm.token } })).text();
  assert.ok(!/user:[0-9a-f]{8}-/.test(led), "ledger export must not leak internal UUIDs"); assert.ok(led.includes("user:" + A.publicId + ":"));
  assert.equal((await fetch(BASE + "/v1/admin/export/nope", { headers: { Authorization: "Bearer " + adm.token } })).status, 404);
  assert.equal((await fetch(BASE + "/v1/admin/export/weekly", { headers: { Authorization: "Bearer " + adm.token } })).status, 200); }
// v0.15 community: names, comments, follow, mute, block
{ assert.equal((await call("/me/profile", { token: A.token, body: { displayName: "9876543210" } })).status, 400, "phone-like names rejected");
  assert.equal((await call("/me/profile", { token: A.token, body: { displayName: "Smoke Tester" } })).status, 200);
  const post = (await call("/posts", { token: B.token, body: { body: "hello from B" } })).json.id; assert.ok(post);
  assert.equal((await call(`/posts/abc/like`, { token: A.token, body: {} })).status, 404, "bad ids are 404, not 500");
  assert.equal((await call(`/posts/${post}/comments`, { token: A.token, body: { body: "nice" } })).status, 201);
  let cs = (await call(`/posts/${post}/comments`, { token: B.token })).json; assert.equal(cs.length, 1); assert.equal(cs[0].author, "Smoke Tester");
  assert.equal((await call(`/posts/${post}/comments`, { token: B.token, body: { body: "thanks", parentId: cs[0].id } })).status, 201);
  cs = (await call(`/posts/${post}/comments`, { token: A.token })).json; assert.equal(cs[0].replies.length, 1, "reply nests under its parent");
  assert.equal((await call(`/posts/${post}/comments`, { token: A.token, body: { body: "x", parentId: cs[0].replies[0].id } })).status, 400, "replies are one level deep");
  assert.equal((await call(`/users/${A.publicId}/follow`, { token: A.token, body: {} })).status, 400, "cannot follow yourself");
  assert.equal((await call(`/users/${B.publicId}/follow`, { token: A.token, body: {} })).json.following, true);
  const prof = await call(`/users/${A.publicId}`, { token: B.token }); assert.equal(prof.json.verifiedGrams, 2940); assert.ok(!JSON.stringify(prof.json).includes("+91"), "no phone on profiles");
  const inFeed = async (tok, tab = "") => (await call(`/feed${tab}`, { token: tok })).json.some(x => x.id === post);
  assert.ok(await inFeed(A.token, "?tab=following"), "followed author appears in Following");
  await call(`/users/${B.publicId}/mute`, { token: A.token, body: {} }); assert.ok(!(await inFeed(A.token)), "muted author hidden from feed");
  assert.equal((await call(`/posts/${post}/comments`, { token: A.token })).json.every(c => c.author_id !== B.publicId), true, "muted author's comments hidden");
  await call(`/users/${B.publicId}/unmute`, { token: A.token, body: {} }); assert.ok(await inFeed(A.token));
  await call(`/users/${A.publicId}/block`, { token: B.token, body: {} });
  assert.equal((await call(`/users/${B.publicId}`, { token: A.token })).status, 404, "blocked either way = invisible");
  assert.equal((await call(`/posts/${post}/comments`, { token: A.token, body: { body: "still here?" } })).status, 404, "blocked users cannot comment");
  assert.ok(!(await call("/me/connections?kind=following", { token: A.token })).json.some(x => x.public_id === B.publicId), "block ends follows");
  assert.ok((await call("/me/hidden-users", { token: B.token })).json.blocked.some(x => x.public_id === A.publicId));
  await call(`/users/${A.publicId}/unblock`, { token: B.token, body: {} }); assert.equal((await call(`/users/${B.publicId}`, { token: A.token })).status, 200);
  assert.equal((await call(`/posts/${post}/delete`, { token: A.token, body: {} })).status, 404, "cannot delete someone else's post");
  assert.equal((await call(`/posts/${post}/delete`, { token: B.token, body: {} })).status, 200); assert.ok(!(await inFeed(A.token))); }
// v0.16 groups and events
{ const g = await call("/admin/groups", { token: adm.token, body: { name: `Smoke Society ${run}`, kind: "society" } }); assert.equal(g.status, 201);
  assert.equal((await call("/admin/groups", { token: A.token, body: { name: "Nope Group", kind: "society" } })).status, 403, "households cannot create groups");
  const code = g.json.join_code, typed = code.slice(0, 4).toLowerCase() + "-" + code.slice(4);
  assert.equal((await call("/groups/join", { token: A.token, body: { code: typed } })).json.alreadyMember, false, "typed code is normalised");
  assert.equal((await call("/groups/join", { token: A.token, body: { code } })).json.alreadyMember, true);
  assert.equal((await call("/groups/join", { token: B.token, body: { code } })).status, 200);
  assert.equal((await call("/groups/join", { token: C.token, body: { code } })).status, 200);
  assert.equal((await call("/groups/join", { token: B.token, body: { code: "ZZZZZZZZ" } })).status, 404, "unknown code");
  const rank = async (tok) => (await call("/groups/leaderboard", { token: tok })).json.find(x => x.id === g.json.id);
  const r1 = await rank(A.token); assert.ok(r1, "3-member group is ranked"); assert.equal(r1.members, 3); assert.equal(r1.grams, 9800, "sum of members' verified weight");
  assert.equal((await call(`/groups/${g.json.id}`, { token: col.token })).status, 404, "non-members cannot see a group");
  const det = (await call(`/groups/${g.json.id}`, { token: A.token })).json; assert.equal(det.board.length, 3); assert.equal(det.board[0].grams, 4410, "ranked by verified weight");
  assert.ok(!JSON.stringify(det).includes("+91"), "no phone numbers in group views");
  const ev = await call("/admin/events", { token: adm.token, body: { communityId: g.json.id, title: "Smoke clean-up drive", startsAt: new Date(Date.now() + 864e5).toISOString(), locationText: "Society gate" } }); assert.equal(ev.status, 201);
  assert.equal((await call("/admin/events", { token: adm.token, body: { title: "Past event", startsAt: new Date(Date.now() - 864e5).toISOString() } })).status, 400, "events must be in the future");
  assert.equal((await call(`/events/${ev.json.id}/rsvp`, { token: A.token, body: { going: true } })).status, 200);
  assert.equal((await call(`/events/${ev.json.id}/rsvp`, { token: col.token, body: { going: true } })).status, 404, "group events are invisible to outsiders");
  const evs = (await call("/events", { token: A.token })).json.find(x => x.id === ev.json.id); assert.equal(evs.going, 1); assert.equal(evs.going_me, true);
  assert.ok(!(await call("/events", { token: col.token })).json.some(x => x.id === ev.json.id));
  assert.ok((await call("/me/notifications", { token: B.token })).json.items.some(n => n.kind === "event"), "members are notified of group events");
  await call(`/groups/${g.json.id}/leave`, { token: C.token, body: {} }); assert.equal(await rank(A.token), undefined, "group drops out of rankings below 3 members");
  const rot = await call(`/admin/groups/${g.json.id}/rotate-code`, { token: adm.token, body: {} }); assert.notEqual(rot.json.join_code, code);
  assert.equal((await call("/groups/join", { token: col.token, body: { code } })).status, 404, "old code stops working");
  assert.equal((await call(`/groups/${g.json.id}`, { token: A.token })).status, 200, "existing members stay");
  await call(`/admin/groups/${g.json.id}/active`, { token: adm.token, body: { active: false } }); assert.equal((await call(`/groups/${g.json.id}`, { token: A.token })).status, 404, "deactivated group disappears"); }
// v0.17 hardening and reports
{ const bad = await fetch(BASE + "/v1/auth/otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(bad.status, 400, "malformed JSON is a client error, not a 500"); assert.equal((await bad.json()).error, "invalid_json");
  assert.equal((await fetch(BASE + "/healthz")).status, 200);
  const acc = await call("/admin/collector-accuracy", { token: adm.token }); assert.equal(acc.status, 200); assert.ok(Array.isArray(acc.json));
  const mine = acc.json.find(x => x.collector === col.publicId); assert.ok(mine && mine.batches >= 1 && mine.verified_g > 0, "collector appears with verified batches");
  assert.equal((await call("/admin/collector-accuracy", { token: A.token })).status, 403);
  assert.equal((await fetch(BASE + "/v1/admin/export/collector_accuracy", { headers: { Authorization: "Bearer " + adm.token } })).status, 200); }
console.log("SMOKE OK"); await db.end();
