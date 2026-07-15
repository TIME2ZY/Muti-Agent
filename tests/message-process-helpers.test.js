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
    { id: "codex", capabilities: { thinking: false, tools: true, subagents: true } },
    { id: "grok", capabilities: { thinking: true, tools: false, subagents: false } },
  ];
  assert.equal(helpers.findAgentCapabilities(agents, "codex").thinking, false);
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

test("aggregateProcessBuckets merges durable tool started/finished by toolId", () => {
  const buckets = helpers.aggregateProcessBuckets([
    {
      kind: "tool.started",
      payload: { toolId: "t1", toolName: "read", args: { path: "a.js" } },
    },
    {
      kind: "tool.finished",
      payload: { toolId: "t1", toolName: "read", result: "ok", status: "done" },
    },
    {
      kind: "text.delta",
      payload: { text: "hello " },
    },
    {
      kind: "subagent.started",
      payload: { subagentId: "s1", name: "explore", task: "find files" },
    },
    {
      kind: "subagent.completed",
      payload: { subagentId: "s1", name: "explore", summary: "done" },
    },
    {
      kind: "command.started",
      payload: { command: "npm test" },
    },
    {
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    },
  ]);

  assert.equal(buckets.toolById.size, 1);
  const tool = buckets.toolById.get("t1");
  assert.equal(tool.toolName, "read");
  assert.equal(tool.result, "ok");
  assert.equal(tool.type, "tool.finished");

  assert.equal(buckets.subById.size, 1);
  const sub = buckets.subById.get("s1");
  assert.equal(sub.type, "subagent.completed");
  assert.equal(sub.name, "explore");

  assert.equal(buckets.commandByKey.size, 1);
  assert.equal(buckets.commandByKey.get("npm test").exitCode, 0);
  assert.equal(helpers.isProcessBucketsEmpty(buckets), false);
});

test("aggregateProcessBuckets accepts flat live-shaped events", () => {
  const buckets = helpers.aggregateProcessBuckets([
    { type: "tool.started", toolId: "x", toolName: "grep", args: { pattern: "foo" } },
    { type: "tool.finished", toolId: "x", toolName: "grep", result: [] },
  ]);
  assert.equal(buckets.toolById.size, 1);
  assert.equal(buckets.toolById.get("x").type, "tool.finished");
});

test("textDeltaSummary concatenates and truncates text.delta", () => {
  const summary = helpers.textDeltaSummary(
    [
      { kind: "text.delta", payload: { text: "alpha " } },
      { kind: "tool.started", payload: { toolName: "x" } },
      { kind: "text.delta", payload: { text: "beta" } },
      { kind: "text.final", payload: { text: "!" } },
    ],
    200
  );
  assert.match(summary, /alpha/);
  assert.match(summary, /beta/);
  assert.equal(helpers.isProcessBucketsEmpty(helpers.aggregateProcessBuckets([])), true);
});

test("aggregateProcessBuckets tracks _eventNos for Phase B focus", () => {
  const buckets = helpers.aggregateProcessBuckets([
    {
      eventNo: 3,
      kind: "tool.started",
      payload: { toolId: "t9", toolName: "read", args: { path: "x" } },
    },
    {
      eventNo: 4,
      kind: "tool.finished",
      payload: { toolId: "t9", toolName: "read", result: "ok" },
    },
  ]);
  const tool = buckets.toolById.get("t9");
  assert.deepEqual(tool._eventNos, [3, 4]);
  assert.equal(tool._traceKind, "tool");
  assert.equal(tool._traceId, "t9");
});

test("processAnchorFromEvent maps tool/subagent/command", () => {
  assert.deepEqual(
    helpers.processAnchorFromEvent({
      kind: "tool.started",
      payload: { toolId: "a", toolName: "grep" },
    }),
    { rowKind: "tool", rowId: "a" }
  );
  assert.deepEqual(
    helpers.processAnchorFromEvent({
      kind: "subagent.completed",
      payload: { subagentId: "s2", name: "explore" },
    }),
    { rowKind: "subagent", rowId: "s2" }
  );
  assert.deepEqual(
    helpers.processAnchorFromEvent({
      kind: "command.finished",
      payload: { command: "npm test", exitCode: 0 },
    }),
    { rowKind: "command", rowId: "npm test" }
  );
  assert.equal(
    helpers.processAnchorFromEvent({ kind: "text.delta", payload: { text: "hi" } }),
    null
  );
});

test("stampEventNos fills absolute indexes", () => {
  const stamped = helpers.stampEventNos([{ kind: "a" }, { kind: "b", eventNo: 99 }], 10);
  assert.equal(stamped[0].eventNo, 10);
  assert.equal(stamped[1].eventNo, 99);
});
