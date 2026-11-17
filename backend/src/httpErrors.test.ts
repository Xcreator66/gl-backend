import test from "node:test"; import assert from "node:assert/strict"; import { errorResponse } from "./httpErrors.ts";
test("client errors are 4xx, DB overload is 503, everything else is a generic 500", () => {
  assert.deepEqual(errorResponse({ type: "entity.parse.failed" }), { status: 400, body: { error: "invalid_json" } });
  assert.equal(errorResponse({ type: "entity.too.large" }).status, 413);
  assert.equal(errorResponse({ code: "57014" }).status, 503); assert.equal(errorResponse({ code: "53300" }).status, 503);
  const r = errorResponse(new Error("password authentication failed for user x")); assert.equal(r.status, 500); assert.ok(!JSON.stringify(r).includes("password"), "never leak error text");
  assert.equal(errorResponse(null).status, 500); assert.equal(errorResponse(undefined).status, 500);
});
import { safeCode } from "./httpErrors.ts";
test("safeCode passes business codes and refuses to echo database or program errors", () => {
  assert.equal(safeCode(new Error("not_approvable")), "not_approvable");
  assert.equal(safeCode(new Error("missing_weight_PET")), "missing_weight_PET");
  const pgErr = Object.assign(new Error("duplicate key value violates unique constraint \"batches_public_id_key\""), { code: "23505" });
  assert.throws(() => safeCode(pgErr), /duplicate key/);                       // rethrown, so it becomes a generic 500
  assert.throws(() => safeCode(Object.assign(new Error("not_a_business_code"), { code: "XX000" })));
  assert.throws(() => safeCode(new TypeError("Cannot read properties of undefined")));
  assert.throws(() => safeCode(undefined));
});
