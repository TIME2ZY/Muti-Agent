const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const store = require("../../src/server/session-store");

test("buildSessionTitle turns a prompt into a compact conversation topic", () => {
  assert.equal(
    store.buildSessionTitle("我觉得还是把 Agent 的消息也做成消息气泡比较好，你认为呢？"),
    "Agent 的消息也做成消息气泡比较好"
  );
  assert.equal(
    store.buildSessionTitle("请你审查最近改动的 diff，指出风险与可改进处。"),
    "审查最近改动的 diff，指出风险与可改进处"
  );
  assert.equal(store.buildSessionTitle("@Grok   帮我修复登录页面的移动端布局问题"), "修复登录页面的移动端布局问题");
});

test("buildSessionTitle bounds long titles and replaces fenced code", () => {
  const title = store.buildSessionTitle("分析这个非常长而且没有任何标点符号的移动端响应式页面布局实现细节");
  assert.ok(Array.from(title).length <= 24);
  assert.match(title, /…$/);
  assert.equal(store.buildSessionTitle("请检查 ```js\nalert(1)\n``` 是否安全"), "检查 代码片段 是否安全");
});

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
