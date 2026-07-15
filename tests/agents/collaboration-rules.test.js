const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderCollaborationRules,
  buildRosterTable,
} = require("../../src/agents/collaboration-rules");
const { AGENTS } = require("../../src/agents/catalog");

test("renderCollaborationRules includes markers and soft subagent ban", () => {
  const text = renderCollaborationRules("grok");
  assert.match(text, /<!-- Collaboration Rules -->/);
  assert.match(text, /<!-- \/Collaboration Rules -->/);
  assert.match(text, /协作铁律/);
  assert.match(text, /subagent/i);
  assert.match(text, /Task/);
  assert.match(text, /spawn_subagent/);
  assert.match(text, /行首/);
  assert.match(text, /handoff/);
  assert.match(text, /传球三选一/);
});

test("renderCollaborationRules roster lists teammates from catalog", () => {
  const text = renderCollaborationRules("grok", AGENTS);
  assert.match(text, /@Codex/);
  assert.match(text, /@Gemini/);
  assert.match(text, /@OpenCode/);
  assert.match(text, /@Grok/);
  assert.match(text, /禁止 @ 自己/);
  assert.match(text, /Grok/);
});

test("renderCollaborationRules accepts injected fake agents", () => {
  const fake = {
    alpha: { label: "Alpha", description: "First mate" },
    beta: { label: "Beta", description: "Second mate" },
  };
  const text = renderCollaborationRules("alpha", fake);
  assert.match(text, /@Alpha/);
  assert.match(text, /@Beta/);
  assert.match(text, /First mate/);
  assert.match(text, /Second mate/);
  assert.doesNotMatch(text, /@Codex/);
});

test("buildRosterTable handles empty agents", () => {
  assert.match(buildRosterTable({}), /无可用队友/);
  assert.match(buildRosterTable(null), /无可用队友/);
});
