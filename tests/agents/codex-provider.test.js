const test = require("node:test");
const assert = require("node:assert/strict");

const { buildCodexEnvironment } = require("../../src/agents/providers/codex");

test("Codex child uses the configured isolated home", () => {
  assert.deepEqual(
    buildCodexEnvironment({}, { INVOKE_CODEX_HOME: " C:\\Users\\me\\.codex-cli " }),
    { CODEX_HOME: "C:\\Users\\me\\.codex-cli" }
  );
});

test("Codex child leaves CODEX_HOME unchanged without an override", () => {
  assert.deepEqual(buildCodexEnvironment({}, {}), {});
});
