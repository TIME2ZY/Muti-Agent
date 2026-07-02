const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const store = require("../../src/server/session-store");

function withTempFile(fn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-test-"));
    const file = path.join(tmpDir, "sessions.json");
    try {
      await fn(file);
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

test("writeSessions tolerates overlapping writers from separate processes", withTempFile(async (file) => {
  const helper = path.join(__dirname, "../../test-support/session-store-write-helper.js");
  const gatePrefix = path.join(path.dirname(file), "write-gate");

  function waitForExit(child) {
    return new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, stderr });
        return;
      }
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    });
  }

  async function waitForFile(target) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(target)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${target}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const slow = spawn(process.execPath, [helper, file, gatePrefix, "slow"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitForFile(`${gatePrefix}.ready`);

  const fast = spawn(process.execPath, [helper, file, gatePrefix, "fast"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(`${gatePrefix}.go`, "go\n", "utf8");
  const fastResult = await waitForExit(fast);
  const slowResult = await waitForExit(slow);

  assert.equal(fastResult.code, 0, fastResult.stderr);
  assert.equal(slowResult.code, 0, slowResult.stderr);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
}));
