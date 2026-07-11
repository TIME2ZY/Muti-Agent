const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvokeArgsBuilder } = require("../../src/server/invoke-args");

test("invoke argument builder owns request validation but leaves provider options to adapters", () => {
  const builder = createInvokeArgsBuilder({
    agents: { architect: { name: "codex" } },
  });

  assert.deepEqual(builder.buildChatArgs("architect", "hello", "augmented"), [
    "src/agents/invoke-cli.js",
    "--agent",
    "architect",
    "augmented",
  ]);
  assert.throws(
    () => builder.buildInvokeArgs({ agent: "missing", prompt: "hi" }),
    /Unsupported agent/
  );
  assert.throws(
    () => builder.buildInvokeArgs({ agent: "architect", prompt: " " }),
    /Prompt is required/
  );
});
