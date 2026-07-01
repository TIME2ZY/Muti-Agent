const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const invocationStore = require("../../src/server/invocation-store.js");

test("readInvocationsFile returns persisted invocation records", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-cafe-invocations-"));
  const file = path.join(tempDir, "invocations.json");
  invocationStore.writeInvocationsFile(file, {
    inv1: { invocationId: "inv1", sessionId: "s1", events: [] },
  });

  assert.deepEqual(invocationStore.readInvocationsFile(file), {
    inv1: { invocationId: "inv1", sessionId: "s1", events: [] },
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("recordInvocationEvent and finalizeInvocationEvent append lifecycle events", () => {
  const map = new Map([
    ["inv1", {
      invocationId: "inv1",
      sessionId: "s1",
      agent: "architect",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      state: "active",
      events: [],
    }],
  ]);

  invocationStore.recordInvocationEvent(map, "inv1", "stdout", { text: "hello" });
  const finalized = invocationStore.finalizeInvocationEvent(map, "inv1", 0, null);

  assert.equal(finalized.state, "completed");
  assert.equal(finalized.events[0].kind, "stdout");
  assert.equal(finalized.events[1].kind, "invocation-end");
  assert.deepEqual(finalized.events[1].payload, { code: 0, signal: null });
});

test("list/search/read helpers stay session-scoped", () => {
  const map = new Map([
    ["inv1", {
      invocationId: "inv1",
      sessionId: "s1",
      agent: "architect",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      state: "active",
      events: [
        { ts: "2026-01-01T00:00:01.000Z", kind: "stdout", payload: { text: "alpha result" } },
      ],
    }],
    ["inv2", {
      invocationId: "inv2",
      sessionId: "s2",
      agent: "forge",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      state: "active",
      events: [
        { ts: "2026-01-01T00:00:02.000Z", kind: "stdout", payload: { text: "beta result" } },
      ],
    }],
  ]);

  assert.deepEqual(invocationStore.listInvocationsFromMap(map, "s1").map((entry) => entry.invocationId), ["inv1"]);
  assert.deepEqual(invocationStore.searchInvocationsInMap(map, "s1", "alpha", 20).map((entry) => entry.invocationId), ["inv1"]);
  assert.equal(invocationStore.searchInvocationsInMap(map, "s1", "beta", 20).length, 0);
  assert.deepEqual(invocationStore.readInvocationFromMap(map, "s1", "inv1", 0, 10), {
    invocationId: "inv1",
    agent: "architect",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    state: "active",
    events: [
      { ts: "2026-01-01T00:00:01.000Z", kind: "stdout", payload: { text: "alpha result" } },
    ],
    total: 1,
    from: 0,
    limit: 10,
  });
  assert.equal(invocationStore.readInvocationFromMap(map, "s1", "inv2", 0, 10), null);
});
