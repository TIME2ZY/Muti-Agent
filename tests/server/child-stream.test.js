const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { runChildStream, filterBenignStderr } = require("../../src/server/child-stream");

test("child stream removes abort and response listeners after exit", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const res = new EventEmitter();
  res.write = () => {};
  const controller = new AbortController();

  const completed = runChildStream({
    spawnRunner: () => child,
    args: [],
    res,
    signal: controller.signal,
    onStdout() {},
    onStderr() {},
  });
  assert.equal(res.listenerCount("close"), 1);
  child.emit("close", 0, null);

  assert.deepEqual(await completed, { code: 0, signal: null });
  assert.equal(res.listenerCount("close"), 0);
});

test("stderr filter removes known startup noise only", () => {
  const input = [
    "Reading additional input from stdin...",
    "2026-01-01T00:00:00 WARN codex_core_plugins::manifest: ignoring duplicate",
    "real failure",
  ].join("\n");
  assert.equal(filterBenignStderr(input), "real failure");
});
