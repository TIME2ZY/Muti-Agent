const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderCollaborationRules,
  buildRosterTable,
  pickExampleTarget,
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
  assert.match(text, /shell/);
  assert.match(text, /Agent CLI/);
  assert.match(text, /行首/);
  assert.match(text, /handoff/);
  assert.match(text, /传球三选一/);
  assert.match(text, /全员共用|共用模板/);
  assert.match(text, /verdict/);
});

test("renderCollaborationRules example target is never the current agent", () => {
  for (const id of Object.keys(AGENTS)) {
    const text = renderCollaborationRules(id, AGENTS);
    const selfLabel = AGENTS[id].label;
    // Correct-example line-start @ must not be self.
    assert.doesNotMatch(text, new RegExp(`^\\s*@${selfLabel}\\s*$`, "m"));
    // Explicit self-ban still names current agent.
    assert.match(text, new RegExp(`禁止 @ 自己（你是 ${selfLabel}`));
  }
});

test("pickExampleTarget skips current agent", () => {
  const picked = pickExampleTarget("grok", AGENTS);
  assert.notEqual(picked.id, "grok");
  assert.ok(picked.label);
  assert.deepEqual(pickExampleTarget("solo", { solo: { label: "Solo" } }), {
    id: "teammate",
    label: "Teammate",
  });
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
  // Example should use Beta (not Alpha/self).
  assert.match(text, /@Beta/);
  assert.doesNotMatch(text, /^ {4}@Alpha$/m);
});

test("buildRosterTable handles empty agents", () => {
  assert.match(buildRosterTable({}), /无可用队友/);
  assert.match(buildRosterTable(null), /无可用队友/);
});
