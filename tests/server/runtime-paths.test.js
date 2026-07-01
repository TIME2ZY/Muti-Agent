const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const runtimePaths = require("../../src/server/runtime-paths");

test("runtime paths live under data/runtime", () => {
  const root = path.resolve(__dirname, "../..");
  const runtimeDir = path.join(root, "data", "runtime");

  assert.equal(runtimePaths.ROOT, root);
  assert.equal(runtimePaths.RUNTIME_DATA_DIR, runtimeDir);
  assert.equal(runtimePaths.DEFAULT_SESSIONS_FILE, path.join(runtimeDir, "sessions.json"));
  assert.equal(runtimePaths.DEFAULT_INVOCATIONS_FILE, path.join(runtimeDir, "invocations.json"));
  assert.equal(runtimePaths.DEFAULT_SESSION_MAP_ROOT, path.join(runtimeDir, "session-maps"));
  assert.equal(runtimePaths.DEFAULT_TRANSCRIPT_DIR, path.join(runtimeDir, "transcripts"));
  assert.equal(runtimePaths.DEFAULT_WORKTREE_STATE_FILE, path.join(runtimeDir, "worktrees.json"));
});
