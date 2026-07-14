const assert = require("node:assert/strict");
const test = require("node:test");

const { createDualWriteRecorder } = require("../../src/storage/dual-write-recorder");
const { createStorage } = require("../../src/storage");

function sessionFixture() {
  return {
    id: "thread-1",
    title: "Dual write",
    projectDir: "C:/repo",
    lastAgent: "codex",
    createdAt: "2026-07-12T00:00:00.000Z",
    messages: [],
  };
}

test("dual-write recorder mirrors thread, window, message, and invocation data", () => {
  const storage = createStorage({ file: ":memory:" });
  const recorder = createDualWriteRecorder({ storage });
  const session = sessionFixture();
  try {
    const window = recorder.ensureWindow({
      session,
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
    });
    session.messages.push({
      id: "message-user",
      role: "user",
      agent: "codex",
      content: "Remember this",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    recorder.mirrorLastMessage(session, { windowId: window.id });

    const run = recorder.startInvocation({
      session,
      invocationId: "invocation-1",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
      resumeSessionId: "provider-session-1",
      startedAt: "2026-07-12T00:00:02.000Z",
    });
    recorder.appendInvocationEvent("invocation-1", "text.delta", { text: "Stored" });
    session.messages.push({
      id: "message-assistant",
      role: "assistant",
      agent: "codex",
      content: "Stored",
      invocationId: "invocation-1",
      createdAt: "2026-07-12T00:00:03.000Z",
    });
    recorder.mirrorLastMessage(session, { invocationId: "invocation-1" });
    recorder.finishInvocation("invocation-1", 0, null);

    assert.equal(run.window.id, window.id);
    assert.equal(storage.threads.get("thread-1").lastAgentId, "codex");
    assert.equal(storage.windows.listForThread("thread-1").length, 1);
    recorder.addWindowUsage(window.id, { inputChars: 100, outputChars: 50 });
    assert.equal(storage.windows.get(window.id).providerSessionId, "provider-session-1");
    assert.equal(storage.windows.get(window.id).inputChars, 100);
    assert.equal(storage.windows.get(window.id).outputChars, 50);
    assert.equal(storage.messages.listForThread("thread-1").length, 2);
    assert.equal(storage.messages.get("message-assistant").windowId, window.id);
    assert.equal(storage.invocations.get("invocation-1").state, "completed");
    assert.deepEqual(
      storage.invocations.listEvents("invocation-1").map((event) => event.kind),
      ["invocation-start", "text.delta", "invocation-end"]
    );
    assert.equal(storage.recall.search("thread-1", "Remember this")[0].sourceKind, "message");
    assert.equal(
      storage.recall.search("thread-1", "Stored", { sourceKinds: ["invocation-event"] }).length,
      1
    );
  } finally {
    recorder.close();
    storage.close();
  }
});

test("dual-write failures are contained and reported", () => {
  const errors = [];
  const storage = {
    threads: {
      upsert() {
        throw new Error("database unavailable");
      },
      delete() {
        throw new Error("database unavailable");
      },
    },
  };
  const recorder = createDualWriteRecorder({
    storage,
    logger: { error: (message) => errors.push(message) },
  });

  assert.equal(recorder.mirrorThread(sessionFixture()), null);
  assert.equal(recorder.deleteThread("thread-1"), null);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /mirror thread failed: database unavailable/);
});

test("deleting a thread suppresses late writes from its active invocation", () => {
  const storage = createStorage({ file: ":memory:" });
  const errors = [];
  const recorder = createDualWriteRecorder({
    storage,
    logger: { error: (message) => errors.push(message) },
  });
  const session = sessionFixture();
  try {
    recorder.startInvocation({
      session,
      invocationId: "invocation-1",
      threadId: session.id,
      agentId: "codex",
      providerKey: "codex:gpt-5.6-sol",
      workspaceKey: "base:C:/repo",
      capacityTokens: 200000,
    });

    assert.equal(recorder.deleteThread(session.id), true);
    assert.equal(
      recorder.appendInvocationEvent("invocation-1", "text.delta", { text: "late" }),
      false
    );
    assert.equal(recorder.finishInvocation("invocation-1", 0, null), null);
    assert.equal(errors.length, 0);
  } finally {
    recorder.close();
    storage.close();
  }
});
