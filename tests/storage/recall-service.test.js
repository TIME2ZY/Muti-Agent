const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const { createRecallService } = require("../../src/storage/recall-service");

function createFixture(fileOverrides = {}) {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "architect",
    providerKey: "codex:gpt-5.5",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: "window-1",
    agentId: "architect",
    startedAt: "2026-07-12T00:00:00.000Z",
  });
  storage.invocations.appendEvent({
    invocationId: "invocation-1",
    sequenceNo: 0,
    kind: "text.delta",
    payload: { text: "sqlite memory" },
    createdAt: "2026-07-12T00:00:01.000Z",
  });
  storage.recall.rebuildThread("thread-1");

  const transcript = {
    listInvocationsWithMeta: async () => [],
    searchTranscript: async () => [],
    readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
    ...fileOverrides,
  };
  return { storage, service: createRecallService({ storage, transcript }) };
}

test("recall service serves SQLite invocation metadata and event search", async () => {
  const { storage, service } = createFixture();
  try {
    const invocations = await service.listInvocationsWithMeta("thread-1");
    assert.equal(invocations[0].invocationId, "invocation-1");
    assert.equal(invocations[0].eventCount, 1);
    assert.equal(invocations[0].state, null);

    const hits = await service.searchTranscript("thread-1", "sqlite memory");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].invocationId, "invocation-1");
    assert.equal(hits[0].kind, "text.delta");
  } finally {
    storage.close();
  }
});

test("recall service merges and deduplicates SQLite and file hits", async () => {
  const duplicate = {
    invocationId: "invocation-1",
    eventNo: 0,
    kind: "text.delta",
    ts: "2026-07-12T00:00:01.000Z",
    snippet: "file duplicate",
  };
  const fileOnly = {
    invocationId: "legacy-invocation",
    eventNo: 4,
    kind: "stderr",
    ts: "2026-07-11T00:00:00.000Z",
    snippet: "legacy sqlite memory",
  };
  const { storage, service } = createFixture({
    searchTranscript: async () => [duplicate, fileOnly],
  });
  try {
    const hits = await service.searchTranscript("thread-1", "sqlite memory");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].invocationId, "invocation-1");
    assert.equal(hits[1].invocationId, "legacy-invocation");
  } finally {
    storage.close();
  }
});

test("invocation listing keeps the more complete file record", async () => {
  const fileRecord = {
    invocationId: "invocation-1",
    agent: "architect",
    startedAt: "2026-07-12T00:00:00.000Z",
    endedAt: "2026-07-12T00:01:00.000Z",
    state: "completed",
    eventCount: 5,
  };
  const { storage, service } = createFixture({
    listInvocationsWithMeta: async () => [fileRecord],
  });
  try {
    const result = await service.listInvocationsWithMeta("thread-1");
    assert.equal(result[0], fileRecord);
  } finally {
    storage.close();
  }
});

test("read invocation prefers the more complete source", async () => {
  const fileEvent = { ts: "file", kind: "extra", payload: {} };
  const { storage, service } = createFixture({
    readInvocationPage: async () => ({
      events: [{ ts: "file", kind: "text.delta", payload: {} }, fileEvent],
      total: 2,
      from: 0,
      limit: 200,
    }),
  });
  try {
    const filePreferred = await service.readInvocationPage("thread-1", "invocation-1");
    assert.equal(filePreferred.total, 2);
    assert.equal(filePreferred.events[1], fileEvent);

    const sqliteOnly = createRecallService({
      storage,
      transcript: {
        listInvocationsWithMeta: async () => [],
        searchTranscript: async () => [],
        readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
      },
    });
    const sqlitePreferred = await sqliteOnly.readInvocationPage("thread-1", "invocation-1");
    assert.equal(sqlitePreferred.total, 1);
    assert.equal(sqlitePreferred.events[0].kind, "text.delta");
  } finally {
    storage.close();
  }
});
