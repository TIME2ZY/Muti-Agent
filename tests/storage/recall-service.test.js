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
    agentId: "codex",
    providerKey: "codex:gpt-5.6-sol",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: "window-1",
    agentId: "codex",
    startedAt: "2026-07-12T00:00:00.000Z",
  });
  storage.invocations.appendEvent({
    invocationId: "invocation-1",
    sequenceNo: 0,
    kind: "text.delta",
    payload: { text: "sqlite memory" },
    createdAt: "2026-07-12T00:00:01.000Z",
  });
  storage.messages.append({
    id: "message-1",
    threadId: "thread-1",
    windowId: "window-1",
    sequenceNo: 0,
    role: "user",
    content: "sqlite-only user requirement",
    createdAt: "2026-07-12T00:00:00.500Z",
  });
  storage.memories.create({
    id: "memory-1",
    threadId: "thread-1",
    kind: "decision",
    content: "sqlite-only durable decision",
    createdBy: "codex",
    sourceInvocationId: "invocation-1",
    createdAt: "2026-07-12T00:00:02.000Z",
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

test("recall service returns SQLite-only user messages and memory entries", async () => {
  const { storage, service } = createFixture();
  try {
    const messageHits = await service.searchTranscript("thread-1", "user requirement");
    assert.equal(messageHits.length, 1);
    assert.equal(messageHits[0].sourceKind, "message");
    assert.equal(messageHits[0].kind, "message.user");

    const memoryHits = await service.searchTranscript("thread-1", "durable decision");
    assert.equal(memoryHits.length, 1);
    assert.equal(memoryHits[0].sourceKind, "memory-entry");
    assert.equal(memoryHits[0].invocationId, "invocation-1");
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

test("file user-prompt hits suppress duplicate SQLite user messages", async () => {
  const filePrompt = {
    invocationId: "_user_prompt",
    eventNo: 0,
    kind: "user-prompt",
    ts: "2026-07-12T00:00:00.500Z",
    snippet: "sqlite-only user requirement",
  };
  const { storage, service } = createFixture({
    searchTranscript: async () => [filePrompt],
  });
  try {
    const hits = await service.searchTranscript("thread-1", "user requirement");
    assert.deepEqual(hits, [filePrompt]);
  } finally {
    storage.close();
  }
});

test("invocation listing keeps the more complete file record", async () => {
  const fileRecord = {
    invocationId: "invocation-1",
    agent: "codex",
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

test("recall service uses SQLite when transcript reads fail", async () => {
  const errors = [];
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "thread-1" });
  storage.windows.create({
    id: "window-1",
    threadId: "thread-1",
    agentId: "codex",
    providerKey: "codex:gpt-5.6-sol",
    workspaceKey: "base:C:/repo",
    generation: 1,
    capacityTokens: 200000,
  });
  storage.invocations.start({
    id: "invocation-1",
    threadId: "thread-1",
    windowId: "window-1",
    agentId: "codex",
  });
  storage.invocations.appendEvent({
    invocationId: "invocation-1",
    sequenceNo: 0,
    kind: "text.delta",
    payload: { text: "sqlite survives file failure" },
  });
  storage.recall.rebuildThread("thread-1");
  const fail = async () => {
    throw new Error("transcript unavailable");
  };
  const service = createRecallService({
    storage,
    transcript: {
      listInvocationsWithMeta: fail,
      searchTranscript: fail,
      readInvocationPage: fail,
    },
    logger: { error: (message) => errors.push(message) },
  });
  try {
    assert.equal((await service.listInvocationsWithMeta("thread-1")).length, 1);
    assert.equal((await service.searchTranscript("thread-1", "file failure")).length, 1);
    assert.equal((await service.readInvocationPage("thread-1", "invocation-1")).total, 1);
    assert.equal(errors.length, 3);
    assert.ok(errors.every((message) => message.includes("file-recall")));
  } finally {
    storage.close();
  }
});

test("sqlite mode treats SQLite invocation data as primary and files as legacy fallback", async () => {
  const filePrimaryConflict = {
    invocationId: "invocation-1",
    agent: "file-agent",
    startedAt: "2026-07-12T00:00:00.000Z",
    endedAt: "2026-07-12T00:01:00.000Z",
    state: "completed",
    eventCount: 99,
  };
  const legacy = {
    invocationId: "legacy-invocation",
    agent: "opencode",
    startedAt: "2026-07-11T00:00:00.000Z",
    endedAt: null,
    state: null,
    eventCount: 2,
  };
  const { storage } = createFixture();
  const service = createRecallService({
    mode: "sqlite",
    storage,
    transcript: {
      listInvocationsWithMeta: async () => [filePrimaryConflict, legacy],
      searchTranscript: async () => [],
      readInvocationPage: async () => ({
        events: Array.from({ length: 5 }, () => ({ kind: "file" })),
        total: 5,
        from: 0,
        limit: 200,
      }),
    },
  });
  try {
    const listed = await service.listInvocationsWithMeta("thread-1");
    assert.equal(listed.length, 2);
    assert.equal(listed.find((item) => item.invocationId === "invocation-1").agent, "codex");
    assert.ok(listed.some((item) => item.invocationId === "legacy-invocation"));

    const page = await service.readInvocationPage("thread-1", "invocation-1");
    assert.equal(page.total, 1);
    assert.equal(page.events[0].kind, "text.delta");
  } finally {
    storage.close();
  }
});

test("sqlite mode skips transcript search after filling the requested limit", async () => {
  const { storage } = createFixture();
  let fileSearches = 0;
  const service = createRecallService({
    mode: "sqlite",
    storage,
    transcript: {
      listInvocationsWithMeta: async () => [],
      searchTranscript: async () => {
        fileSearches += 1;
        return [];
      },
      readInvocationPage: async () => ({ events: [], total: 0, from: 0, limit: 200 }),
    },
  });
  try {
    const hits = await service.searchTranscript("thread-1", "sqlite memory", { limit: 1 });
    assert.equal(hits.length, 1);
    assert.equal(fileSearches, 0);
  } finally {
    storage.close();
  }
});
