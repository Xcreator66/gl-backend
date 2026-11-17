import test from "node:test"; import assert from "node:assert/strict";
import { thread } from "./thread.ts"; import { cleanDisplayName } from "./names.ts";
const c = (id: string, parent: string | null) => ({ id, parent_id: parent, body: "x" + id });
test("thread: replies nest under their parent in id order; ids compare numerically", () => {
  const t = thread([c("10", null), c("9", null), c("12", "9"), c("11", "10"), c("100", "9")]);
  assert.deepEqual(t.map(x => x.id), ["9", "10"]); assert.deepEqual(t[0].replies.map(x => x.id), ["12", "100"]); assert.deepEqual(t[1].replies.map(x => x.id), ["11"]);
});
test("thread: orphaned replies are dropped, never promoted", () => {
  const t = thread([c("1", null), c("5", "2")]); assert.equal(t.length, 1); assert.equal(t[0].replies.length, 0);
});
test("thread: a reply to a reply is ignored (two levels only)", () => {
  const t = thread([c("1", null), c("2", "1"), c("3", "2")]); assert.deepEqual(t[0].replies.map(x => x.id), ["2"]);
});
test("names: good names pass and are cleaned", () => {
  assert.equal(cleanDisplayName("  Priya   Sharma "), "Priya Sharma"); assert.equal(cleanDisplayName("ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ"), "ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ");
  assert.equal(cleanDisplayName("Sam 2024"), "Sam 2024"); assert.equal(cleanDisplayName("Green_Team-7"), "Green_Team-7");
});
test("names: phone numbers, IDs, platform impersonation, markup and bad lengths are rejected", () => {
  for (const bad of ["9876543210", "call 98765 43210", "GL-U-100001", "gl-c-123", "GreenLoop Support", "Admin Raj", "Support team", "<b>x</b>", "a", "x".repeat(31), "", "   ", "rm -rf; ls", null, 5])
    assert.equal(cleanDisplayName(bad as any), null, String(bad));
});
