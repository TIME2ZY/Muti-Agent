const { test } = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("../public/message-process-helpers.js");

test("truncateDisplay and collapseWs", () => {
  assert.equal(helpers.collapseWs(" a  b\n"), "a b");
  assert.equal(helpers.truncateDisplay("x".repeat(10), 5).length, 5);
});

test("cleanProcessOutput strips task XML", () => {
  const out = helpers.cleanProcessOutput("<task_result>ok done</task_result>");
  assert.match(out, /ok done/);
});

test("isTaskLikeTool detects subagent task tools", () => {
  assert.equal(helpers.isTaskLikeTool({ toolName: "task" }), true);
  assert.equal(helpers.isTaskLikeTool({ toolName: "read", args: {} }), false);
  assert.equal(helpers.isTaskLikeTool({ toolName: "x", args: { subagent_type: "explore" } }), true);
});

test("progress helpers", () => {
  assert.equal(helpers.progressItemDone({ status: "done" }), true);
  assert.equal(helpers.progressItemLabel({ text: "step" }), "step");
});
