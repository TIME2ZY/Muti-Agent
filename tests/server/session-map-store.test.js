const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const store = require("../../src/server/session-map-store");

function withTempRoot(fn) {
  return () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-map-store-test-"));
    try {
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "getSessionMapPath nests valid sessions and rejects unsafe IDs",
  withTempRoot((root) => {
    const file = store.getSessionMapPath("session-1", root);
    assert.equal(file, path.join(root, "session-1", "sessions.json"));
    assert.throws(() => store.getSessionMapPath("..", root), /chatSessionId/);
    assert.throws(() => store.getSessionMapPath("a/b:c", root), /chatSessionId/);
  })
);

test(
  "readSessionMap returns {} for missing or invalid files",
  withTempRoot((root) => {
    assert.deepEqual(store.readSessionMap("missing", root), {});

    const file = store.getSessionMapPath("broken", root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken", "utf8");
    assert.deepEqual(store.readSessionMap("broken", root), {});
  })
);

test(
  "deleteSessionMap removes the owning sanitized directory",
  withTempRoot((root) => {
    const file = store.getSessionMapPath("session-1", root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}\n", "utf8");

    store.deleteSessionMap("session-1", root);

    assert.equal(fs.existsSync(path.dirname(file)), false);
  })
);

test("upsertAgentProviderSession keeps base and worktree provider sessions side by side", () => {
  const sessions = {};
  store.upsertAgentProviderSession(sessions, "architect", "th-base", "base:C:\\proj");
  store.upsertAgentProviderSession(
    sessions,
    "architect",
    "th-wt",
    "worktree:C:\\proj.worktrees\\s1"
  );

  assert.equal(sessions.architect.sessionId, "th-wt");
  assert.equal(sessions.architect.workspaceKey, "worktree:C:\\proj.worktrees\\s1");
  assert.equal(sessions.architect.byWorkspace["base:C:\\proj"].sessionId, "th-base");
  assert.equal(
    sessions.architect.byWorkspace["worktree:C:\\proj.worktrees\\s1"].sessionId,
    "th-wt"
  );
});

test("resolveResumeSessionId reads the matching workspace slot", () => {
  const sessions = {};
  store.upsertAgentProviderSession(sessions, "architect", "th-base", "base:C:\\proj");
  store.upsertAgentProviderSession(
    sessions,
    "architect",
    "th-wt",
    "worktree:C:\\proj.worktrees\\s1"
  );

  assert.equal(store.resolveResumeSessionId(sessions, "architect", "base:C:\\proj"), "th-base");
  assert.equal(
    store.resolveResumeSessionId(sessions, "architect", "worktree:C:\\proj.worktrees\\s1"),
    "th-wt"
  );
  assert.equal(store.resolveResumeSessionId(sessions, "architect", "worktree:C:\\other"), "");
});

test("resolveResumeSessionId rejects a session from another provider or model", () => {
  const sessions = {};
  store.upsertAgentProviderSession(
    sessions,
    "architect",
    "th-codex",
    "base:C:\\proj",
    "codex:gpt-5.5"
  );

  assert.equal(
    store.resolveResumeSessionId(sessions, "architect", "base:C:\\proj", "codex:gpt-5.5"),
    "th-codex"
  );
  assert.equal(
    store.resolveResumeSessionId(sessions, "architect", "base:C:\\proj", "grok:grok-4.5"),
    ""
  );
});

test("resolveResumeSessionId keeps legacy single-slot maps working", () => {
  const legacyWithKey = {
    architect: {
      sessionId: "legacy-base",
      workspaceKey: "base:C:\\proj",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  };
  assert.equal(
    store.resolveResumeSessionId(legacyWithKey, "architect", "base:C:\\proj"),
    "legacy-base"
  );
  assert.equal(
    store.resolveResumeSessionId(legacyWithKey, "architect", "worktree:C:\\proj.worktrees\\s1"),
    ""
  );

  const legacyNoKey = {
    architect: {
      sessionId: "legacy-plain",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  };
  assert.equal(
    store.resolveResumeSessionId(legacyNoKey, "architect", "base:C:\\proj"),
    "legacy-plain"
  );
  assert.equal(
    store.resolveResumeSessionId(legacyNoKey, "architect", "worktree:C:\\proj.worktrees\\s1"),
    ""
  );
});

test("upsert migrates a legacy single-slot entry into byWorkspace without losing it", () => {
  const sessions = {
    architect: {
      sessionId: "legacy-base",
      workspaceKey: "base:C:\\proj",
      updatedAt: "2026-07-01T00:00:00.000Z",
    },
  };
  store.upsertAgentProviderSession(
    sessions,
    "architect",
    "th-wt",
    "worktree:C:\\proj.worktrees\\s1"
  );

  assert.equal(sessions.architect.byWorkspace["base:C:\\proj"].sessionId, "legacy-base");
  assert.equal(
    sessions.architect.byWorkspace["worktree:C:\\proj.worktrees\\s1"].sessionId,
    "th-wt"
  );
  assert.equal(store.resolveResumeSessionId(sessions, "architect", "base:C:\\proj"), "legacy-base");
});
