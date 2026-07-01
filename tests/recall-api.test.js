const assert = require("node:assert/strict");
const test = require("node:test");

const recallApi = require("../public/recall-api.js");

function makeResponse(status, body, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
  };
}

test("createRecallApi lists invocations and reads one invocation page", async () => {
  const calls = [];
  const client = recallApi.createRecallApi(async (url) => {
    calls.push(url);
    if (url === "/api/callbacks/list-invocations?sessionId=s1") {
      return makeResponse(200, JSON.stringify({ invocations: [{ invocationId: "i1" }] }));
    }
    if (url === "/api/callbacks/read-invocation?sessionId=s1&targetInvocationId=i1&from=5&limit=50") {
      return makeResponse(200, JSON.stringify({ invocationId: "i1", events: [], total: 9, from: 5, limit: 50 }));
    }
    throw new Error(`unexpected url: ${url}`);
  });

  assert.deepEqual(await client.listInvocations("s1"), [{ invocationId: "i1" }]);
  assert.deepEqual(await client.readInvocation("s1", "i1", { from: 5, limit: 50 }), {
    invocationId: "i1",
    events: [],
    total: 9,
    from: 5,
    limit: 50,
  });
  assert.deepEqual(calls, [
    "/api/callbacks/list-invocations?sessionId=s1",
    "/api/callbacks/read-invocation?sessionId=s1&targetInvocationId=i1&from=5&limit=50",
  ]);
});

test("createRecallApi searches a session transcript", async () => {
  const calls = [];
  const client = recallApi.createRecallApi(async (url) => {
    calls.push(url);
    if (url === "/api/callbacks/session-search?sessionId=s1&query=hello%20world&limit=25") {
      return makeResponse(200, JSON.stringify({ hits: [{ invocationId: "i1" }], query: "hello world", limit: 25 }));
    }
    throw new Error(`unexpected url: ${url}`);
  });

  assert.deepEqual(await client.searchSession("s1", "hello world", { limit: 25 }), [{ invocationId: "i1" }]);
  assert.deepEqual(calls, [
    "/api/callbacks/session-search?sessionId=s1&query=hello%20world&limit=25",
  ]);
});

test("createRecallApi surfaces parsed API errors", async () => {
  const client = recallApi.createRecallApi(async () => (
    makeResponse(404, JSON.stringify({ error: "Invocation not found." }), "Not Found")
  ));

  await assert.rejects(() => client.readInvocation("s1", "missing"), /Invocation not found/);
});
