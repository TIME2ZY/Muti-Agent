const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { persistProviderSession, persistSessionId } = require("../../src/agents/session-persistence");

test("persistProviderSession writes providerKey and workspace slots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-persist-"));
  const file = path.join(dir, "sessions.json");

  persistProviderSession({
    file,
    agentKey: "codex",
    sessionId: "sess-1",
    workspaceKey: "base:C:\\proj",
    providerKey: "codex:gpt-5.6-sol",
  });

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.codex.sessionId, "sess-1");
  assert.equal(saved.codex.providerKey, "codex:gpt-5.6-sol");
  assert.equal(saved.codex.byWorkspace["base:C:\\proj"].sessionId, "sess-1");
});

test("persistSessionId reads INVOKE_* env without server imports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-persist-env-"));
  const file = path.join(dir, "sessions.json");

  persistSessionId(
    { id: "opencode", providerId: "opencode", model: "qwen3.7-plus" },
    "oc-1",
    {
      INVOKE_SESSION_FILE: file,
      INVOKE_WORKSPACE_KEY: "base:ws",
    }
  );

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.opencode.sessionId, "oc-1");
  assert.equal(saved.opencode.providerKey, "opencode:qwen3.7-plus");
  assert.equal(saved.opencode.workspaceKey, "base:ws");
});
