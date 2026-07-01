const assert = require("node:assert/strict");
const test = require("node:test");

const worktreeApi = require("../public/worktree-api.js");

function makeResponse(status, body, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
  };
}

test("createWorktreeApi reads worktree status and diff", async () => {
  const calls = [];
  const client = worktreeApi.createWorktreeApi(async (url) => {
    calls.push(url);
    if (url === "/api/sessions/s1/worktree/status") {
      return makeResponse(200, JSON.stringify({ exists: true, branch: "codex/s1" }));
    }
    if (url === "/api/sessions/s1/worktree/diff") {
      return makeResponse(200, JSON.stringify({ sessionId: "s1", diff: "diff --git a/a b/a" }));
    }
    throw new Error(`unexpected url: ${url}`);
  });

  assert.deepEqual(await client.readStatus("s1"), { exists: true, branch: "codex/s1" });
  assert.equal(await client.readDiff("s1"), "diff --git a/a b/a");
  assert.deepEqual(calls, [
    "/api/sessions/s1/worktree/status",
    "/api/sessions/s1/worktree/diff",
  ]);
});

test("createWorktreeApi discards a session worktree", async () => {
  const calls = [];
  const client = worktreeApi.createWorktreeApi(async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/sessions/s1/worktree/discard") {
      return makeResponse(200, JSON.stringify({ discarded: true }));
    }
    throw new Error(`unexpected url: ${url}`);
  });

  assert.deepEqual(await client.discard("s1"), { discarded: true });
  assert.equal(calls[0].options.method, "POST");
});

test("createWorktreeApi surfaces parsed API errors", async () => {
  const client = worktreeApi.createWorktreeApi(async () => (
    makeResponse(400, JSON.stringify({ error: "bad worktree request" }), "Bad Request")
  ));

  await assert.rejects(() => client.readStatus("s1"), /bad worktree request/);
});

test("createWorktreeApi can treat missing worktree status as null", async () => {
  const client = worktreeApi.createWorktreeApi(async () => (
    makeResponse(400, JSON.stringify({ error: "No managed worktree for session s1." }), "Bad Request")
  ));

  assert.equal(await client.readStatus("s1", { allowMissing: true }), null);
});
