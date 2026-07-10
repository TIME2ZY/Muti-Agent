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

test("getSessionMapPath nests valid sessions and rejects unsafe IDs", withTempRoot((root) => {
  const file = store.getSessionMapPath("session-1", root);
  assert.equal(file, path.join(root, "session-1", "sessions.json"));
  assert.throws(() => store.getSessionMapPath("..", root), /chatSessionId/);
  assert.throws(() => store.getSessionMapPath("a/b:c", root), /chatSessionId/);
}));

test("readSessionMap returns {} for missing or invalid files", withTempRoot((root) => {
  assert.deepEqual(store.readSessionMap("missing", root), {});

  const file = store.getSessionMapPath("broken", root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{broken", "utf8");
  assert.deepEqual(store.readSessionMap("broken", root), {});
}));

test("deleteSessionMap removes the owning sanitized directory", withTempRoot((root) => {
  const file = store.getSessionMapPath("session-1", root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n", "utf8");

  store.deleteSessionMap("session-1", root);

  assert.equal(fs.existsSync(path.dirname(file)), false);
}));
