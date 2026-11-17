import test from "node:test"; import assert from "node:assert/strict";
import { sessionVerdict } from "./sessionRules.ts";
test("matching role in the allowed list passes; matching role outside it is forbidden", () => {
  assert.equal(sessionVerdict("collector", "collector", ["collector"]), "ok");
  assert.equal(sessionVerdict("individual", "individual", ["collector"]), "forbidden");
});
test("demoted collector or recycler (token says one thing, database another) is stale, not ok", () => {
  assert.equal(sessionVerdict("collector", "individual", ["collector"]), "stale");
  assert.equal(sessionVerdict("recycler", "individual", ["recycler"]), "stale");
  assert.equal(sessionVerdict("individual", "collector", ["collector"]), "stale"); // newly promoted must sign in again
});
test("missing or deleted account is gone", () => assert.equal(sessionVerdict("admin", null, ["admin"]), "gone"));
