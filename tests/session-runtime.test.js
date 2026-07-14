const assert = require("node:assert/strict");
const test = require("node:test");

const { createRuntimeStore } = require("../public/session-runtime.js");

test("runtime store isolates controller and live maps per session", () => {
  const store = createRuntimeStore();
  const a = new AbortController();
  const b = new AbortController();

  store.beginRun("s1", a);
  store.beginRun("s2", b);
  store.getOrCreate("s1").liveMessages.set("codex", { rawText: "one" });
  store.getOrCreate("s2").liveMessages.set("opencode", { rawText: "two" });

  assert.equal(store.get("s1").controller, a);
  assert.equal(store.get("s2").controller, b);
  assert.equal(store.get("s1").liveMessages.get("codex").rawText, "one");
  assert.equal(store.get("s2").liveMessages.has("codex"), false);
  assert.equal(store.getStatus("s1"), "running");
  assert.equal(store.getStatus("s2"), "running");
});

test("beginRun aborts only the previous controller on the same session", () => {
  const store = createRuntimeStore();
  let aborted = 0;
  const first = { abort() { aborted += 1; } };
  const second = { abort() { aborted += 10; } };

  store.beginRun("s1", first);
  store.beginRun("s1", second);
  store.beginRun("s2", { abort() { aborted += 100; } });

  assert.equal(aborted, 1);
  assert.equal(store.get("s1").controller, second);
});

test("switch-away safe: abort does not affect other sessions", () => {
  const store = createRuntimeStore();
  let a = 0;
  let b = 0;
  store.beginRun("s1", { abort() { a += 1; } });
  store.beginRun("s2", { abort() { b += 1; } });

  store.abort("s1");
  assert.equal(a, 1);
  assert.equal(b, 0);
  assert.equal(store.get("s2").status, "running");
});

test("endRun ignores stale controllers from an older run", () => {
  const store = createRuntimeStore();
  const oldController = {};
  const newController = {};
  store.beginRun("s1", oldController);
  store.beginRun("s1", newController);

  store.endRun("s1", { controller: oldController, status: "error" });
  assert.equal(store.get("s1").controller, newController);
  assert.equal(store.get("s1").status, "running");

  store.endRun("s1", { controller: newController, status: "done" });
  assert.equal(store.get("s1").controller, null);
  assert.equal(store.get("s1").status, "done");
});

test("rekey moves runtime identity when a pending session becomes real", () => {
  const store = createRuntimeStore();
  const controller = {};
  store.beginRun("_pending", controller);
  store.getOrCreate("_pending").liveMessages.set("codex", { rawText: "hi" });

  const moved = store.rekey("_pending", "s-real");
  assert.equal(moved.sessionId, "s-real");
  assert.equal(store.get("_pending"), null);
  assert.equal(store.get("s-real").controller, controller);
  assert.equal(store.get("s-real").liveMessages.get("codex").rawText, "hi");
});

test("dispose aborts and removes the runtime", () => {
  const store = createRuntimeStore();
  let aborted = 0;
  store.beginRun("s1", { abort() { aborted += 1; } });
  assert.equal(store.dispose("s1"), true);
  assert.equal(aborted, 1);
  assert.equal(store.get("s1"), null);
});
