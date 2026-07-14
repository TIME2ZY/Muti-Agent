const test = require("node:test");
const assert = require("node:assert/strict");
const {
  upsertAgentProviderSession,
  resolveResumeSessionId,
  providerKeyFromConfig,
} = require("../../src/shared/session-map");

test("providerKeyFromConfig uses providerId:model fingerprint", () => {
  assert.equal(
    providerKeyFromConfig({ providerId: "codex", model: "gpt-5.6-sol" }),
    "codex:gpt-5.6-sol"
  );
  assert.equal(providerKeyFromConfig({ name: "grok" }), "grok");
});

test("shared session-map pure helpers keep workspace slots isolated", () => {
  const sessions = {};
  upsertAgentProviderSession(sessions, "codex", "a", "base:x", "codex:gpt-5.6-sol");
  upsertAgentProviderSession(sessions, "codex", "b", "worktree:y", "codex:gpt-5.6-sol");
  assert.equal(resolveResumeSessionId(sessions, "codex", "base:x", "codex:gpt-5.6-sol"), "a");
  assert.equal(resolveResumeSessionId(sessions, "codex", "worktree:y", "codex:gpt-5.6-sol"), "b");
  assert.equal(resolveResumeSessionId(sessions, "codex", "base:x", "opencode:x"), "");
});
