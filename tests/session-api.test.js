const assert = require("node:assert/strict");
const test = require("node:test");

const sessionApi = require("../public/session-api.js");

function makeResponse(status, body, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
  };
}

test("createSessionApi lists sessions and reads messages", async () => {
  const calls = [];
  const client = sessionApi.createSessionApi(async (url) => {
    calls.push(url);
    if (url === "/api/sessions") {
      return makeResponse(200, JSON.stringify({ sessions: [{ id: "s1" }] }));
    }
    if (url === "/api/messages?sessionId=s1") {
      return makeResponse(200, JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    }
    throw new Error(`unexpected url: ${url}`);
  });

  assert.deepEqual(await client.listSessions(), [{ id: "s1" }]);
  assert.deepEqual(await client.readMessages("s1"), [{ role: "user", content: "hi" }]);
  assert.deepEqual(calls, ["/api/sessions", "/api/messages?sessionId=s1"]);
});

test("createSessionApi reads and updates session-scoped projectDir", async () => {
  const calls = [];
  const client = sessionApi.createSessionApi(async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/project?sessionId=s1") {
      return makeResponse(200, JSON.stringify({ dir: "/tmp/project" }));
    }
    if (url === "/api/project") {
      return makeResponse(200, JSON.stringify({ dir: "/tmp/next" }));
    }
    throw new Error(`unexpected url: ${url}`);
  });

  assert.equal(await client.readProjectDir("s1"), "/tmp/project");
  assert.equal(await client.updateProjectDir("s1", "/tmp/next"), "/tmp/next");
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].options.body, /"sessionId":"s1"/);
  assert.match(calls[1].options.body, /"dir":"\/tmp\/next"/);
});

test("createSessionApi reads session usage summary", async () => {
  const client = sessionApi.createSessionApi(async (url) => {
    assert.equal(url, "/api/sessions/s1/usage");
    return makeResponse(
      200,
      JSON.stringify({ available: true, session: { totalTokens: 42 }, agents: [] })
    );
  });
  const summary = await client.readUsage("s1");
  assert.equal(summary.session.totalTokens, 42);
});

test("jsonOrThrow surfaces API errors with parsed message", async () => {
  await assert.rejects(
    () =>
      sessionApi.jsonOrThrow(
        makeResponse(400, JSON.stringify({ error: "bad input" }), "Bad Request")
      ),
    /bad input/
  );
});
