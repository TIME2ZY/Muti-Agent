const test = require("node:test");
const assert = require("node:assert/strict");
const { createInvokeArgsBuilder } = require("../../src/server/invoke-args");

test("invoke argument builder owns request validation but leaves provider options to adapters", () => {
  const builder = createInvokeArgsBuilder({
    agents: { codex: { providerId: "codex" } },
  });

  assert.deepEqual(builder.buildChatArgs("codex", "hello", "augmented"), [
    "src/agents/invoke-cli.js",
    "--agent",
    "codex",
    "augmented",
  ]);
  assert.throws(
    () => builder.buildInvokeArgs({ agent: "missing", prompt: "hi" }),
    /Unsupported agent/
  );
  assert.throws(
    () => builder.buildInvokeArgs({ agent: "codex", prompt: " " }),
    /Prompt is required/
  );
});
