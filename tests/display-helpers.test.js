const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  roleDisplayName,
  roleBadgeLabel,
  agentLabelFromList,
  agentMention,
  agentMeta,
  agentRoleSummary,
  agentColorIndex,
  fmtTime,
  createDisplayHelpers,
} = require("../public/display-helpers.js");

test("roleDisplayName maps user and agent", () => {
  assert.equal(roleDisplayName("user"), "用户");
  assert.equal(
    roleDisplayName("assistant", "architect", [{ id: "architect", label: "Architect" }]),
    "Architect"
  );
  assert.equal(roleDisplayName("system"), "系统");
});

test("roleBadgeLabel covers roles", () => {
  assert.equal(roleBadgeLabel("user"), "发起者");
  assert.equal(roleBadgeLabel("assistant"), "Agent");
  assert.equal(roleBadgeLabel("system"), "系统");
});

test("agent helpers format mention and meta", () => {
  assert.equal(agentLabelFromList([{ id: "coder", label: "Coder" }], "coder"), "Coder");
  assert.equal(agentMention({ id: "x", label: "X" }), "X");
  assert.match(agentMeta({ cli: "codex", model: "gpt", reasoningEffort: "high" }), /codex/);
  assert.equal(agentRoleSummary({ description: "a".repeat(40) }).length, 33);
});

test("agentMeta appends capability tags when capabilities are present", () => {
  const meta = agentMeta({
    cli: "codex",
    model: "gpt-5.5",
    capabilities: { thinking: false, tools: true, subagents: true, resume: true },
  });
  assert.match(meta, /工具/);
  assert.match(meta, /子代理/);
  assert.doesNotMatch(meta, /思考/);
});

test("agentColorIndex is stable for known agents and in 1..6", () => {
  assert.equal(agentColorIndex("architect"), 1);
  assert.equal(agentColorIndex("orchestrator"), 2);
  assert.equal(agentColorIndex("grok"), 4);
  assert.equal(agentColorIndex("critic"), 6);
  assert.equal(agentColorIndex("architect"), agentColorIndex("architect"));
  const unknown = agentColorIndex("custom-agent-xyz");
  assert.ok(unknown >= 1 && unknown <= 6);
});

test("fmtTime returns relative labels", () => {
  const now = Date.now();
  assert.equal(fmtTime(new Date(now - 30_000).toISOString(), now), "刚刚");
  assert.equal(fmtTime(new Date(now - 5 * 60_000).toISOString(), now), "5m");
});

test("createDisplayHelpers binds agents list", () => {
  const helpers = createDisplayHelpers({
    getAgents: () => [{ id: "planner", label: "Planner" }],
  });
  assert.equal(helpers.agentLabel("planner"), "Planner");
  assert.equal(helpers.roleDisplayName("assistant", "planner"), "Planner");
});
