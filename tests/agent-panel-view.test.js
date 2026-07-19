const assert = require("node:assert/strict");
const test = require("node:test");

const { budgetRailSegments } = require("../public/agent-panel-view.js");

test("context rail keeps a fixed 20 percent reserve segment", () => {
  assert.deepEqual(budgetRailSegments(0), { usedPercent: 0, remainingPercent: 80 });
  assert.deepEqual(budgetRailSegments(0.5), { usedPercent: 40, remainingPercent: 40 });
  assert.deepEqual(budgetRailSegments(1), { usedPercent: 80, remainingPercent: 0 });
  assert.deepEqual(budgetRailSegments(1.25), { usedPercent: 80, remainingPercent: 0 });
});
