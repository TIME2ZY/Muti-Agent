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
    roleDisplayName("assistant", "codex", [{ id: "codex", label: "codex" }]),
    "codex"
  );
  assert.equal(roleDisplayName("system"), "系统");
});

test("roleBadgeLabel covers roles", () => {
  assert.equal(roleBadgeLabel("user"), "发起者");
  assert.equal(roleBadgeLabel("assistant"), "Agent");
  assert.equal(roleBadgeLabel("system"), "系统");
});

test("agent helpers format mention and meta", () => {
  assert.equal(agentLabelFromList([{ id: "grok", label: "grok" }], "grok"), "grok");
  assert.equal(agentMention({ id: "x", label: "X" }), "X");
  assert.match(agentMeta({ providerId: "codex", model: "gpt", reasoningEffort: "high" }), /codex/);
  assert.equal(agentRoleSummary({ description: "a".repeat(40) }).length, 33);
});

test("agentMeta appends capability tags when capabilities are present", () => {
  const meta = agentMeta({
    providerId: "codex",
    model: "gpt-5.6-sol",
    capabilities: { thinking: false, tools: true, subagents: true, resume: true },
  });
  assert.match(meta, /工具/);
  assert.match(meta, /子代理/);
  assert.doesNotMatch(meta, /思考/);
});

test("agentColorIndex is stable for known agents and in 1..6", () => {
  assert.equal(agentColorIndex("codex"), 1);
  assert.equal(agentColorIndex("gemini"), 2);
  assert.equal(agentColorIndex("grok"), 3);
  assert.equal(agentColorIndex("opencode"), 4);
  assert.equal(agentColorIndex("codex"), agentColorIndex("codex"));
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
    getAgents: () => [{ id: "opencode", label: "opencode" }],
  });
  assert.equal(helpers.agentLabel("opencode"), "opencode");
  assert.equal(helpers.roleDisplayName("assistant", "opencode"), "opencode");
});
