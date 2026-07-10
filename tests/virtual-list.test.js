const { test } = require("node:test");
const assert = require("node:assert/strict");
const { visibleRange } = require("../public/virtual-list.js");

test("visibleRange computes window with overscan", () => {
  assert.deepEqual(
    visibleRange({ scrollTop: 180, viewport: 200, rowHeight: 18, count: 1000, overscan: 2 }),
    { start: 8, end: 24 }
  );
});

test("visibleRange clamps to list bounds", () => {
  assert.deepEqual(
    visibleRange({ scrollTop: 0, viewport: 100, rowHeight: 20, count: 3, overscan: 5 }),
    { start: 0, end: 3 }
  );
  assert.deepEqual(
    visibleRange({ scrollTop: 0, viewport: 100, rowHeight: 20, count: 0, overscan: 2 }),
    { start: 0, end: 0 }
  );
});
