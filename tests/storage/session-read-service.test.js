const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createSessionReadService } = require("../../src/storage/session-read-service");

function createFixture() {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({
    id: "thread-1",
    title: "SQLite title",
    projectDir: "C:/repo",
    lastAgentId: "architect",
    createdAt: "2026-07-12T00:00:00.000Z",
  });
  storage.messages.append({
    id: "message-1",
    threadId: "thread-1",
    sequenceNo: 0,
    role: "user",
    agentId: "architect",
    content: "SQLite message",
    metadata: { activeSkills: ["memory"] },
    createdAt: "2026-07-12T00:00:01.000Z",
  });
  const fileSession = {
    id: "thread-1",
    title: "Old file title",
    createdAt: "2026-07-12T00:00:00.000Z",
    messages: [],
    worktree: { branch: "worktree-branch" },
    projectDir: "C:/old",
    lastAgent: "planner",
  };
  const fileOnly = {
    id: "legacy-thread",
    title: "Legacy",
    createdAt: "2026-07-11T00:00:00.000Z",
    messageCount: 2,
    lastAgent: "planner",
  };
  const fileStore = {
    getSession: (_file, id) => (id === "thread-1" ? fileSession : null),
    listSessions: () => [{ ...fileSession, messageCount: 0 }, fileOnly],
  };
  return { storage, fileSession, fileOnly, fileStore };
}

test("sqlite session reads prefer durable messages and preserve file-only runtime metadata", () => {
  const { storage, fileStore } = createFixture();
  try {
    const service = createSessionReadService({ mode: "sqlite", storage, fileStore });
    const session = service.getSession("sessions.json", "thread-1");
    assert.equal(session.title, "SQLite title");
    assert.equal(session.projectDir, "C:/repo");
    assert.equal(session.lastAgent, "architect");
    assert.deepEqual(session.worktree, { branch: "worktree-branch" });
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0].content, "SQLite message");
    assert.deepEqual(session.messages[0].activeSkills, ["memory"]);
  } finally {
    storage.close();
  }
});

test("sqlite session list includes legacy file-only sessions", () => {
  const { storage, fileOnly, fileStore } = createFixture();
  try {
    const service = createSessionReadService({ mode: "sqlite", storage, fileStore });
    const sessions = service.listSessions("sessions.json");
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, "thread-1");
    assert.equal(sessions[0].messageCount, 1);
    assert.equal(sessions[1], fileOnly);
  } finally {
    storage.close();
  }
});

test("files and failed sqlite reads fall back to the file store", () => {
  const { storage, fileSession, fileStore } = createFixture();
  const errors = [];
  try {
    const files = createSessionReadService({ mode: "files", storage, fileStore });
    assert.equal(files.getSession("sessions.json", "thread-1"), fileSession);

    const broken = createSessionReadService({
      mode: "sqlite",
      storage: {
        threads: {
          get: () => {
            throw new Error("busy");
          },
          listWithMessageCounts: () => {
            throw new Error("busy");
          },
        },
      },
      fileStore,
      logger: { error: (message) => errors.push(message) },
    });
    assert.equal(broken.getSession("sessions.json", "thread-1"), fileSession);
    assert.equal(broken.listSessions("sessions.json").length, 2);
    assert.equal(errors.length, 2);
  } finally {
    storage.close();
  }
});
