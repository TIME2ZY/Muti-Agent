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

test("resolveCapabilities defaults optimistically when missing", () => {
  const caps = helpers.resolveCapabilities(null);
  assert.equal(caps.thinking, true);
  assert.equal(caps.tools, true);
  assert.equal(caps.subagents, true);
});

test("resolveCapabilities respects explicit false flags", () => {
  const caps = helpers.resolveCapabilities({
    capabilities: { thinking: false, tools: false, subagents: true, resume: true },
  });
  assert.equal(helpers.shouldRenderThinking(caps), false);
  assert.equal(helpers.shouldRenderTools(caps), false);
  assert.equal(helpers.shouldRenderSubagents(caps), true);
});

test("findAgentCapabilities looks up agent list by id", () => {
  const agents = [
    { id: "architect", capabilities: { thinking: false, tools: true, subagents: true } },
    { id: "grok", capabilities: { thinking: true, tools: false, subagents: false } },
  ];
  assert.equal(helpers.findAgentCapabilities(agents, "architect").thinking, false);
  assert.equal(helpers.findAgentCapabilities(agents, "grok").tools, false);
  assert.equal(helpers.findAgentCapabilities(agents, "missing").thinking, true);
});

test("capabilityTagList is capability-driven not provider-name hardcoding", () => {
  assert.deepEqual(
    helpers.capabilityTagList({
      capabilities: { thinking: true, tools: false, subagents: false },
    }),
    ["思考"]
  );
  assert.deepEqual(
    helpers.capabilityTagList({
      capabilities: { thinking: true, tools: true, subagents: true },
    }),
    ["思考", "工具", "子代理"]
  );
});
