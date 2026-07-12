const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");

function createFixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1", title: "Memory work" });
  const window = storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "architect",
    providerKey: "codex:gpt-5.5",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
  return { storage, window };
}

test("repositories persist a complete invocation record", () => {
  const { storage, window } = createFixture();
  try {
    assert.equal(window.state, "active");
    assert.equal(window.generation, 1);
    assert.equal(storage.windows.bindProviderSession("window-1", "provider-session-1"), true);
    assert.equal(storage.windows.addUsage("window-1", { inputChars: 120, outputChars: 80 }), true);

    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "architect",
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 0,
      kind: "run.started",
      payload: { agent: "architect" },
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 1,
      kind: "text.delta",
      payload: { text: "hello" },
    });
    storage.messages.append({
      id: "message-1",
      threadId: "thread-1",
      windowId: "window-1",
      invocationId: "invocation-1",
      sequenceNo: 0,
      role: "assistant",
      agentId: "architect",
      content: "hello",
      metadata: { source: "stream" },
    });

    const finished = storage.invocations.finish("invocation-1", {
      state: "completed",
      exitCode: 0,
    });
    assert.equal(finished.state, "completed");
    assert.equal(storage.invocations.listEvents("invocation-1").length, 2);
    assert.deepEqual(storage.messages.get("message-1").metadata, { source: "stream" });
    const updatedWindow = storage.windows.get("window-1");
    assert.equal(updatedWindow.providerSessionId, "provider-session-1");
    assert.equal(updatedWindow.inputChars, 120);
    assert.equal(updatedWindow.outputChars, 80);
  } finally {
    storage.close();
  }
});

test("message repository preserves an empty assistant result", () => {
  const { storage } = createFixture();
  try {
    const message = storage.messages.append({
      id: "message-empty",
      threadId: "thread-1",
      windowId: "window-1",
      sequenceNo: 0,
      role: "assistant",
      content: "",
    });
    assert.equal(message.content, "");
  } finally {
    storage.close();
  }
});

test("only one open window is allowed per agent provider workspace coordinate", () => {
  const { storage } = createFixture();
  try {
    assert.throws(
      () =>
        storage.windows.create({
          id: "window-2",
          threadId: "thread-1",
          agentId: "architect",
          providerKey: "codex:gpt-5.5",
          workspaceKey: "base:C:/repo",
          generation: 2,
          capacityTokens: 200000,
        }),
      /UNIQUE constraint failed/
    );
  } finally {
    storage.close();
  }
});

test("memory candidates preserve provenance and default to captured", () => {
  const { storage } = createFixture();
  try {
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "architect",
    });
    storage.messages.append({
      id: "message-1",
      threadId: "thread-1",
      windowId: "window-1",
      invocationId: "invocation-1",
      sequenceNo: 0,
      role: "assistant",
      content: "Use SQLite as the durable store.",
    });
    const memory = storage.memories.create({
      id: "memory-1",
      threadId: "thread-1",
      kind: "decision",
      content: "Use SQLite as the durable store.",
      sourceMessageId: "message-1",
      sourceInvocationId: "invocation-1",
      createdBy: "architect",
    });

    assert.equal(memory.status, "captured");
    assert.equal(memory.sourceMessageId, "message-1");
    assert.equal(storage.memories.transition("memory-1", "confirmed"), true);
    assert.equal(storage.memories.get("memory-1").status, "confirmed");
  } finally {
    storage.close();
  }
});

test("deleting a thread cascades through durable memory records", () => {
  const { storage } = createFixture();
  try {
    storage.invocations.start({
      id: "invocation-1",
      threadId: "thread-1",
      windowId: "window-1",
      agentId: "architect",
    });
    storage.invocations.appendEvent({
      invocationId: "invocation-1",
      sequenceNo: 0,
      kind: "run.started",
    });
    storage.memories.create({
      id: "memory-1",
      threadId: "thread-1",
      kind: "lesson",
      content: "Keep raw evidence.",
      sourceInvocationId: "invocation-1",
      createdBy: "architect",
    });

    assert.equal(storage.threads.delete("thread-1"), true);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM context_windows").get().count,
      0
    );
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM invocations").get().count, 0);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM invocation_events").get().count,
      0
    );
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get().count, 0);
  } finally {
    storage.close();
  }
});
