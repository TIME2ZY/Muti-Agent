const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createServer } = require("../../src/server");
const { createStorage } = require("../../src/storage");

const UI_TOKEN = "dual-write-test-token";

function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Cat-Cafe-UI-Token", UI_TOKEN);
  if (init.method === "POST") headers.set("content-type", "application/json");
  return fetch(url, { ...init, headers });
}

function successfulSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  process.nextTick(() => {
    child.stdout.write(`${JSON.stringify({ type: "text.delta", text: "hello" })}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function worktreeManager() {
  return {
    getStatus() {
      throw new Error("No managed worktree");
    },
    getDiff() {
      return "";
    },
    discardWorktree() {
      throw new Error("No managed worktree");
    },
    stopAllPreviews() {},
  };
}

test("chat keeps file reads while mirroring durable records into SQLite", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-write-server-"));
  const storage = createStorage({ file: ":memory:" });
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: path.join(tmpDir, "session-maps"),
    storage,
    spawnRunner: successfulSpawn,
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const createdResponse = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    });
    const { session } = await createdResponse.json();

    const chatResponse = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "architect", prompt: "Hi" }),
    });
    await chatResponse.text();

    const fileMessages = await apiFetch(`${baseUrl}/api/messages?sessionId=${session.id}`).then(
      (response) => response.json()
    );
    assert.deepEqual(
      fileMessages.messages.map((message) => message.content),
      ["Hi", "hello"]
    );
    assert.equal(storage.threads.list().length, 1);
    assert.equal(storage.windows.listForThread(session.id).length, 1);
    assert.equal(storage.messages.listForThread(session.id).length, 2);
    assert.equal(storage.invocations.listForThread(session.id).length, 1);
    assert.deepEqual(
      storage.invocations
        .listEvents(storage.invocations.listForThread(session.id)[0].id)
        .map((event) => event.kind),
      ["invocation-start", "text.delta", "invocation-end"]
    );

    const deleteResponse = await apiFetch(`${baseUrl}/api/sessions/${session.id}`, {
      method: "DELETE",
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal(storage.threads.list().length, 0);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM invocation_events").get().count,
      0
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
