const assert = require("node:assert/strict");
const test = require("node:test");

const apiClient = require("../public/api-client.js");

test("readUiToken reads the injected meta value", () => {
  const token = apiClient.readUiToken({
    querySelector(selector) {
      assert.equal(selector, 'meta[name="cat-cafe-ui-token"]');
      return { getAttribute: () => "token-1" };
    },
  });
  assert.equal(token, "token-1");
});

test("createApiFetch adds the UI token without dropping request headers", async () => {
  let captured;
  const request = apiClient.createApiFetch(async (input, init) => {
    captured = { input, init };
    return { ok: true };
  }, "token-2");

  await request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  assert.equal(captured.input, "/api/chat");
  assert.equal(captured.init.headers.get("X-Cat-Cafe-UI-Token"), "token-2");
  assert.equal(captured.init.headers.get("content-type"), "application/json");
});
