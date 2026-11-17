import test from "node:test"; import assert from "node:assert/strict";
import { amountPaise, margin } from "./revenue.ts";
test("9.3 kg at INR 25/kg is INR 232.50", () => { assert.equal(amountPaise(9300, 2500), 23250); assert.equal(amountPaise(1, 2500), 2); });
test("margin subtracts the rupee value of rewards and commission", () => {
  assert.deepEqual(margin(23250, 372, 18, 10), { costPaise: 3900, marginPaise: 19350 }); // 390 GREEN = INR 39
  assert.equal(margin(1000, 500, 0, 10).marginPaise, -4000); // can be negative: rewards above revenue
});
