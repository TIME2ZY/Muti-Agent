const assert = require("node:assert/strict");
const test = require("node:test");

const sessionRoutes = require("../../src/server/session-routes.js");

function makeReq(method) {
  return { method };
}

function makeRes() {
  return { statusCode: 0, body: null };
}

function makeSendJson(res) {
  return (response, status, value) => {
    assert.equal(response, res);
    res.statusCode = status;
    res.body = value;
  };
}

test("handleSessionRoutes lists sessions", async () => {
  const res = makeRes();
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    sessionsFile: "/tmp/sessions.json",
    worktreeManager: {},
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
    listSessions: () => [{ id: "s1" }],
    createSession: () => { throw new Error("should not create"); },
    getSession: () => null,
    deleteSession: () => false,
    setSessionWorktree: () => null,
    validateProjectDir: () => "/root",
    setSessionProjectDir: () => null,
  });

  const handled = await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/sessions"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { sessions: [{ id: "s1" }] });
});

test("handleSessionRoutes updates projectDir for an existing session", async () => {
  const res = makeRes();
  let setArgs = null;
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    sessionsFile: "/tmp/sessions.json",
    worktreeManager: {},
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({ sessionId: "s1", dir: "/next" }),
    listSessions: () => [],
    createSession: () => null,
    getSession: () => ({ id: "s1", projectDir: "/root" }),
    deleteSession: () => false,
    setSessionWorktree: () => null,
    validateProjectDir: (dir) => `${dir}/validated`,
    setSessionProjectDir: (file, sessionId, dir) => {
      setArgs = { file, sessionId, dir };
      return { id: sessionId, projectDir: dir };
    },
  });

  const handled = await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/project"));
  assert.equal(handled, true);
  assert.deepEqual(setArgs, {
    file: "/tmp/sessions.json",
    sessionId: "s1",
    dir: "/next/validated",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { dir: "/next/validated" });
});

test("handleSessionRoutes discards a worktree and clears the session link", async () => {
  const res = makeRes();
  let cleared = null;
  const handle = sessionRoutes.createSessionRoutes({
    rootDir: "/root",
    sessionsFile: "/tmp/sessions.json",
    worktreeManager: {
      discardWorktree(sessionId) {
        return { ok: true, sessionId };
      },
    },
    cleanupSessionRuntime() {},
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
    listSessions: () => [],
    createSession: () => null,
    getSession: () => ({ id: "s1" }),
    deleteSession: () => false,
    setSessionWorktree: (file, sessionId, value) => {
      cleared = { file, sessionId, value };
      return { id: sessionId, worktree: value };
    },
    validateProjectDir: () => "/root",
    setSessionProjectDir: () => null,
  });

  const handled = await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/sessions/s1/worktree/discard"));
  assert.equal(handled, true);
  assert.deepEqual(cleared, {
    file: "/tmp/sessions.json",
    sessionId: "s1",
    value: null,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, sessionId: "s1" });
});
