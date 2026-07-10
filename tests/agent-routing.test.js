const assert = require("node:assert/strict");
const test = require("node:test");

const routing = require("../public/agent-routing.js");

const agents = [
  { id: "architect", label: "Architect", mention: "Architect" },
  { id: "planner", label: "Planner", mention: "Planner" },
  { id: "coder", label: "Coder", mention: "Coder" },
];

test("resolvePromptAgent prefers a leading @mention", () => {
  const result = routing.resolvePromptAgent({
    prompt: "@Planner please plan",
    agents,
    selectedAgent: "architect",
    lastAgent: "coder",
  });
  assert.equal(result.source, "mention");
  assert.equal(result.agent.id, "planner");
});

test("resolvePromptAgent falls back to session lastAgent without @", () => {
  const result = routing.resolvePromptAgent({
    prompt: "continue the work",
    agents,
    selectedAgent: "architect",
    lastAgent: "coder",
  });
  assert.equal(result.source, "session");
  assert.equal(result.agent.id, "coder");
});

test("resolvePromptAgent uses selectedAgent when session has no lastAgent", () => {
  const result = routing.resolvePromptAgent({
    prompt: "hello",
    agents,
    selectedAgent: "planner",
    lastAgent: "",
  });
  assert.equal(result.source, "selected");
  assert.equal(result.agent.id, "planner");
});

test("resolvePromptAgent defaults to architect when nothing else matches", () => {
  const result = routing.resolvePromptAgent({
    prompt: "hello",
    agents,
    selectedAgent: "missing",
    lastAgent: "also-missing",
    defaultAgent: "architect",
  });
  assert.equal(result.source, "default");
  assert.equal(result.agent.id, "architect");
});

test("resolvePromptAgent returns none when the agent list is empty", () => {
  const result = routing.resolvePromptAgent({
    prompt: "hello",
    agents: [],
    selectedAgent: "architect",
    lastAgent: "architect",
  });
  assert.equal(result.source, "none");
  assert.equal(result.agent, null);
});

test("findExplicitLeadingAgent ignores mid-prompt mentions", () => {
  assert.equal(
    routing.findExplicitLeadingAgent("please ask @Planner later", agents),
    null
  );
});
