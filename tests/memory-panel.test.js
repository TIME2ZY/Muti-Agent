const assert = require("node:assert/strict");
const test = require("node:test");

const { createMemoryPanel } = require("../public/memory-panel.js");

test("memory panel discards a stale response after switching sessions", async () => {
  let currentSessionId = "s1";
  const pending = new Map();
  const bodyEl = {
    innerHTML: "",
    querySelectorAll() {
      return [];
    },
  };
  const panel = createMemoryPanel({
    bodyEl,
    memoryApi: {
      listMemories(sessionId) {
        return new Promise((resolve) => pending.set(sessionId, resolve));
      },
    },
    getSessionId: () => currentSessionId,
    escHtml: (value) => String(value),
  });

  const first = panel.load();
  currentSessionId = "s2";
  const second = panel.load();
  pending.get("s2")({
    memories: [{ id: "m2", kind: "fact", status: "captured", content: "new session" }],
    counts: { captured: 1 },
  });
  await second;
  pending.get("s1")({
    memories: [{ id: "m1", kind: "fact", status: "captured", content: "old session" }],
    counts: { captured: 1 },
  });
  await first;

  assert.match(bodyEl.innerHTML, /new session/);
  assert.doesNotMatch(bodyEl.innerHTML, /old session/);
});
