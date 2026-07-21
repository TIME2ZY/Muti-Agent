const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyMessageLayer, withMessageLayer } = require("../src/server/message-layers");

test("message layers separate conversation, workflow, and diagnostics", () => {
  assert.equal(classifyMessageLayer({ role: "user" }), "conversation");
  assert.equal(classifyMessageLayer({ role: "assistant" }), "conversation");
  assert.equal(classifyMessageLayer({ role: "system", kind: "a2a-route" }), "workflow");
  assert.equal(classifyMessageLayer({ role: "system", kind: "review-state" }), "workflow");
  assert.equal(classifyMessageLayer({ role: "system", kind: "stderr" }), "diagnostic");
  assert.equal(classifyMessageLayer({ role: "system" }), "system");
});

test("explicit valid message layer is preserved", () => {
  const message = withMessageLayer({ role: "system", kind: "a2a-route", layer: "diagnostic" });
  assert.equal(message.layer, "diagnostic");
});
