const assert = require("node:assert/strict");
const test = require("node:test");

const routing = require("../public/agent-routing.js");

const agents = [
  { id: "codex", label: "Codex", mention: "Codex" },
  { id: "gemini", label: "Gemini", mention: "Gemini" },
  { id: "grok", label: "Grok", mention: "Grok" },
  { id: "opencode", label: "OpenCode", mention: "OpenCode" },
];

test("resolvePromptAgent prefers a leading @mention", () => {
  const result = routing.resolvePromptAgent({
    prompt: "@Gemini please brainstorm",
    agents,
    selectedAgent: "codex",
    lastAgent: "grok",
  });
  assert.equal(result.source, "mention");
  assert.equal(result.agent.id, "gemini");
});

test("resolvePromptAgent falls back to session lastAgent without @", () => {
  const result = routing.resolvePromptAgent({
    prompt: "continue the work",
    agents,
    selectedAgent: "codex",
    lastAgent: "grok",
  });
  assert.equal(result.source, "session");
  assert.equal(result.agent.id, "grok");
});

test("resolvePromptAgent uses selectedAgent when session has no lastAgent", () => {
  const result = routing.resolvePromptAgent({
    prompt: "hello",
    agents,
    selectedAgent: "gemini",
    lastAgent: "",
  });
  assert.equal(result.source, "selected");
  assert.equal(result.agent.id, "gemini");
});

test("resolvePromptAgent defaults to codex when nothing else matches", () => {
  const result = routing.resolvePromptAgent({
    prompt: "hello",
    agents,
    selectedAgent: "missing",
    lastAgent: "also-missing",
    defaultAgent: "codex",
  });
  assert.equal(result.source, "default");
  assert.equal(result.agent.id, "codex");
});

test("resolvePromptAgent returns none when the agent list is empty", () => {
  const result = routing.resolvePromptAgent({
    prompt: "hello",
    agents: [],
    selectedAgent: "codex",
    lastAgent: "codex",
  });
  assert.equal(result.source, "none");
  assert.equal(result.agent, null);
});

test("findExplicitLeadingAgent ignores mid-prompt mentions", () => {
  assert.equal(
    routing.findExplicitLeadingAgent("please ask @Gemini later", agents),
    null
  );
});
