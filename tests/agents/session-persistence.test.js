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
    agentKey: "architect",
    sessionId: "sess-1",
    workspaceKey: "base:C:\\proj",
    providerKey: "codex:gpt-5.5",
  });

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.architect.sessionId, "sess-1");
  assert.equal(saved.architect.providerKey, "codex:gpt-5.5");
  assert.equal(saved.architect.byWorkspace["base:C:\\proj"].sessionId, "sess-1");
});

test("persistSessionId reads INVOKE_* env without server imports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-persist-env-"));
  const file = path.join(dir, "sessions.json");

  persistSessionId(
    { id: "planner", providerId: "opencode", model: "mimo-v2.5-pro" },
    "oc-1",
    {
      INVOKE_SESSION_FILE: file,
      INVOKE_WORKSPACE_KEY: "base:ws",
    }
  );

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.planner.sessionId, "oc-1");
  assert.equal(saved.planner.providerKey, "opencode:mimo-v2.5-pro");
  assert.equal(saved.planner.workspaceKey, "base:ws");
});
