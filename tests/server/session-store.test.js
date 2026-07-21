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

test(
  "createSession seeds worktree and projectDir defaults",
  withTempFile((file) => {
    const session = store.createSession(file);
    assert.equal(session.title, "");
    assert.equal(session.projectDir, "");
    assert.equal(session.worktree, null);
    assert.equal(session.lastAgent, "");
    assert.deepEqual(session.messages, []);
  })
);

test(
  "appendToSession records lastAgent from user messages",
  withTempFile((file) => {
    const session = store.createSession(file);
    store.appendToSession(file, session.id, {
      role: "user",
      agent: "opencode",
      content: "plan this",
    });
    const listed = store.listSessions(file);
    assert.equal(store.getSession(file, session.id).lastAgent, "opencode");
    assert.equal(listed[0].lastAgent, "opencode");
  })
);

test(
  "setSessionLastAgent updates the session default agent",
  withTempFile((file) => {
    const session = store.createSession(file);
    const updated = store.setSessionLastAgent(file, session.id, "grok");
    assert.equal(updated.lastAgent, "grok");
    assert.equal(store.getSession(file, session.id).lastAgent, "grok");
  })
);

test(
  "session store persists review workflow and classifies message layers",
  withTempFile((file) => {
    const session = store.createSession(file);
    store.setSessionReviewWorkflow(file, session.id, {
      status: "changes_requested",
      round: 1,
    });
    store.appendToSession(file, session.id, {
      role: "system",
      kind: "review-state",
      content: "needs fixes",
    });

    const stored = store.getSession(file, session.id);
    assert.equal(stored.reviewWorkflow.status, "changes_requested");
    assert.equal(stored.messages[0].layer, "workflow");
  })
);

test(
  "session store rejects path and prototype-like IDs",
  withTempFile((file) => {
    for (const id of ["..", "__proto__", "constructor"]) {
      assert.throws(() => store.ensureSession(file, id), /sessionId/);
      assert.equal(store.getSession(file, id), null);
      assert.equal(store.deleteSession(file, id), false);
      assert.equal(store.appendToSession(file, id, { role: "user", content: "x" }), null);
    }
  })
);

test(
  "setSessionProjectDir persists a session-specific project directory",
  withTempFile((file) => {
    const session = store.createSession(file);
    const updated = store.setSessionProjectDir(file, session.id, "/tmp/project");

    assert.equal(updated.projectDir, "/tmp/project");
    assert.equal(store.getSession(file, session.id).projectDir, "/tmp/project");
  })
);

test(
  "appendToSession does not recreate a deleted session when allowCreate is false",
  withTempFile((file) => {
    const session = store.createSession(file);
    assert.equal(store.deleteSession(file, session.id), true);

    const result = store.appendToSession(
      file,
      session.id,
      {
        role: "assistant",
        content: "late message",
      },
      { allowCreate: false }
    );

    assert.equal(result, null);
    assert.equal(store.getSession(file, session.id), null);
  })
);

test(
  "restoreSession recreates a missing compatibility shadow without overwriting existing data",
  withTempFile((file) => {
    const restored = store.restoreSession(file, {
      id: "sqlite-thread",
      title: "Recovered",
      createdAt: "2026-07-12T00:00:00.000Z",
      messages: [{ id: "m1", role: "user", content: "old memory" }],
      projectDir: "C:/repo",
      lastAgent: "codex",
    });
    assert.equal(restored.id, "sqlite-thread");
    assert.equal(store.getSession(file, "sqlite-thread").messages.length, 1);

    const unchanged = store.restoreSession(file, {
      id: "sqlite-thread",
      messages: [],
    });
    assert.equal(unchanged.messages.length, 1);
  })
);

test(
  "writeSessions tolerates overlapping writers from separate processes",
  withTempFile(async (file) => {
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
  })
);
