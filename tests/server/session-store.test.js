const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const store = require("../../src/server/session-store");

function withTempFile(fn) {
  return () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-test-"));
    const file = path.join(tmpDir, "sessions.json");
    try {
      fn(file);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test("createSession seeds worktree and projectDir defaults", withTempFile((file) => {
  const session = store.createSession(file);
  assert.equal(session.title, "");
  assert.equal(session.projectDir, "");
  assert.equal(session.worktree, null);
  assert.deepEqual(session.messages, []);
}));

test("setSessionProjectDir persists a session-specific project directory", withTempFile((file) => {
  const session = store.createSession(file);
  const updated = store.setSessionProjectDir(file, session.id, "/tmp/project");

  assert.equal(updated.projectDir, "/tmp/project");
  assert.equal(store.getSession(file, session.id).projectDir, "/tmp/project");
}));

test("appendToSession does not recreate a deleted session when allowCreate is false", withTempFile((file) => {
  const session = store.createSession(file);
  assert.equal(store.deleteSession(file, session.id), true);

  const result = store.appendToSession(file, session.id, {
    role: "assistant",
    content: "late message",
  }, { allowCreate: false });

  assert.equal(result, null);
  assert.equal(store.getSession(file, session.id), null);
}));
