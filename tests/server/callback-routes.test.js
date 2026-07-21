const assert = require("node:assert/strict");
const test = require("node:test");

const callbackRoutes = require("../../src/server/callback-routes.js");

function makeReq(method, headers = {}) {
  return { method, headers };
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

test("handleCallbackRoutes posts callback messages after token validation", async () => {
  const res = makeRes();
  let appended = null;
  const handle = callbackRoutes.createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: (sessionId, invocationId, content, options) => {
        appended = { sessionId, invocationId, content, optionsKeys: Object.keys(options) };
        return {
          ok: true,
          messagePosted: true,
          handoff: {
            status: "repair_required",
            detected: true,
            accepted: false,
            repairRequired: true,
            queuedAgents: [],
          },
        };
      },
    },
    transcript: {},
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({
      sessionId: "s1",
      invocationId: "i1",
      callbackToken: "tok",
      content: "hello",
    }),
  });

  const handled = await handle(makeReq("POST"), res, new URL("http://127.0.0.1/api/callbacks/post-message"));
  assert.equal(handled, true);
  assert.deepEqual(appended, {
    sessionId: "s1",
    invocationId: "i1",
    content: "hello",
    optionsKeys: ["appendToSession"],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.messagePosted, true);
  assert.equal(res.body.handoff.status, "repair_required");
});

test("handleCallbackRoutes lists invocations for a session", async () => {
  const res = makeRes();
  const handle = callbackRoutes.createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: () => true,
    },
    transcript: {
      listInvocationsWithMeta: async () => [{ invocationId: "i1" }],
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });

  const handled = await handle(makeReq("GET"), res, new URL("http://127.0.0.1/api/callbacks/list-invocations?sessionId=s1"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { invocations: [{ invocationId: "i1" }] });
});

test("handleCallbackRoutes returns 404 when invocation replay is missing", async () => {
  const res = makeRes();
  const handle = callbackRoutes.createCallbackRoutes({
    callbacks: {
      validateToken: () => true,
      postMessage: () => true,
    },
    transcript: {
      readInvocationPage: async () => ({ total: 0, events: [], from: 0, limit: 200 }),
    },
    appendToSession() {},
    getSession: () => null,
    sendJson: makeSendJson(res),
    readJsonBody: async () => ({}),
  });

  const handled = await handle(
    makeReq("GET"),
    res,
    new URL("http://127.0.0.1/api/callbacks/read-invocation?sessionId=s1&targetInvocationId=missing")
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Invocation not found." });
});
