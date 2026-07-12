const test = require("node:test");
const assert = require("node:assert/strict");
const {
  upsertAgentProviderSession,
  resolveResumeSessionId,
  providerKeyFromConfig,
} = require("../../src/shared/session-map");

test("providerKeyFromConfig uses providerId:model fingerprint", () => {
  assert.equal(
    providerKeyFromConfig({ providerId: "codex", model: "gpt-5.5" }),
    "codex:gpt-5.5"
  );
  assert.equal(providerKeyFromConfig({ name: "grok" }), "grok");
});

test("shared session-map pure helpers keep workspace slots isolated", () => {
  const sessions = {};
  upsertAgentProviderSession(sessions, "architect", "a", "base:x", "codex:gpt-5.5");
  upsertAgentProviderSession(sessions, "architect", "b", "worktree:y", "codex:gpt-5.5");
  assert.equal(resolveResumeSessionId(sessions, "architect", "base:x", "codex:gpt-5.5"), "a");
  assert.equal(resolveResumeSessionId(sessions, "architect", "worktree:y", "codex:gpt-5.5"), "b");
  assert.equal(resolveResumeSessionId(sessions, "architect", "base:x", "opencode:x"), "");
});
