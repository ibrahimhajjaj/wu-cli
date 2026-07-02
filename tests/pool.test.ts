import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asyncPool } from "../src/core/pool.js";

describe("asyncPool concurrency clamp", () => {
  for (const c of [0, NaN, -3]) {
    it(`processes all items with concurrency=${c}`, async () => {
      const items = [1, 2, 3, 4, 5];
      const res = await asyncPool(items, c as number, async (x) => x * 2);
      assert.equal(res.length, items.length);
      assert.ok(res.every((r) => r && r.status === "fulfilled"));
      assert.deepEqual(res.map((r) => r.value), [2, 4, 6, 8, 10]);
    });
  }
});
