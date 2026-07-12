const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { createServer } = require("../../src/server");
const { readSessionMap, writeSessionMap } = require("../../src/server/session-map-store");
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
  const previousTranscriptDir = process.env.CAT_CAFE_TRANSCRIPT_DIR;
  process.env.CAT_CAFE_TRANSCRIPT_DIR = path.join(tmpDir, "transcripts");
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

    fs.rmSync(process.env.CAT_CAFE_TRANSCRIPT_DIR, { recursive: true, force: true });
    const search = await apiFetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${session.id}&query=hello`
    ).then((response) => response.json());
    assert.equal(search.hits.length, 1);
    assert.equal(search.hits[0].kind, "text.delta");

    const userSearch = await apiFetch(
      `${baseUrl}/api/callbacks/session-search?sessionId=${session.id}&query=Hi`
    ).then((response) => response.json());
    const userHit = userSearch.hits.find((hit) => hit.sourceKind === "message");
    assert.ok(userHit);
    assert.equal(userHit.kind, "message.user");

    const invocationId = storage.invocations.listForThread(session.id)[0].id;
    const replay = await apiFetch(
      `${baseUrl}/api/callbacks/read-invocation?sessionId=${session.id}&targetInvocationId=${invocationId}`
    ).then((response) => response.json());
    assert.deepEqual(
      replay.events.map((event) => event.kind),
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
    if (previousTranscriptDir === undefined) delete process.env.CAT_CAFE_TRANSCRIPT_DIR;
    else process.env.CAT_CAFE_TRANSCRIPT_DIR = previousTranscriptDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("chat seals from cumulative window usage and starts the next generation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "window-runtime-server-"));
  const mapRoot = path.join(tmpDir, "session-maps");
  const storage = createStorage({ file: ":memory:" });
  const prompts = [];
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: mapRoot,
    storage,
    spawnRunner(_command, args) {
      prompts.push(args[args.length - 1]);
      return successfulSpawn();
    },
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { session } = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    }).then((response) => response.json());

    await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "architect", prompt: "first" }),
    }).then((response) => response.text());

    const firstWindow = storage.windows.listForThread(session.id)[0];
    const targetChars = Math.floor(firstWindow.capacityTokens * 4 * 0.895);
    const persistedChars = firstWindow.inputChars + firstWindow.outputChars;
    storage.windows.addUsage(firstWindow.id, {
      inputChars: Math.max(0, targetChars - persistedChars),
    });
    writeSessionMap(session.id, mapRoot, {
      architect: {
        sessionId: "provider-session-old",
        workspaceKey: firstWindow.workspaceKey,
        providerKey: firstWindow.providerKey,
      },
    });

    const sealedStream = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "architect", prompt: "second" }),
    }).then((response) => response.text());
    assert.match(sealedStream, /event: sealed/);
    assert.equal(storage.windows.get(firstWindow.id).state, "sealed");
    assert.equal(readSessionMap(session.id, mapRoot).architect, undefined);
    const rotatedWindows = storage.windows.listForThread(session.id);
    assert.equal(rotatedWindows.length, 2);
    assert.equal(rotatedWindows[1].generation, 2);
    assert.equal(rotatedWindows[1].state, "active");
    assert.ok(storage.windows.get(firstWindow.id).outputChars > firstWindow.outputChars);

    await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "architect", prompt: "third" }),
    }).then((response) => response.text());
    const windows = storage.windows.listForThread(session.id);
    assert.equal(windows.length, 2);
    assert.equal(windows[1].generation, 2);
    assert.match(prompts[2], /Generation: 2/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    storage.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("files mode abandons an exhausted provider session", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "files-window-server-"));
  const mapRoot = path.join(tmpDir, "session-maps");
  const previousCapacity = process.env.CAT_CAFE_TEST_CAPACITY;
  process.env.CAT_CAFE_TEST_CAPACITY = "20";
  const server = createServer({
    sessionsFile: path.join(tmpDir, "sessions.json"),
    invocationsFile: path.join(tmpDir, "invocations.json"),
    sessionMapRoot: mapRoot,
    storageMode: "files",
    spawnRunner: successfulSpawn,
    worktreeManager: worktreeManager(),
    uiToken: UI_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { session } = await apiFetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      body: "{}",
    }).then((response) => response.json());
    writeSessionMap(session.id, mapRoot, {
      architect: { sessionId: "provider-session-old" },
    });

    const stream = await apiFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, agent: "architect", prompt: "overflow" }),
    }).then((response) => response.text());
    assert.match(stream, /event: sealed/);
    assert.equal(readSessionMap(session.id, mapRoot).architect, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousCapacity === undefined) delete process.env.CAT_CAFE_TEST_CAPACITY;
    else process.env.CAT_CAFE_TEST_CAPACITY = previousCapacity;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
